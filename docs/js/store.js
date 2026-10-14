/**
 * store.js — persistent learner state.
 *
 * Everything the learner accumulates lives in one localStorage object so that
 * export is a single serialisation and import is a single swap. The review log
 * is append-only and never trimmed: the analytics views and the forgetting
 * model are both reconstructions of that log, so throwing away old entries
 * would silently degrade them.
 */

const KEY = 'lfn.progress.v1';
const SCHEMA = 1;

const DEFAULTS = {
  theme: 'auto',            // auto | light | dark
  dailyNew: 15,
  dailyMax: 120,
  showLowConfidence: false,
  enabledModules: [],
  taxonomy: 'section',
  desiredRetention: 0.9,
};

function blank() {
  return {
    schema: SCHEMA,
    created: new Date().toISOString(),
    settings: { ...DEFAULTS },
    cards: {},
    log: [],
    daily: {},              // 'YYYY-MM-DD' -> { new: n, reviews: n }
  };
}

let state = null;
const listeners = new Set();

export function loadProgress() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? migrate(JSON.parse(raw)) : blank();
  } catch (err) {
    console.warn('progress unreadable, starting fresh', err);
    state = blank();
  }
  return state;
}

function migrate(obj) {
  if (!obj || typeof obj !== 'object') return blank();
  const base = blank();
  return {
    ...base, ...obj,
    schema: SCHEMA,
    settings: { ...base.settings, ...(obj.settings || {}) },
    cards: obj.cards || {},
    log: Array.isArray(obj.log) ? obj.log : [],
    daily: obj.daily || {},
  };
}

let saveTimer = null;
export function saveProgress(immediate = false) {
  if (!state) return;
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {
      // Quota is the realistic failure here; tell the caller rather than
      // losing the session silently.
      console.error('could not persist progress', err);
      listeners.forEach((fn) => fn({ type: 'error', error: err }));
    }
  };
  clearTimeout(saveTimer);
  if (immediate) write(); else saveTimer = setTimeout(write, 400);
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(type) { listeners.forEach((fn) => fn({ type })); }

/* ------------------------------------------------------------- settings */
export function getSettings() { return loadProgress().settings; }

export function setSetting(key, value) {
  const s = loadProgress();
  s.settings[key] = value;
  saveProgress();
  emit('settings');
  return s.settings;
}

export function toggleModule(id, on) {
  const s = loadProgress();
  const set = new Set(s.settings.enabledModules);
  if (on === undefined) { set.has(id) ? set.delete(id) : set.add(id); }
  else if (on) set.add(id); else set.delete(id);
  s.settings.enabledModules = [...set];
  saveProgress();
  emit('settings');
  return s.settings.enabledModules;
}

/* ---------------------------------------------------------------- cards */
export function getCard(id) { return loadProgress().cards[id] || null; }
export function allCards() { return loadProgress().cards; }

export function putCard(id, card) {
  const s = loadProgress();
  s.cards[id] = card;
  saveProgress();
}

export function todayKey(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
}

export function bumpDaily(kind) {
  const s = loadProgress();
  const k = todayKey();
  s.daily[k] = s.daily[k] || { new: 0, reviews: 0 };
  s.daily[k][kind] = (s.daily[k][kind] || 0) + 1;
  saveProgress();
}

export function todayCounts() {
  return loadProgress().daily[todayKey()] || { new: 0, reviews: 0 };
}

/** Append one review. `card` is the post-scheduling state. */
export function logReview({ q, rating, ms, state: cardState, retr }) {
  const s = loadProgress();
  s.log.push({
    q, t: new Date().toISOString(), rating,
    ms: Math.min(ms | 0, 600000),
    state: cardState,
    ...(typeof retr === 'number' ? { r: Math.round(retr * 1000) / 1000 } : {}),
  });
  saveProgress();
}

export function getLog() { return loadProgress().log; }

/* ------------------------------------------------------- export/import */
export function exportProgress() {
  const s = loadProgress();
  return JSON.stringify({ ...s, exported: new Date().toISOString(),
                          app: 'lfn-learn' }, null, 2);
}

export function downloadProgress() {
  const blob = new Blob([exportProgress()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lfn-learn-progress-${todayKey()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Replace state from an exported file.
 * Returns { ok, error, summary }. Validates before touching live state so a
 * malformed file cannot destroy existing progress.
 */
export function importProgress(json, { merge = false } = {}) {
  let obj;
  try { obj = typeof json === 'string' ? JSON.parse(json) : json; }
  catch { return { ok: false, error: 'That file is not valid JSON.' }; }

  if (!obj || typeof obj !== 'object' || !obj.cards || !Array.isArray(obj.log)) {
    return { ok: false, error: 'That does not look like an LFN Learn export.' };
  }
  if (obj.schema && obj.schema > SCHEMA) {
    return { ok: false, error: `That export is from a newer version (schema ${obj.schema}).` };
  }

  const incoming = migrate(obj);
  if (merge) {
    const cur = loadProgress();
    const seen = new Set(cur.log.map((e) => e.q + e.t));
    cur.log.push(...incoming.log.filter((e) => !seen.has(e.q + e.t)));
    cur.log.sort((a, b) => (a.t < b.t ? -1 : 1));
    for (const [id, card] of Object.entries(incoming.cards)) {
      const mine = cur.cards[id];
      // keep whichever card was reviewed most recently
      if (!mine || (card.lastReview || '') > (mine.lastReview || '')) cur.cards[id] = card;
    }
    for (const [d, v] of Object.entries(incoming.daily || {})) {
      cur.daily[d] = cur.daily[d] || { new: 0, reviews: 0 };
      cur.daily[d].new = Math.max(cur.daily[d].new, v.new || 0);
      cur.daily[d].reviews = Math.max(cur.daily[d].reviews, v.reviews || 0);
    }
    state = cur;
  } else {
    state = incoming;
  }
  saveProgress(true);
  emit('import');
  return {
    ok: true,
    summary: {
      cards: Object.keys(state.cards).length,
      reviews: state.log.length,
      since: state.created,
    },
  };
}

export function resetProgress({ keepSettings = true } = {}) {
  const prev = loadProgress();
  const fresh = blank();
  if (keepSettings) fresh.settings = { ...prev.settings };
  state = fresh;
  saveProgress(true);
  emit('reset');
}

export const _internals = { KEY, SCHEMA, DEFAULTS, blank };

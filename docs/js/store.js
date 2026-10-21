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
    // Learner corrections to the shipped bank. The bank itself is rebuilt
    // from the authoring pipeline, so a fix made here must live separately or
    // it would be lost on the next content update.
    flagged: {},            // qid -> { reason, note, at }
    edits: {},              // qid -> { stem, options, answer, explanation, at }
    suppressed: {},         // qid -> { reason, at }
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
    flagged: obj.flagged || {},
    edits: obj.edits || {},
    suppressed: obj.suppressed || {},
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

/** Replace the whole in-scope list (clear all, and undo of a clear). Only the
 *  scope changes: cards, history, flags and edits are untouched. */
export function setEnabledModules(ids) {
  const s = loadProgress();
  s.settings.enabledModules = [...new Set(ids || [])];
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
  const d = loadProgress().daily[todayKey()] || {};
  return { new: d.new || 0, reviews: d.reviews || 0, bonus: d.bonus || 0 };
}

/**
 * Raise *today's* new-card allowance without changing the standing setting.
 *
 * The daily intake cap is the right default — it is what stops a 3,000-card
 * deck turning into an unmanageable review debt three weeks later. But hitting
 * it silently reads as the app being broken, so the learner needs a visible,
 * one-tap way to keep going today while the long-run setting stays put.
 */
export function grantExtraNew(n = 10) {
  const st = loadProgress();
  const k = todayKey();
  st.daily[k] = st.daily[k] || { new: 0, reviews: 0 };
  st.daily[k].bonus = (st.daily[k].bonus || 0) + Math.max(0, n | 0);
  saveProgress(true);
  emit('settings');
  return st.daily[k].bonus;
}

/**
 * Settings with today's bonus folded into `dailyNew`, which is what the
 * scheduler and the summary should both read.
 */
export function effectiveSettings() {
  const st = loadProgress();
  const bonus = todayCounts().bonus;
  return bonus ? { ...st.settings, dailyNew: st.settings.dailyNew + bonus }
               : st.settings;
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
    for (const key of ['flagged', 'edits', 'suppressed']) {
      for (const [id, v] of Object.entries(incoming[key] || {})) {
        const mine = cur[key][id];
        if (!mine || (v.at || '') > (mine.at || '')) cur[key][id] = v;
      }
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

/* ------------------------------------------------- question corrections */

export function flagQuestion(id, reason = 'unclear', note = '') {
  const s = loadProgress();
  s.flagged[id] = { reason, note: String(note || '').slice(0, 500),
                    at: new Date().toISOString() };
  saveProgress(true);
  emit('review');
  return s.flagged[id];
}

export function unflagQuestion(id) {
  const s = loadProgress();
  delete s.flagged[id];
  saveProgress(true);
  emit('review');
}

export function isFlagged(id) { return !!loadProgress().flagged[id]; }
export function getFlagged() { return loadProgress().flagged; }

/** Save an edited version of a question. Pass null to revert to shipped text. */
export function saveEdit(id, patch) {
  const s = loadProgress();
  if (!patch) delete s.edits[id];
  else s.edits[id] = { ...patch, at: new Date().toISOString() };
  saveProgress(true);
  emit('review');
}

export function getEdits() { return loadProgress().edits; }

/**
 * Hide a question from study without destroying it. Deleting outright would
 * be irreversible across a content rebuild, and a question that reads wrong
 * today may simply need fixing — so this is a suppression the learner can undo.
 */
export function suppressQuestion(id, reason = '') {
  const s = loadProgress();
  s.suppressed[id] = { reason, at: new Date().toISOString() };
  delete s.flagged[id];
  saveProgress(true);
  emit('review');
}

export function restoreQuestion(id) {
  const s = loadProgress();
  delete s.suppressed[id];
  saveProgress(true);
  emit('review');
}

export function getSuppressed() { return loadProgress().suppressed; }

export function reviewCounts() {
  const s = loadProgress();
  return {
    flagged: Object.keys(s.flagged).length,
    edited: Object.keys(s.edits).length,
    suppressed: Object.keys(s.suppressed).length,
  };
}

export const _internals = { KEY, SCHEMA, DEFAULTS, blank };

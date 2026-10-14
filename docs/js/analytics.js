/**
 * analytics.js — the dashboard.
 *
 * Eight panels, one question each:
 *
 *   1 headline      where am I overall?
 *   2 heatmap       have I actually been showing up?            (interaction)
 *   3 retention     is the material sticking, week over week?
 *   4 trajectory    what will I still know — and what does a   (the point)
 *                   successful review actually buy me?
 *   5 workload      is a cliff forming?
 *   6 coverage      how much of the document have I touched?    (scope)
 *   7 connections   where do my failures cluster, and what do   (connections)
 *                   those clusters share?
 *   8 leaderboard   which exact cards are fighting me?
 *
 * Interfaces: `mountAnalytics(root, deps, route)` per DATA_CONTRACT section 6.
 * Read-only: nothing here writes to the store. The one piece of state it does
 * persist is the coverage taxonomy, and only because `store.setSetting` is the
 * documented way to remember a tab choice — it is guarded behind an explicit
 * user click, never written on render.
 *
 * Charts are hand-rolled inline SVG. No library, no CDN, no build step, works
 * from file://. Three things that fall out of that choice and drive the code:
 *
 *  - **The viewBox is measured, not fixed.** A 600-unit viewBox scaled into a
 *    348px phone column shrinks a 12px axis label to 7px. So every chart is
 *    built at the container's real pixel width (scale ≈ 1) and the dashboard
 *    re-renders when that width changes by more than a tolerance. This is the
 *    only way hand-rolled SVG type stays legible on a phone.
 *  - **No colour literals.** Every fill and stroke comes from a class defined
 *    in analytics.css against a token, so light/dark flips for free.
 *  - **`outline`, never `box-shadow`, for focus** on anything that carries its
 *    own box-shadow (app.css's `:focus-visible { box-shadow: var(--focus) }`
 *    would be silently overridden — see the note in analytics.css).
 *
 * Every panel renders something for an empty log. A brand-new learner is the
 * common case, not the edge case, and a dashboard full of broken axes and NaN
 * is the worst possible first impression of a study tool.
 */

/* Navigation here is plain `href="#/..."` on real anchors rather than
 * `navigate()` on click handlers: the router is hash-based, so an anchor
 * already does the right thing, and it stays keyboard-reachable, focusable,
 * middle-clickable and copyable for free. Hence no router import. */
import { el, mount, toast, pct, plural, humanDays, relTime, dayKey } from './ui.js';

const DAY = 86400000;
const SVGNS = 'http://www.w3.org/2000/svg';

/* Maturity buckets. Mirrors srs `_model.MATURE_DAYS` when it is available so
 * the dashboard and the scheduler never disagree about "mature". */
const DEFAULT_MATURE_DAYS = 21;

const HORIZONS = [
  { d: 7, label: '7d' },
  { d: 30, label: '30d' },
  { d: 90, label: '90d' },
  { d: 365, label: '1y' },
];

const HEATMAP_WEEKS = 26;
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Cards sampled for the two trajectory curves. Both are means over the
 * collection; above this many cards a deterministic stride gives the same
 * number to two decimal places for a fraction of the work, and keeps the
 * 365-day horizon interactive. */
const TRAJECTORY_SAMPLE_CAP = 1200;

/* ========================================================================
   numeric guards

   Everything downstream of the store is treated as hostile: an imported
   progress file, a half-written localStorage record, a card from a future
   schema. A NaN that reaches an SVG path attribute does not throw — it
   silently renders nothing, which is the worst failure mode available. So
   coordinates go through `n()` on the way out.
   ======================================================================== */

const isNum = (x) => typeof x === 'number' && isFinite(x);
const n = (x, fb = 0) => (isNum(x) ? x : fb);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** Safe divide. The whole file's defence against an empty collection. */
const div = (a, b, fb = 0) => (isNum(a) && isNum(b) && b !== 0 ? a / b : fb);
const r1 = (x) => Math.round(n(x) * 10) / 10;
const r2 = (x) => Math.round(n(x) * 100) / 100;

function parseMs(t) {
  if (!t) return NaN;
  const v = Date.parse(t);
  return isFinite(v) ? v : NaN;
}

/** Local midnight for a timestamp, so day buckets match store.todayKey. */
function startOfDay(msVal) {
  const d = new Date(n(msVal, Date.now()));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtMs(msVal) {
  if (!isNum(msVal) || msVal <= 0) return '—';
  if (msVal < 1000) return `${Math.round(msVal)}ms`;
  if (msVal < 60000) return `${(msVal / 1000).toFixed(msVal < 10000 ? 1 : 0)}s`;
  const m = Math.floor(msVal / 60000);
  return `${m}m ${Math.round((msVal % 60000) / 1000)}s`;
}

function fmtDay(msVal) {
  const d = new Date(n(msVal, Date.now()));
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} `
    + `${d.getDate()} ${MONTH[d.getMonth()]}`;
}

/* ========================================================================
   SVG helpers
   ======================================================================== */

/** sv('rect.hm-cell', {x, y}) — same shorthand as ui.el, SVG namespace. */
function sv(spec, props = {}, children = []) {
  const m = /^([a-zA-Z]+)?((?:\.[\w-]+)*)$/.exec(spec) || [];
  const node = document.createElementNS(SVGNS, m[1] || 'g');
  const classes = (m[2] || '').split('.').filter(Boolean);
  if (classes.length) node.setAttribute('class', classes.join(' '));
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') { node.textContent = String(v); continue; }
    if (k === 'class') {
      node.setAttribute('class', `${node.getAttribute('class') || ''} ${v}`.trim());
      continue;
    }
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
      continue;
    }
    node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * A responsive chart root.
 *
 * `width`/`height` are real pixels, and the viewBox matches them 1:1, so text
 * inside renders at the size it says. `width="100%"` lets it shrink gracefully
 * between re-renders; `preserveAspectRatio` keeps it undistorted while it does.
 */
function chart(width, height, label, cls = '') {
  const w = Math.max(200, Math.round(n(width, 320)));
  const h = Math.max(80, Math.round(n(height, 180)));
  return sv(`svg.an-svg${cls ? `.${cls}` : ''}`, {
    viewBox: `0 0 ${w} ${h}`,
    width: '100%',
    height: h,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': label || 'chart',
    focusable: 'false',
  });
}

function titled(node, text) {
  node.append(sv('title', { text }));
  return node;
}

/** "M x y L x y …" from [[x,y]], NaN-proof. */
function path(points) {
  const pts = (points || []).filter((p) => p && isNum(p[0]) && isNum(p[1]));
  if (!pts.length) return '';
  return pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p[0])} ${r1(p[1])}`).join(' ');
}

/** Same points closed down to a baseline, for a soft area fill under a line. */
function areaPath(points, baseY) {
  const pts = (points || []).filter((p) => p && isNum(p[0]) && isNum(p[1]));
  if (pts.length < 2) return '';
  return `${path(pts)} L${r1(pts[pts.length - 1][0])} ${r1(baseY)} `
    + `L${r1(pts[0][0])} ${r1(baseY)} Z`;
}

/* ========================================================================
   pure data shaping

   These are the testable core. They take plain arrays and objects, touch no
   DOM, and are re-exported on `_analytics` so a node script can assert their
   output against synthetic logs.
   ======================================================================== */

/** Cards that have actually been graded at least once. */
function seenCards(cards) {
  const out = [];
  for (const [id, c] of Object.entries(cards || {})) {
    if (!c || typeof c !== 'object') continue;
    if (c.state === 'new' || !isNum(c.stability) || !c.lastReview) continue;
    out.push({ id, ...c });
  }
  return out;
}

/** Deterministic stride subsample — same input, same output, every render. */
function strided(list, cap) {
  if (!Array.isArray(list) || list.length <= cap || cap <= 0) return list || [];
  const step = list.length / cap;
  const out = [];
  for (let i = 0; i < cap; i += 1) out.push(list[Math.floor(i * step)]);
  return out;
}

function maturity(card, matureDays) {
  if (!card || card.state === 'new' || !isNum(card.stability)) return 'new';
  if (card.state === 'learning' || card.state === 'relearning') return 'learning';
  return card.stability >= matureDays ? 'mature' : 'young';
}

/**
 * Reviews per local day, plus the derived numbers the headline row needs.
 * One pass over the log: it is the single biggest structure here and the log is
 * never truncated, so everything that can share a pass does.
 */
export function logStats(log, now = Date.now()) {
  const byDay = new Map();
  let total = 0;
  let msSum = 0;
  let msCount = 0;
  let graded30 = 0;
  let passed30 = 0;
  let first = Infinity;
  let last = -Infinity;
  const cutoff30 = n(now) - 30 * DAY;

  for (const e of Array.isArray(log) ? log : []) {
    if (!e || typeof e !== 'object') continue;
    const t = parseMs(e.t);
    if (!isFinite(t)) continue;
    total += 1;
    if (t < first) first = t;
    if (t > last) last = t;
    const k = dayKey(new Date(t));
    byDay.set(k, (byDay.get(k) || 0) + 1);
    if (isNum(e.ms) && e.ms > 0 && e.ms < 600000) { msSum += e.ms; msCount += 1; }
    if (isNum(e.rating) && t >= cutoff30 && t <= n(now) + DAY) {
      graded30 += 1;
      if (e.rating >= 3) passed30 += 1;
    }
  }

  return {
    byDay,
    total,
    avgMs: div(msSum, msCount, 0),
    retention30: graded30 > 0 ? div(passed30, graded30, 0) : null,
    graded30,
    first: isFinite(first) ? first : null,
    last: isFinite(last) ? last : null,
    activeDays: byDay.size,
    streak: streakFrom(byDay, now),
    bestStreak: bestStreakFrom(byDay),
  };
}

/**
 * Consecutive days with at least one review, ending today or yesterday.
 *
 * Yesterday counts: a learner who studied last night and opens the app at 7am
 * has not broken anything, and telling them their streak is zero is both wrong
 * and demoralising.
 */
export function streakFrom(byDay, now = Date.now()) {
  if (!byDay || !byDay.size) return 0;
  const today = startOfDay(now);
  let anchor = null;
  if (byDay.get(dayKey(new Date(today)))) anchor = today;
  else if (byDay.get(dayKey(new Date(today - DAY)))) anchor = today - DAY;
  if (anchor === null) return 0;
  let streak = 0;
  for (let d = anchor; ; d -= DAY) {
    if (!byDay.get(dayKey(new Date(d)))) break;
    streak += 1;
    if (streak > 3650) break;
  }
  return streak;
}

export function bestStreakFrom(byDay) {
  if (!byDay || !byDay.size) return 0;
  const days = [...byDay.keys()].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of days) {
    const t = startOfDay(Date.parse(`${k}T00:00:00`));
    if (!isFinite(t)) continue;
    run = prev !== null && Math.round((t - prev) / DAY) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  }
  return best;
}

/**
 * The calendar grid. Columns are weeks, rows are weekdays, newest column last,
 * ending on the week containing today.
 */
export function heatmapGrid(byDay, weeks = HEATMAP_WEEKS, now = Date.now()) {
  const w = Math.max(1, Math.floor(n(weeks, HEATMAP_WEEKS)));
  const today = startOfDay(now);
  // Walk back to the Sunday of the first column.
  const start = today - (new Date(today).getDay() + (w - 1) * 7) * DAY;
  const cols = [];
  let max = 0;
  let total = 0;
  for (let c = 0; c < w; c += 1) {
    const col = [];
    for (let r = 0; r < 7; r += 1) {
      const t = startOfDay(start + (c * 7 + r) * DAY);
      const future = t > today;
      const count = future ? 0 : n((byDay && byDay.get(dayKey(new Date(t)))) || 0);
      if (count > max) max = count;
      total += count;
      col.push({ t, count, future, key: dayKey(new Date(t)) });
    }
    cols.push(col);
  }
  return { cols, max, total, weeks: w, start, end: today };
}

/** 0..4 bucket for a count, so the colour ramp is stable across renders. */
export function heatLevel(count, max) {
  const c = n(count);
  if (c <= 0) return 0;
  const m = Math.max(1, n(max, 1));
  const q = div(c, m, 0);
  if (q <= 0.25) return 1;
  if (q <= 0.5) return 2;
  if (q <= 0.75) return 3;
  return 4;
}

/**
 * Weekly accuracy — the share of graded reviews that scored Good or better.
 *
 * Measured, not predicted: this is the honest counterweight to the model's own
 * forgetting curve. If this sits well under the target retention line, the
 * model is wrong about this learner and the target (or the daily-new rate) is
 * what needs to move.
 */
export function retentionWeekly(log, weeks = 13, now = Date.now()) {
  const w = Math.max(2, Math.floor(n(weeks, 13)));
  const today = startOfDay(now);
  const thisWeekStart = today - new Date(today).getDay() * DAY;
  const buckets = [];
  const index = new Map();
  for (let i = w - 1; i >= 0; i -= 1) {
    const start = thisWeekStart - i * 7 * DAY;
    const b = { start, graded: 0, passed: 0, rate: null };
    index.set(start, b);
    buckets.push(b);
  }
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || !isNum(e.rating)) continue;
    const t = parseMs(e.t);
    if (!isFinite(t)) continue;
    const d = startOfDay(t);
    const start = d - new Date(d).getDay() * DAY;
    const b = index.get(start);
    if (!b) continue;
    b.graded += 1;
    if (e.rating >= 3) b.passed += 1;
  }
  for (const b of buckets) if (b.graded > 0) b.rate = div(b.passed, b.graded, 0);
  return buckets;
}

/** Linear interpolation into a [{d, r}] curve with evenly spaced `d`. */
export function sampleCurve(curve, x) {
  if (!Array.isArray(curve) || !curve.length) return 1;
  const last = curve.length - 1;
  const lo = n(curve[0].d, 0);
  const hi = n(curve[last].d, 0);
  if (!(hi > lo)) return clamp(n(curve[last].r, 1), 0, 1);
  const q = n(x, 0);
  if (q <= lo) return clamp(n(curve[0].r, 1), 0, 1);
  if (q >= hi) return clamp(n(curve[last].r, 1), 0, 1);
  const f = (div(q - lo, hi - lo, 0)) * last;
  const i = clamp(Math.floor(f), 0, last - 1);
  const t = f - i;
  const a = clamp(n(curve[i].r, 1), 0, 1);
  const b = clamp(n(curve[i + 1].r, 1), 0, 1);
  return clamp(a + (b - a) * t, 0, 1);
}

function elapsedDays(card, now) {
  const t = parseMs(card && card.lastReview);
  if (!isFinite(t)) return 0;
  return Math.max(0, div(n(now) - t, DAY, 0));
}

/**
 * "If I stopped today" — mean predicted recall across the collection over the
 * next `days`, built from `srs.forgettingCurve` per card.
 *
 * Each card is already partway down its own curve, so the curve is requested
 * over `elapsed + days` and read at `elapsed + d`. That keeps the maths in
 * srs.js (one forgetting model, not two) and makes this function a pure
 * reshaping of its output.
 */
export function aggregateDecay(srs, cards, days = 30, now = Date.now(), samples = 60) {
  const list = strided(seenCards(cards), TRAJECTORY_SAMPLE_CAP);
  const horizon = Math.max(1, n(days, 30));
  const steps = clamp(Math.floor(n(samples, 60)), 8, 240);
  if (!list.length || typeof srs?.forgettingCurve !== 'function') return [];
  const sums = new Array(steps + 1).fill(0);
  for (const card of list) {
    const e = elapsedDays(card, now);
    const span = e + horizon;
    const curve = srs.forgettingCurve(card, span, clamp(Math.ceil(span), 60, 400));
    for (let i = 0; i <= steps; i += 1) {
      sums[i] += sampleCurve(curve, e + (horizon * i) / steps);
    }
  }
  return sums.map((s, i) => ({
    d: r2((horizon * i) / steps),
    r: clamp(div(s, list.length, 0), 0, 1),
  }));
}

/**
 * "If I keep reviewing" — the learning half of the story.
 *
 * Replays the scheduler forward: every card that falls due inside the horizon
 * is graded Good on its due date and its stability recomputed, so recall is
 * pulled back up each time. `srs.schedule` is pure and deterministically
 * fuzzed, so this is reproducible rather than a simulation that wobbles
 * between renders.
 *
 * Together with `aggregateDecay` this is the whole panel: the gap between the
 * two lines is exactly what the learner's next few weeks of reviews buy them.
 */
export function aggregateWithReviews(srs, cards, days = 30, now = Date.now(),
                                     opts = {}, samples = 60) {
  const list = strided(seenCards(cards), TRAJECTORY_SAMPLE_CAP);
  const horizon = Math.max(1, n(days, 30));
  const steps = clamp(Math.floor(n(samples, 60)), 8, 120);
  if (!list.length || typeof srs?.schedule !== 'function'
      || typeof srs?.retrievability !== 'function') return [];

  const nowMs = n(now, Date.now());
  const sims = list.map((c) => ({ ...c }));
  const out = [];
  let reviews = 0;

  for (let i = 0; i <= steps; i += 1) {
    const d = (horizon * i) / steps;
    const t = nowMs + d * DAY;
    let sum = 0;
    for (const c of sims) {
      let guard = 0;
      // A card can come due several times inside one sample step on a long
      // horizon; the guard stops a pathological 1-minute interval from
      // spinning here.
      for (;;) {
        const dueMs = parseMs(c.due);
        if (!isFinite(dueMs) || dueMs > t || guard >= 64) break;
        const at = Math.max(dueMs, nowMs);
        try {
          Object.assign(c, srs.schedule(c, 3, at, opts));
        } catch { break; }
        reviews += 1;
        guard += 1;
      }
      sum += clamp(n(srs.retrievability(c, t), 1), 0, 1);
    }
    out.push({ d: r2(d), r: clamp(div(sum, sims.length, 0), 0, 1) });
  }
  out.reviews = reviews;
  out.sampled = list.length;
  return out;
}

/**
 * The illustrative single-card ladder: what one more successful review is
 * worth.
 *
 * A fresh card is graded Good repeatedly, each time on the day the scheduler
 * asked for it, and the forgetting curve after each review is kept. The curves
 * fan out — that flattening *is* the learning, and it is the one thing a
 * learner cannot see from a due count.
 */
export function learningLadder(srs, steps = 5, opts = {}) {
  if (typeof srs?.initCard !== 'function' || typeof srs?.schedule !== 'function') return [];
  const k = clamp(Math.floor(n(steps, 5)), 1, 8);
  const out = [];
  let card = srs.initCard();
  let t = Date.parse('2026-01-01T09:00:00Z');
  if (!isFinite(t)) t = Date.now();
  for (let i = 0; i < k; i += 1) {
    let next;
    try { next = srs.schedule(card, 3, t, opts); } catch { break; }
    if (!next || !isNum(next.stability)) break;
    const interval = Math.max(0, div(parseMs(next.due) - t, DAY, 0));
    out.push({ rep: i + 1, stability: next.stability, interval, card: next });
    card = next;
    t += Math.max(1 / 1440, interval) * DAY;
  }
  // Learning-step reps (sub-day intervals) are real but all sit on top of each
  // other at this scale; keep the first and then only reps that actually moved.
  return out.filter((s, i) => i === 0 || s.stability > out[i - 1].stability * 1.05);
}

/** Coverage per module for one taxonomy, bucketed by maturity. */
export function coverageFor(taxonomy, cards, matureDays = DEFAULT_MATURE_DAYS) {
  const mods = (taxonomy && Array.isArray(taxonomy.modules)) ? taxonomy.modules : [];
  const map = cards && typeof cards === 'object' ? cards : {};
  return mods.map((m) => {
    const ids = Array.isArray(m.question_ids) ? m.question_ids : [];
    const total = Math.max(ids.length, n(m.question_count, ids.length));
    const b = { new: 0, learning: 0, young: 0, mature: 0 };
    for (const id of ids) {
      const c = map[id];
      b[maturity(c, matureDays)] += 1;
    }
    b.new = Math.max(0, total - b.learning - b.young - b.mature);
    const seen = b.learning + b.young + b.mature;
    return {
      id: m.id,
      label: m.label || m.id,
      group: m.group || m.label || '—',
      subtitle: m.subtitle || '',
      total,
      seen,
      buckets: b,
      ratio: div(seen, total, 0),
      matureRatio: div(b.mature, total, 0),
    };
  });
}

/**
 * Weak spots, grouped by the thing they are actually about.
 *
 * `source.number` is the natural grouping — one guideline or one drug — because
 * that is the unit the learner would go and re-read. Score is lapses first,
 * with mean retrievability as the tiebreaker, so "I keep failing this" ranks
 * above "I have not seen this in a while".
 *
 * The second half is the part that earns the panel's name: a tag or module that
 * appears across *several* weak clusters is a thread, and naming it turns three
 * separate failures into one thing to go and learn.
 */
export function weakClusters(questions, cards, srs, now = Date.now(), limit = 10) {
  const qs = Array.isArray(questions) ? questions : [];
  const map = cards && typeof cards === 'object' ? cards : {};
  const groups = new Map();

  for (const q of qs) {
    if (!q || !q.id || !q.source) continue;
    const key = q.source.number || q.source.title || '—';
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        number: q.source.number || '',
        title: q.source.title || key,
        page: n(q.source.page, 0),
        total: 0, seen: 0, lapses: 0, rSum: 0, sSum: 0,
        tags: new Map(), modules: new Map(), ids: [],
      };
      groups.set(key, g);
    }
    g.total += 1;
    g.ids.push(q.id);
    const c = map[q.id];
    const graded = c && c.state !== 'new' && isNum(c.stability) && c.lastReview;
    if (graded) {
      g.seen += 1;
      g.lapses += Math.max(0, n(c.lapses, 0));
      g.sSum += n(c.stability, 0);
      let r = 1;
      try {
        if (typeof srs?.retrievability === 'function') r = n(srs.retrievability(c, now), 1);
      } catch { r = 1; }
      g.rSum += clamp(r, 0, 1);
      // Only tags on cards the learner has actually met describe their
      // weakness; counting untouched questions' tags would just describe the
      // deck.
      for (const t of Array.isArray(q.tags) ? q.tags : []) {
        g.tags.set(t, (g.tags.get(t) || 0) + 1);
      }
      for (const mId of Array.isArray(q.modules) ? q.modules : []) {
        g.modules.set(mId, (g.modules.get(mId) || 0) + 1);
      }
    }
  }

  const all = [...groups.values()].map((g) => ({
    ...g,
    avgR: g.seen ? div(g.rSum, g.seen, 1) : 1,
    avgS: g.seen ? div(g.sSum, g.seen, 0) : 0,
    tagList: [...g.tags.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
    moduleList: [...g.modules.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
  }));

  const touched = all.filter((g) => g.seen > 0);
  const lapsed = touched.filter((g) => g.lapses > 0);
  const mode = lapsed.length ? 'lapses' : 'recall';
  const pool = lapsed.length ? lapsed : touched;

  pool.sort((a, b) => (mode === 'lapses'
    ? (b.lapses - a.lapses) || (a.avgR - b.avgR)
    : (a.avgR - b.avgR) || (b.seen - a.seen)));

  const top = pool.slice(0, Math.max(1, Math.floor(n(limit, 10))));

  /* Threads: a tag or module that links several weak clusters.
   *
   * "Shared by 2 or more" is not enough on its own. Tags like `pop:adult` or
   * `field:contraindications` sit on almost every card in the deck, so they
   * attach to all ten clusters and tell the learner precisely nothing — they
   * describe the corpus, not the weakness. A thread is only informative when it
   * is *selective*: common among the weak clusters and rarer outside them.
   *
   * So each candidate is scored by lift — its prevalence inside the weak set
   * against its prevalence across every topic the learner has touched. A tag on
   * 4 of 10 weak clusters but only 5% of everything else is a real finding; a
   * tag on 10 of 10 and 95% of everything else is wallpaper. Anything at or
   * below parity is dropped entirely.
   */
  const baseline = new Map();
  for (const g of touched) {
    for (const key of new Set([...g.tagList.map((t) => `tag:${t}`),
                               ...g.moduleList.map((t) => `module:${t}`)])) {
      baseline.set(key, (baseline.get(key) || 0) + 1);
    }
  }

  const threads = new Map();
  for (const g of top) {
    for (const key of [...g.tagList.map((t) => ({ kind: 'tag', key: t })),
                       ...g.moduleList.map((t) => ({ kind: 'module', key: t }))]) {
      const id = `${key.kind}:${key.key}`;
      let th = threads.get(id);
      if (!th) { th = { kind: key.kind, key: key.key, id, clusters: [] }; threads.set(id, th); }
      if (!th.clusters.includes(g.key)) th.clusters.push(g.key);
    }
  }

  const outside = Math.max(0, touched.length - top.length);
  const threadList = [...threads.values()]
    .filter((t) => t.clusters.length >= 2 && t.clusters.length < top.length)
    .map((t) => {
      const everywhere = baseline.get(t.id) || t.clusters.length;
      const elsewhere = Math.max(0, everywhere - t.clusters.length);
      const inRate = div(t.clusters.length, top.length, 0);
      const outRate = outside > 0 ? div(elsewhere, outside, 0) : 0;
      // +0.08 smoothing: without it a tag appearing nowhere else scores
      // infinite lift on a single cluster and swamps genuinely broader threads.
      return { ...t, elsewhere, lift: div(inRate, outRate + 0.08, 0), inRate };
    })
    .filter((t) => t.lift > 1.25)
    .sort((a, b) => b.lift - a.lift
      || b.clusters.length - a.clusters.length
      || (a.key < b.key ? -1 : 1));

  return {
    mode,
    clusters: top,
    threads: threadList,
    touchedCount: touched.length,
    totalLapses: touched.reduce((a, g) => a + g.lapses, 0),
  };
}

/**
 * Binary treemap. Splits the longer side at the value-median, recursively,
 * which keeps boxes close to square without the full squarified bookkeeping.
 * Purely geometric — no DOM — so it is unit-testable.
 */
export function treemap(items, x, y, w, h, out = []) {
  const list = (items || []).filter(Boolean);
  if (!list.length || !(w > 0) || !(h > 0)) return out;
  if (list.length === 1) {
    out.push({ item: list[0], x, y, w, h });
    return out;
  }
  const total = list.reduce((a, b) => a + Math.max(0, n(b.value, 0)), 0);
  let split = 1;
  let acc = 0;
  if (total > 0) {
    let best = Infinity;
    let run = 0;
    for (let i = 0; i < list.length - 1; i += 1) {
      run += Math.max(0, n(list[i].value, 0));
      const diff = Math.abs(div(run, total, 0) - 0.5);
      if (diff < best) { best = diff; split = i + 1; acc = run; }
    }
  } else {
    split = Math.ceil(list.length / 2);
    acc = split;
  }
  const a = list.slice(0, split);
  const b = list.slice(split);
  const frac = clamp(total > 0 ? div(acc, total, 0.5) : div(split, list.length, 0.5),
                     0.08, 0.92);
  if (w >= h) {
    const wa = w * frac;
    treemap(a, x, y, wa, h, out);
    treemap(b, x + wa, y, w - wa, h, out);
  } else {
    const ha = h * frac;
    treemap(a, x, y, w, ha, out);
    treemap(b, x, y + ha, w, h - ha, out);
  }
  return out;
}

/** The 15 cards fighting hardest: most lapses, then least stable. */
export function hardestCards(questions, cards, srs, now = Date.now(), limit = 15) {
  const map = cards && typeof cards === 'object' ? cards : {};
  const rows = [];
  for (const q of Array.isArray(questions) ? questions : []) {
    if (!q || !q.id) continue;
    const c = map[q.id];
    if (!c || c.state === 'new' || !isNum(c.stability) || !c.lastReview) continue;
    let r = 1;
    try {
      if (typeof srs?.retrievability === 'function') r = n(srs.retrievability(c, now), 1);
    } catch { r = 1; }
    rows.push({
      q,
      card: c,
      lapses: Math.max(0, n(c.lapses, 0)),
      stability: n(c.stability, 0),
      difficulty: n(c.difficulty, 0),
      reps: Math.max(0, n(c.reps, 0)),
      r: clamp(r, 0, 1),
    });
  }
  rows.sort((a, b) => (b.lapses - a.lapses)
    || (a.stability - b.stability)
    || (a.q.id < b.q.id ? -1 : 1));
  return rows.slice(0, Math.max(1, Math.floor(n(limit, 15))));
}

/* ========================================================================
   mount
   ======================================================================== */

let activeTeardown = null;

/**
 * Render the analytics dashboard into `root`.
 *
 * @param {HTMLElement} root  container owned by the shell (`#view`)
 * @param {{store: object, srs: object, data: object, bus: object}} deps
 * @param {{path: string, params: object}} [route]  `?tax=` / `?h=` preselect
 */
export function mountAnalytics(root, deps, route) {
  if (typeof activeTeardown === 'function') activeTeardown();
  activeTeardown = null;

  const { store, srs, data, bus } = deps || {};
  if (!root || !store || !srs || !data) {
    if (root) {
      mount(root, el('.empty', {}, [
        el('h3', { text: 'Analytics is unavailable' }),
        el('p', { text: 'The dashboard could not reach the learner data it needs.' }),
      ]));
    }
    return;
  }

  const params = (route && route.params) || {};

  /* ----------------------------------------------------- view state */
  const S = {
    horizon: HORIZONS.some((x) => String(x.d) === String(params.h))
      ? Number(params.h) : 30,
    tax: null,              // resolved on first render
    covFilter: null,        // all | enabled | started
    covExpanded: false,
    lastWidth: 0,
    node: null,
  };

  const matureDays = n(srs?._model?.MATURE_DAYS, DEFAULT_MATURE_DAYS);

  const settings = () => {
    try { return store.getSettings() || {}; } catch { return {}; }
  };
  const target = () => {
    const r = settings().desiredRetention;
    return isNum(r) ? clamp(r, 0.5, 0.99) : 0.9;
  };
  const dataset = () => {
    try { return data.getData() || null; } catch { return null; }
  };

  /* ------------------------------------------------ teardown wiring */
  const offs = [];
  let ro = null;
  let resizeTimer = null;

  function teardown() {
    offs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    offs.length = 0;
    if (ro) { try { ro.disconnect(); } catch { /* ignore */ } ro = null; }
    clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
    activeTeardown = null;
  }

  /** Dead node means the learner routed away; stop listening. */
  function alive() {
    if (S.node && S.node.isConnected) return true;
    teardown();
    return false;
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!alive()) return;
      // Re-render only when the measured width actually moved enough to matter.
      // Charts are built at pixel width, so a few px of scrollbar churn must
      // not thrash the whole dashboard.
      const w = measure();
      if (Math.abs(w - S.lastWidth) >= 24) render();
    }, 160);
  }

  activeTeardown = teardown;

  for (const evt of ['review:logged', 'session:complete', 'settings:changed',
                     'progress:reset']) {
    if (bus && typeof bus.on === 'function') {
      const off = bus.on(evt, () => { if (alive()) render(); });
      if (typeof off === 'function') offs.push(off);
    }
  }
  window.addEventListener('resize', onResize);

  /* ----------------------------------------------------- measurement */

  /** Usable pixel width inside a full-bleed `.card`. */
  function measure() {
    const outer = n(root.clientWidth, 0) || n(root.getBoundingClientRect().width, 0);
    const w = outer > 0 ? outer : 900;
    // .card is sp-5 padding each side + 1px border each side.
    return clamp(Math.floor(w - 42), 240, 1200);
  }

  /* ========================================================= panels */

  function panel(key, title, sub, body, aside) {
    return el('section.an-panel.card', { dataset: { panel: key } }, [
      el('.an-head', {}, [
        el('div', {}, [
          el('h2.an-title', { text: title }),
          sub ? el('p.an-sub', { text: sub }) : null,
        ]),
        aside || null,
      ]),
      ...[].concat(body).filter(Boolean),
      el('.an-tip', { 'aria-hidden': 'true' }),
    ]);
  }

  function emptyNote(head, body) {
    return el('.an-empty', {}, [
      el('strong', { text: head }),
      body ? el('p', { text: body }) : null,
    ]);
  }

  function legend(items) {
    return el('.an-legend', {}, items.map(([cls, label]) => el('.an-legend-item', {}, [
      el(`i.an-swatch.${cls}`, { 'aria-hidden': 'true' }),
      el('span', { text: label }),
    ])));
  }

  /* ---------------------------------------------- 1. headline stats */

  function headlinePanel(ctx) {
    const { ls, sum, seen } = ctx;
    const tile = (k, v, s, tone) => el('.stat.an-stat', { dataset: { tone: tone || '' } }, [
      el('.k', { text: k }),
      el('.v', { text: String(v) }),
      s ? el('.s', { text: s }) : null,
    ]);

    const ret = ls.retention30;
    const retTone = ret === null ? '' : ret >= target() ? 'ok' : ret >= target() - 0.08 ? 'warn' : 'bad';

    return el('.grid.grid-stats.an-stats', {}, [
      tile('Cards seen', sum.seen.toLocaleString(),
        `of ${sum.total.toLocaleString()} in scope`, sum.seen ? 'accent' : ''),
      tile('Mature', sum.mature.toLocaleString(),
        `${pct(div(sum.mature, Math.max(1, sum.seen), 0))} of seen · ≥${matureDays}d stable`,
        sum.mature ? 'ok' : ''),
      tile('Retention', ret === null ? '—' : pct(ret),
        ret === null ? 'no reviews in 30 days'
          : `last 30 days · target ${pct(target())}`, retTone),
      tile('Streak', ls.streak ? plural(ls.streak, 'day') : '—',
        ls.bestStreak > ls.streak ? `best ${plural(ls.bestStreak, 'day')}`
          : `${plural(ls.activeDays, 'active day')}`, ls.streak >= 3 ? 'ok' : ''),
      tile('Reviews', ls.total.toLocaleString(),
        ls.first ? `since ${fmtDay(ls.first)}` : 'none yet'),
      tile('Pace', fmtMs(ls.avgMs), ls.avgMs ? 'average per card' : 'no timings yet'),
      tile('Memory now', seen.length ? pct(ctx.recallNow) : '—',
        seen.length ? `mean predicted recall, ${plural(seen.length, 'card')}`
          : 'nothing learned yet', seen.length ? 'accent' : ''),
      tile('Due today', sum.due.toLocaleString(),
        sum.nextDue ? `next ${relTime(sum.nextDue)}` : 'nothing scheduled',
        sum.due ? 'accent' : ''),
    ]);
  }

  /* -------------------------------------------------- 2. heatmap */

  function heatmapPanel(ctx, width) {
    const { ls } = ctx;
    // 26 weeks if the pitch stays readable, fewer if the column is very narrow.
    const gutter = 22;
    const pitch = clamp(Math.floor(div(width - gutter, HEATMAP_WEEKS, 12)), 9, 15);
    const weeks = pitch >= 10
      ? HEATMAP_WEEKS
      : clamp(Math.floor(div(width - gutter, 10, 12)), 8, HEATMAP_WEEKS);
    const cell = Math.max(7, pitch - 3);
    const grid = heatmapGrid(ls.byDay, weeks, ctx.now);

    const top = 16;
    const h = top + 7 * pitch + 4;
    const label = grid.total
      ? `Review activity calendar, last ${weeks} weeks: ${grid.total} reviews across `
        + `${ls.activeDays} days, busiest day ${grid.max} reviews.`
      : `Review activity calendar, last ${weeks} weeks: no reviews recorded yet.`;

    const svg = chart(width, h, label, 'an-heatmap');

    // weekday gutter — Mon / Wed / Fri only, the convention, and the only
    // three that fit at this pitch.
    for (const r of [1, 3, 5]) {
      svg.append(sv('text.an-axis-label', {
        x: 0, y: top + r * pitch + cell * 0.75, text: WEEKDAY[r],
      }));
    }

    // month ticks where the month changes
    let lastMonth = -1;
    grid.cols.forEach((col, c) => {
      const m = new Date(col[0].t).getMonth();
      if (m !== lastMonth && c <= grid.cols.length - 3) {
        lastMonth = m;
        svg.append(sv('text.an-axis-label', {
          x: gutter + c * pitch, y: 10, text: MONTH[m],
        }));
      }
    });

    /* Cells carry `data-label`, not `aria-label`: the svg is `role="img"`, so
     * anything inside it is already hidden from assistive tech, and a stray
     * aria-label there is dead weight that only confuses an audit. Screen
     * reader users get the whole-chart summary from the svg's own label; the
     * live readout below carries the per-day detail as focus moves. */
    const cells = [];
    grid.cols.forEach((col, c) => {
      col.forEach((day, r) => {
        if (day.future) return;
        const lvl = heatLevel(day.count, grid.max);
        const text = `${fmtDay(day.t)} · ${day.count ? plural(day.count, 'review') : 'no reviews'}`;
        const rect = sv(`rect.hm-cell.hm-l${lvl}`, {
          x: gutter + c * pitch,
          y: top + r * pitch,
          width: cell,
          height: cell,
          rx: 2,
          'data-tip': text,
          'data-label': text,
          tabindex: '-1',
        });
        titled(rect, text);
        cells.push(rect);
        svg.append(rect);
      });
    });

    /* Roving tabindex. 182 individually tabbable cells would be hostile, and a
     * calendar is a grid — arrows are what a keyboard user expects. One tab
     * stop in, then arrows: right/left move a week, up/down a day. */
    const readout = el('.an-readout', { role: 'status', 'aria-live': 'polite' }, [
      grid.total
        ? `${plural(grid.total, 'review')} in the last ${weeks} weeks`
        : 'No reviews recorded yet',
    ]);

    let cursor = Math.max(0, cells.length - 1);
    const focusAt = (i) => {
      if (!cells.length) return;
      const next = clamp(i, 0, cells.length - 1);
      const prev = cells[cursor];
      if (prev) prev.setAttribute('tabindex', '-1');
      cursor = next;
      const c = cells[cursor];
      c.setAttribute('tabindex', '0');
      c.focus({ preventScroll: true });
      readout.textContent = c.getAttribute('data-label');
    };
    if (cells.length) cells[cursor].setAttribute('tabindex', '0');

    svg.addEventListener('keydown', (ev) => {
      const map = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };
      if (ev.key in map) { ev.preventDefault(); focusAt(cursor + map[ev.key]); return; }
      if (ev.key === 'Home') { ev.preventDefault(); focusAt(0); return; }
      if (ev.key === 'End') { ev.preventDefault(); focusAt(cells.length - 1); }
    });
    svg.addEventListener('focusin', (ev) => {
      const i = cells.indexOf(ev.target);
      if (i < 0) return;
      const prev = cells[cursor];
      if (prev && prev !== ev.target) prev.setAttribute('tabindex', '-1');
      cursor = i;
      cells[i].setAttribute('tabindex', '0');
      readout.textContent = cells[i].getAttribute('data-label');
    });
    svg.addEventListener('pointerover', (ev) => {
      const t = ev.target.closest ? ev.target.closest('.hm-cell') : null;
      if (t) readout.textContent = t.getAttribute('data-label');
    });

    const scale = el('.an-heat-scale', {}, [
      el('span', { text: 'Quieter' }),
      ...[0, 1, 2, 3, 4].map((l) => el(`i.an-swatch.hm-sw.hm-l${l}`, { 'aria-hidden': 'true' })),
      el('span', { text: 'Busier' }),
    ]);

    return [
      el('.an-chart-wrap', {}, [svg]),
      el('.an-foot', {}, [readout, scale]),
      grid.total === 0
        ? emptyNote('Nothing here yet — and that is fine.',
          'Every card you grade lights up a square. One short session a day fills this calendar faster than one long session a week, and the scheduler is built on that assumption.')
        : null,
    ];
  }

  /* ------------------------------------------------ 3. retention */

  function retentionPanel(ctx, width) {
    const weeks = width < 420 ? 9 : width < 700 ? 13 : 20;
    const series = retentionWeekly(ctx.log, weeks, ctx.now);
    const withData = series.filter((b) => b.graded > 0);

    if (!withData.length) {
      return [emptyNote('No graded reviews yet.',
        'Once you have a week of reviews behind you, this chart compares what you actually remembered against the target retention you set in Settings. If the two disagree, the target is the thing to move.')];
    }

    const pad = { t: 14, r: 12, b: 24, l: 34 };
    const h = 190;
    const iw = Math.max(40, width - pad.l - pad.r);
    const ih = h - pad.t - pad.b;
    const lo = 0.4;
    const yOf = (v) => pad.t + ih * (1 - clamp(div(clamp(v, lo, 1) - lo, 1 - lo, 0), 0, 1));
    const xOf = (i) => pad.l + (series.length > 1 ? (iw * i) / (series.length - 1) : iw / 2);

    const tgt = target();
    const mean = div(withData.reduce((a, b) => a + b.rate, 0), withData.length, 0);
    const svg = chart(width, h,
      `Weekly retention over ${series.length} weeks. Measured accuracy averages `
      + `${Math.round(mean * 100)}% against a target of ${Math.round(tgt * 100)}%. `
      + `Latest week ${Math.round(n(withData[withData.length - 1].rate, 0) * 100)}%.`);

    // gridlines
    for (const v of [0.4, 0.55, 0.7, 0.85, 1]) {
      svg.append(sv('line.an-grid', { x1: pad.l, x2: pad.l + iw, y1: yOf(v), y2: yOf(v) }));
      svg.append(sv('text.an-axis-label.an-axis-y', {
        x: pad.l - 6, y: yOf(v) + 4, text: `${Math.round(v * 100)}%`,
      }));
    }

    // target reference line
    svg.append(sv('line.an-ref', { x1: pad.l, x2: pad.l + iw, y1: yOf(tgt), y2: yOf(tgt) }));
    svg.append(sv('text.an-ref-label', {
      x: pad.l + iw, y: yOf(tgt) - 6, 'text-anchor': 'end',
      text: `target ${Math.round(tgt * 100)}%`,
    }));

    // the measured line, broken across weeks with no reviews rather than
    // interpolated through them — a silent week is missing data, not 0%.
    const runs = [];
    let run = [];
    series.forEach((b, i) => {
      if (b.graded > 0) run.push([xOf(i), yOf(b.rate)]);
      else if (run.length) { runs.push(run); run = []; }
    });
    if (run.length) runs.push(run);

    for (const seg of runs) {
      if (seg.length > 1) {
        svg.append(sv('path.an-area.an-area-1', { d: areaPath(seg, pad.t + ih) }));
        svg.append(sv('path.an-line.an-line-1', { d: path(seg) }));
      }
    }
    series.forEach((b, i) => {
      if (b.graded <= 0) return;
      const dot = sv(`circle.an-dot${b.rate < tgt ? '.is-under' : ''}`, {
        cx: r1(xOf(i)), cy: r1(yOf(b.rate)), r: runs.length && series.length > 16 ? 3 : 4,
        'data-tip': `Week of ${fmtDay(b.start)} · ${pct(b.rate)} of ${plural(b.graded, 'review')}`,
      });
      titled(dot, `Week of ${fmtDay(b.start)}: ${pct(b.rate)} of ${plural(b.graded, 'review')}`);
      svg.append(dot);
    });

    // x labels: first, middle, last
    const ticks = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1]
      : series.map((_, i) => i);
    for (const i of ticks) {
      const d = new Date(series[i].start);
      svg.append(sv('text.an-axis-label', {
        x: r1(xOf(i)), y: h - 8, 'text-anchor': i === 0 ? 'start'
          : i === series.length - 1 ? 'end' : 'middle',
        text: `${d.getDate()} ${MONTH[d.getMonth()]}`,
      }));
    }

    const last = withData[withData.length - 1];
    const verdict = mean >= tgt
      ? `You are holding ${pct(mean)} against a ${pct(tgt)} target — the schedule is working, and you could raise the target (shorter intervals, more reviews) if you want more headroom.`
      : mean >= tgt - 0.08
        ? `You are running a little under your ${pct(tgt)} target. That is normal while new material is still settling.`
        : `You are well under your ${pct(tgt)} target. The usual cause is too many new cards per day, not too few reviews — try lowering "New cards per day" in Settings before raising the target.`;

    return [
      el('.an-chart-wrap', {}, [svg]),
      el('p.an-caption', { text: `Latest week: ${pct(last.rate)} of ${plural(last.graded, 'graded review')}. ${verdict}` }),
    ];
  }

  /* --------------------------------- 4. trajectory (the differentiator) */

  function trajectoryPanel(ctx, width) {
    const { seen } = ctx;
    const days = S.horizon;
    const two = width >= 820;
    const cw = two ? Math.floor((width - 20) / 2) : width;

    const blocks = [];

    /* ---- A. the collection: forget vs keep up ---- */
    if (seen.length) {
      const decay = aggregateDecay(srs, ctx.cards, days, ctx.now, 60);
      const keep = aggregateWithReviews(srs, ctx.cards, days, ctx.now,
        { desiredRetention: target() }, Math.min(60, Math.max(12, days)));
      blocks.push(collectionChart(cw, days, decay, keep, seen.length, ctx));
    } else {
      blocks.push(el('.an-sub-panel', {}, [
        el('h3.an-sub-title', { text: 'Your collection' }),
        emptyNote('Nothing to forget yet.',
          'Once you have graded a few cards this chart shows two lines: what you would still recall if you stopped today, and what you hold if you keep up with the schedule. The gap between them is what your reviews actually buy you.'),
      ]));
    }

    /* ---- B. the ladder: what one review is worth ---- */
    blocks.push(ladderChart(cw, ctx));

    return [
      el(`.an-two${two ? '.is-side-by-side' : ''}`, {}, blocks),
    ];
  }

  function collectionChart(width, days, decay, keep, cardCount, ctx) {
    const pad = { t: 16, r: 14, b: 26, l: 36 };
    const h = 215;
    const iw = Math.max(40, width - pad.l - pad.r);
    const ih = h - pad.t - pad.b;
    const xOf = (d) => pad.l + iw * clamp(div(d, days, 0), 0, 1);
    const yOf = (r) => pad.t + ih * (1 - clamp(n(r, 0), 0, 1));

    const endDecay = decay.length ? n(decay[decay.length - 1].r, 0) : 0;
    const endKeep = keep.length ? n(keep[keep.length - 1].r, 0) : 0;
    const startR = decay.length ? n(decay[0].r, 0) : 0;

    const svg = chart(width, h,
      `Learning versus forgetting over ${days} days across ${cardCount} cards. `
      + `Predicted recall today is ${Math.round(startR * 100)}%. With no further `
      + `reviews it falls to ${Math.round(endDecay * 100)}% by day ${days}; `
      + `keeping up with the schedule holds it near ${Math.round(endKeep * 100)}%.`);

    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(sv('line.an-grid', { x1: pad.l, x2: pad.l + iw, y1: yOf(v), y2: yOf(v) }));
      svg.append(sv('text.an-axis-label.an-axis-y', {
        x: pad.l - 6, y: yOf(v) + 4, text: `${Math.round(v * 100)}%`,
      }));
    }
    const tgt = target();
    svg.append(sv('line.an-ref', { x1: pad.l, x2: pad.l + iw, y1: yOf(tgt), y2: yOf(tgt) }));

    const keepPts = keep.map((p) => [xOf(p.d), yOf(p.r)]);
    const decayPts = decay.map((p) => [xOf(p.d), yOf(p.r)]);

    if (keepPts.length > 1) {
      svg.append(sv('path.an-area.an-area-2', { d: areaPath(keepPts, pad.t + ih) }));
      svg.append(sv('path.an-line.an-line-2', { d: path(keepPts) }));
    }
    if (decayPts.length > 1) {
      svg.append(sv('path.an-line.an-line-decay', { d: path(decayPts) }));
    }

    /* Annotate the gap with a vertical marker two thirds along — far enough
     * right that the lines have separated, far enough left that an end-anchored
     * label still has room. The label needs a readable band: only draw it when
     * the gap is both wide enough in value and tall enough in pixels to hold
     * 11px type, otherwise it lands on top of one of the two curves it is
     * describing. The caption underneath carries the same point in words, so
     * dropping the in-chart label loses nothing. */
    if (decayPts.length > 1 && keepPts.length > 1 && endKeep - endDecay > 0.04) {
      const gx = xOf(days * 0.68);
      const gyTop = yOf(sampleCurve(keep, days * 0.68));
      const gyBot = yOf(sampleCurve(decay, days * 0.68));
      svg.append(sv('line.an-annot-line', { x1: gx, x2: gx, y1: gyTop, y2: gyBot }));
      // end caps, so the marker reads as a measured span rather than a stray rule
      for (const y of [gyTop, gyBot]) {
        svg.append(sv('line.an-annot-line', { x1: gx - 3, x2: gx + 3, y1: y, y2: y }));
      }
      if (gyBot - gyTop >= 26 && gx - pad.l > 92) {
        svg.append(sv('text.an-annot', {
          x: gx - 7, y: (gyTop + gyBot) / 2 + 4, 'text-anchor': 'end',
          text: 'what reviewing buys',
        }));
      }
    }

    for (const d of [0, days * 0.5, days]) {
      svg.append(sv('text.an-axis-label', {
        x: r1(xOf(d)), y: h - 8,
        'text-anchor': d === 0 ? 'start' : d === days ? 'end' : 'middle',
        text: d === 0 ? 'today' : `+${humanDays(d)}`,
      }));
    }

    const stop = seenCards(ctx.cards).length;
    return el('.an-sub-panel', {}, [
      el('h3.an-sub-title', { text: 'Your collection: learning vs forgetting' }),
      legend([['an-sw-2', 'If you keep reviewing'], ['an-sw-decay', 'If you stop today'],
              ['an-sw-ref', `Target ${pct(tgt)}`]]),
      el('.an-chart-wrap', {}, [svg]),
      el('p.an-caption', {
        text: `Right now the model puts your mean recall across ${plural(stop, 'learned card')} at `
          + `${pct(startR)}. Stop reviewing and in ${humanDays(days)} that is ${pct(endDecay)} — `
          + `about ${Math.round(Math.max(0, startR - endDecay) * stop)} cards' worth of recall gone. `
          + `Keep to the schedule and you stay near ${pct(endKeep)}`
          + (isNum(keep.reviews) ? `, for roughly ${plural(Math.round(keep.reviews * div(stop, Math.max(1, n(keep.sampled, stop)), 1)), 'review')} over that window.` : '.'),
      }),
    ]);
  }

  function ladderChart(width, ctx) {
    const steps = learningLadder(srs, 6, { desiredRetention: target() });
    const pad = { t: 16, r: 14, b: 26, l: 36 };
    const h = 215;
    const iw = Math.max(40, width - pad.l - pad.r);
    const ih = h - pad.t - pad.b;

    if (!steps.length) {
      return el('.an-sub-panel', {}, [
        el('h3.an-sub-title', { text: 'What one review buys' }),
        emptyNote('Model unavailable.', 'The scheduler did not return a curve to draw.'),
      ]);
    }

    // Horizon: far enough out that the last curve has visibly bent.
    const maxS = steps.reduce((a, s) => Math.max(a, s.stability), 1);
    const span = clamp(Math.round(maxS * 2.2), 7, 400);
    const xOf = (d) => pad.l + iw * clamp(div(d, span, 0), 0, 1);
    const yOf = (r) => pad.t + ih * (1 - clamp(n(r, 0), 0, 1));
    const tgt = target();

    const svg = chart(width, h,
      `Illustrative forgetting curves for a single card after each successful `
      + `review. Memory half-life grows from ${humanDays(steps[0].stability)} after the `
      + `first review to ${humanDays(steps[steps.length - 1].stability)} after `
      + `${steps.length}, so each curve decays more slowly than the last.`);

    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      svg.append(sv('line.an-grid', { x1: pad.l, x2: pad.l + iw, y1: yOf(v), y2: yOf(v) }));
      svg.append(sv('text.an-axis-label.an-axis-y', {
        x: pad.l - 6, y: yOf(v) + 4, text: `${Math.round(v * 100)}%`,
      }));
    }
    svg.append(sv('line.an-ref', { x1: pad.l, x2: pad.l + iw, y1: yOf(tgt), y2: yOf(tgt) }));
    /* Below the line, not above it. Every curve in this chart starts at 100%
     * and falls through the target, so the band above the target line is the
     * busiest part of the plot — a label there sits on top of the data. The
     * band just below it is empty by construction. */
    svg.append(sv('text.an-ref-label', {
      x: pad.l + iw, y: yOf(tgt) + 14, 'text-anchor': 'end',
      text: `target ${pct(tgt)}`,
    }));

    steps.forEach((s, i) => {
      const curve = srs.forgettingCurve(s.card, span, 80);
      const pts = curve.map((p) => [xOf(p.d), yOf(p.r)]);
      const cls = `an-line-c${(i % 6) + 1}`;
      const p = sv(`path.an-line.an-thin.${cls}`, {
        d: path(pts),
        'data-tip': `After review ${s.rep}: half-life ${humanDays(s.stability)}, next due in ${humanDays(s.interval)}`,
      });
      titled(p, `After review ${s.rep}: stability ${humanDays(s.stability)}`);
      svg.append(p);

      // Mark where the scheduler would next ask for this card: the crossing of
      // the curve with the target line. That is the whole scheduling policy in
      // one dot.
      const cx = xOf(Math.min(s.interval, span));
      if (s.interval <= span) {
        const dot = sv(`circle.an-dot.an-dot-sm.${cls}`, {
          cx: r1(cx), cy: r1(yOf(tgt)), r: 3.5,
          'data-tip': `Review ${s.rep} → next due in ${humanDays(s.interval)}`,
        });
        titled(dot, `Review ${s.rep}: next due in ${humanDays(s.interval)}`);
        svg.append(dot);
      }
    });

    for (const d of [0, span * 0.5, span]) {
      svg.append(sv('text.an-axis-label', {
        x: r1(xOf(d)), y: h - 8,
        'text-anchor': d === 0 ? 'start' : d === span ? 'end' : 'middle',
        text: d === 0 ? 'review' : `+${humanDays(d)}`,
      }));
    }

    return el('.an-sub-panel', {}, [
      el('h3.an-sub-title', { text: 'What one review buys' }),
      el('.an-legend', {}, steps.map((s, i) => el('.an-legend-item', {}, [
        el(`i.an-swatch.an-sw-c${(i % 6) + 1}`, { 'aria-hidden': 'true' }),
        el('span', { text: `#${s.rep} · ${humanDays(s.stability)}` }),
      ]))),
      el('.an-chart-wrap', {}, [svg]),
      el('p.an-caption', {
        text: `One card, graded "Good" ${plural(steps.length, 'time')} in a row. Each curve starts at `
          + `100% and decays, but it decays more slowly every time: the half-life goes `
          + `${steps.map((s) => humanDays(s.stability)).join(' → ')}. The dots are where each curve `
          + `crosses your ${pct(tgt)} target — that is exactly when the scheduler asks for the card `
          + `again, which is why the intervals stretch instead of repeating.`,
      }),
    ]);
  }

  /* ------------------------------------------------ 5. workload */

  function workloadPanel(ctx, width) {
    const days = 30;
    let series = [];
    try { series = srs.workloadForecast(ctx.cards, days, ctx.now) || []; } catch { series = []; }
    series = series.filter((b) => b && typeof b.date === 'string').map((b) => ({
      date: b.date, count: Math.max(0, n(b.count, 0)),
    }));

    const cap = Math.max(1, n(settings().dailyMax, 120));
    const total = series.reduce((a, b) => a + b.count, 0);
    const over = series.filter((b) => b.count > cap);
    const overFuture = over.filter((b) => b !== series[0]);
    const peak = series.reduce((a, b) => Math.max(a, b.count), 0);

    if (!series.length || total === 0) {
      return [emptyNote('Nothing scheduled yet.',
        `As soon as you grade a card the scheduler books it a return date, and this chart shows the next ${days} days of them. Watching it is how you catch a review cliff four weeks before you walk off it.`)];
    }

    const pad = { t: 16, r: 12, b: 26, l: 34 };
    const h = 190;
    const iw = Math.max(40, width - pad.l - pad.r);
    const ih = h - pad.t - pad.b;

    /* Scale off the *future*, not off the backlog.
     *
     * `workloadForecast` buckets everything already overdue into day 0, which
     * is correct — that is the work the learner faces now. But a learner
     * returning after a break has a day-0 bar several times taller than any
     * scheduled day, and scaling to it flattens the next 29 days into a 1px
     * baseline. The panel's whole job is spotting a cliff forming three weeks
     * out, and that is exactly what gets destroyed.
     *
     * So the axis is fitted to the scheduled days and the cap; when the backlog
     * exceeds it the bar is clipped at the top and labelled with its true
     * value. Clipping a bar is only honest if the reader is told — hence the
     * explicit number above it and the break marker. */
    const backlog = series[0].count;
    const future = series.slice(1);
    const futurePeak = future.reduce((a, b) => Math.max(a, b.count), 0);
    const fitted = Math.max(futurePeak, cap) * 1.12;
    const clipped = backlog > fitted;
    const top = clipped ? fitted : Math.max(peak, cap) * 1.12;

    const slot = div(iw, series.length, 10);
    const bw = Math.max(3, slot - Math.max(1.5, slot * 0.22));
    const yOf = (v) => pad.t + ih * (1 - clamp(div(n(v), top, 0), 0, 1));

    const peakDay = series.reduce((a, b) => (b.count > a.count ? b : a), series[0]);
    const svg = chart(width, h,
      `Review workload forecast, next ${days} days. ${total} reviews total, `
      + `average ${Math.round(div(total, series.length, 0))} per day. `
      + `Today carries ${plural(backlog, 'card')} including anything overdue. `
      + `Busiest scheduled day ${peakDay.date} with ${plural(peakDay.count, 'card')} due. `
      + `Daily maximum is ${cap}. `
      + `${over.length ? `${plural(over.length, 'day')} exceed it.` : 'No day exceeds it.'}`
      + (clipped ? ' Today\'s bar is clipped to keep the scheduled days readable.' : ''));

    for (let i = 0; i <= 3; i += 1) {
      const v = (top * i) / 3;
      if (clipped && i === 3) continue;   // the top gridline is where the clip sits
      svg.append(sv('line.an-grid', { x1: pad.l, x2: pad.l + iw, y1: yOf(v), y2: yOf(v) }));
      svg.append(sv('text.an-axis-label.an-axis-y', {
        x: pad.l - 6, y: yOf(v) + 4, text: String(Math.round(v)),
      }));
    }

    series.forEach((b, i) => {
      const x = pad.l + i * slot + (slot - bw) / 2;
      const y = yOf(b.count);
      const hh = Math.max(b.count > 0 ? 2 : 0, pad.t + ih - y);
      const hot = b.count > cap;
      const isClipped = i === 0 && clipped;
      const rect = sv(`rect.an-bar${hot ? '.is-over' : ''}${i === 0 ? '.is-today' : ''}`, {
        x: r1(x), y: r1(y), width: r1(bw), height: r1(hh), rx: Math.min(2, bw / 2),
        'data-tip': (i === 0 ? `Today · ${plural(b.count, 'card')} due (includes everything overdue)`
          : `${fmtDay(Date.parse(`${b.date}T12:00:00`))} · ${plural(b.count, 'card')} due`)
          + (hot ? ` — over your ${cap}/day cap` : ''),
      });
      titled(rect, `${b.date}: ${plural(b.count, 'card')} due`);
      svg.append(rect);

      // Say so when a bar runs off the top, and how far.
      if (isClipped) {
        svg.append(sv('text.an-annot.an-clip-label', {
          x: r1(x + bw / 2), y: r1(pad.t - 5), 'text-anchor': 'middle',
          text: String(b.count),
        }));
        for (const dy of [0, 3]) {
          svg.append(sv('line.an-clip-break', {
            x1: r1(x - 1.5), x2: r1(x + bw + 1.5),
            y1: r1(pad.t + 2 + dy), y2: r1(pad.t - 1 + dy),
          }));
        }
      }
    });

    svg.append(sv('line.an-ref.an-ref-bad', {
      x1: pad.l, x2: pad.l + iw, y1: yOf(cap), y2: yOf(cap),
    }));
    svg.append(sv('text.an-ref-label', {
      x: pad.l + iw, y: yOf(cap) - 6, 'text-anchor': 'end',
      text: `daily max ${cap}`,
    }));

    for (const i of [0, Math.floor(series.length / 2), series.length - 1]) {
      const b = series[i];
      if (!b) continue;
      const d = new Date(Date.parse(`${b.date}T12:00:00`));
      svg.append(sv('text.an-axis-label', {
        x: r1(pad.l + i * slot + slot / 2), y: h - 8,
        'text-anchor': i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle',
        text: i === 0 ? 'today' : `${d.getDate()} ${MONTH[d.getMonth()]}`,
      }));
    }

    return [
      el('.an-chart-wrap', {}, [svg]),
      el('.an-foot', {}, [
        el('span.an-readout', {
          text: `${plural(total, 'review')} over ${days} days · `
            + `${plural(backlog, 'card')} today`
            + (future.length ? ` · ${Math.round(div(total - backlog, future.length, 0))}/day`
              + ` average after that · scheduled peak ${futurePeak}` : ''),
        }),
      ]),
      clipped
        ? el('p.an-caption', {
          text: `Today's bar is cut off at the top: ${backlog} cards are waiting, including `
            + `everything overdue, which is several times any single scheduled day. The axis is `
            + `fitted to the days ahead so a cliff forming out there stays visible.`,
        })
        : null,
      /* A backlog today and a cliff three weeks out are different problems with
       * different fixes, so they get different wording. Reporting "1 day over
       * your cap" when that day is the backlog would send the learner to change
       * a setting that cannot help. */
      over.length
        ? el('.an-warn', {}, [
          el('strong', {
            text: overFuture.length
              ? `${plural(overFuture.length, 'day')} ahead over your ${cap}/day cap`
              : `Today's backlog is over your ${cap}/day cap`,
          }),
          overFuture.length
            ? el('.chip-row', {}, overFuture.slice(0, 8).map((b) => el('span.chip.chip-over', {
              text: `${new Date(Date.parse(`${b.date}T12:00:00`)).getDate()} `
                + `${MONTH[new Date(Date.parse(`${b.date}T12:00:00`)).getMonth()]} · ${b.count}`,
            })))
            : null,
          el('p', {
            text: overFuture.length
              ? 'A day over the cap is not lost work — the queue defers the overflow, which pushes '
                + 'the cliff forward. Lowering "New cards per day" now flattens it; raising the cap '
                + 'only moves where it lands.'
              : `${plural(backlog, 'card')} are waiting, which is more than one session at your cap. `
                + 'The queue will hand you the most overdue first and carry the rest forward, so '
                + 'this clears by itself over a few days — no setting needs changing.',
          }),
          el('a.btn.btn-sm', { href: '#/settings', text: 'Adjust scheduling' }),
        ])
        : el('p.an-caption', {
          text: `No day in the next ${days} ahead exceeds your ${cap}/day cap. `
            + `The busiest is ${peak} on ${fmtDay(Date.parse(`${peakDay.date}T12:00:00`))}.`,
        }),
    ];
  }

  /* ------------------------------------------------ 6. coverage */

  function coveragePanel(ctx, width) {
    const d = ctx.d;
    if (!d || !d.modules || !Array.isArray(d.modules.taxonomies)) {
      return [emptyNote('Module data unavailable.', 'Coverage needs modules.json.')];
    }
    const taxes = d.modules.taxonomies;
    if (!S.tax || !taxes.some((t) => t.id === S.tax)) {
      S.tax = taxes.some((t) => t.id === params.tax) ? params.tax
        : taxes.some((t) => t.id === settings().taxonomy) ? settings().taxonomy
        : taxes[0].id;
    }
    const tax = taxes.find((t) => t.id === S.tax) || taxes[0];
    const enabled = new Set(settings().enabledModules || []);
    const rows = coverageFor(tax, ctx.cards, matureDays);

    if (S.covFilter === null) S.covFilter = enabled.size ? 'enabled' : 'all';

    const apply = (f) => rows.filter((r) => (
      f === 'enabled' ? enabled.has(r.id)
        : f === 'started' ? r.seen > 0
        : true));

    /* A learner's enabled modules usually all live in one taxonomy, so
     * switching taxonomy under the "Enabled" filter would otherwise show an
     * empty list and read as a broken panel. Fall back to showing everything
     * rather than nothing — the filter buttons still say which view is live. */
    let filtered = apply(S.covFilter);
    if (!filtered.length && S.covFilter !== 'all') {
      S.covFilter = 'all';
      filtered = apply('all');
    }
    const shown = S.covExpanded ? filtered : filtered.slice(0, 18);

    const totals = rows.reduce((a, r) => ({
      total: a.total + r.total,
      seen: a.seen + r.seen,
      mature: a.mature + r.buckets.mature,
    }), { total: 0, seen: 0, mature: 0 });

    const groups = new Map();
    for (const r of shown) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(r);
    }

    const row = (r) => {
      const b = r.buckets;
      const seg = (cls, v, label) => (v > 0
        ? el(`i.cov-seg.${cls}`, {
          style: { flexBasis: `${r2(div(v, r.total, 0) * 100)}%` },
          'data-tip': `${plural(v, label === 'untouched' ? 'card' : 'card')} ${label}`,
        })
        : null);
      return el('a.cov-row', {
        href: `#/modules?tax=${encodeURIComponent(tax.id)}`,
        'aria-label': `${r.label}: ${r.seen} of ${r.total} seen, ${b.mature} mature. `
          + 'Open in modules.',
      }, [
        el('.cov-label', {}, [
          el('span.cov-name', { text: r.label }),
          enabled.has(r.id) ? el('span.chip.chip-on', { text: 'on' }) : null,
        ]),
        el('.cov-bar', { role: 'presentation' }, [
          seg('cov-mature', b.mature, 'mature'),
          seg('cov-young', b.young, 'young'),
          seg('cov-learning', b.learning, 'still learning'),
          seg('cov-new', b.new, 'untouched'),
        ]),
        el('span.cov-num', { text: `${r.seen}/${r.total}` }),
      ]);
    };

    const segControl = el('.seg.an-seg', { role: 'tablist', 'aria-label': 'Taxonomy' },
      taxes.map((t) => el('button', {
        type: 'button',
        text: t.label,
        'aria-pressed': String(t.id === tax.id),
        onclick: () => {
          S.tax = t.id;
          S.covExpanded = false;
          try { store.setSetting('taxonomy', t.id); } catch { /* read-only fallback */ }
          render();
        },
      })));

    const filterControl = el('.seg.an-seg.an-seg-sm', { 'aria-label': 'Which modules' },
      [['all', `All ${rows.length}`], ['enabled', `Enabled ${rows.filter((r) => enabled.has(r.id)).length}`],
       ['started', `Started ${rows.filter((r) => r.seen > 0).length}`]]
        .map(([k, label]) => el('button', {
          type: 'button', text: label, 'aria-pressed': String(S.covFilter === k),
          onclick: () => { S.covFilter = k; S.covExpanded = false; render(); },
        })));

    return [
      el('.an-controls', {}, [segControl, filterControl]),
      el('p.an-caption', {
        text: `${tax.description || ''} Across all ${plural(rows.length, 'module')} in this `
          + `taxonomy you have seen ${totals.seen.toLocaleString()} of `
          + `${totals.total.toLocaleString()} questions (${pct(div(totals.seen, totals.total, 0))}), `
          + `${totals.mature.toLocaleString()} of them mature. Questions appear in several `
          + `taxonomies, so these totals overlap by design.`,
      }),
      legend([['cov-mature', `Mature (≥${matureDays}d)`], ['cov-young', 'Young'],
              ['cov-learning', 'Learning'], ['cov-new', 'Untouched']]),
      filtered.length
        ? el('.cov-groups', {}, [...groups.entries()].map(([g, list]) => el('.cov-group', {}, [
          el('h3.cov-group-title', { text: g }),
          el('.cov-list', {}, list.map(row)),
        ])))
        : emptyNote(S.covFilter === 'enabled' ? 'No modules enabled yet.' : 'No modules started yet.',
          'Turn one on and it appears here with its coverage.'),
      filtered.length > shown.length
        ? el('button.btn.btn-sm.an-more', {
          type: 'button',
          text: `Show all ${filtered.length} modules`,
          onclick: () => { S.covExpanded = true; render(); },
        })
        : null,
      el('a.btn.btn-sm', { href: `#/modules?tax=${encodeURIComponent(tax.id)}`, text: 'Manage modules →' }),
    ];
  }

  /* --------------------------------------------- 7. connections */

  function connectionsPanel(ctx, width) {
    const w = weakClusters(ctx.historyQs, ctx.cards, srs, ctx.now, 10);

    if (!w.clusters.length) {
      return [emptyNote('No weak spots to show yet.',
        'Once you have graded cards from a few guidelines, this panel groups your failures by the guideline or drug they came from, then names the tags those groups share — so three separate problems turn into one thing to go and read.')];
    }

    const metric = (g) => (w.mode === 'lapses' ? g.lapses : Math.max(0.01, 1 - g.avgR));
    const items = w.clusters.map((g, i) => ({ value: metric(g), g, i }))
      .filter((x) => x.value > 0);

    const h = clamp(Math.round(width * 0.46), 170, 280);
    const boxes = treemap(items.map((x) => ({ value: x.value, ref: x })), 0, 0, width, h);

    const svg = chart(width, h,
      w.mode === 'lapses'
        ? `Where failures cluster: ${plural(w.totalLapses, 'lapse')} across `
          + `${plural(w.clusters.length, 'topic')}. Largest is ${w.clusters[0].title} with `
          + `${plural(w.clusters[0].lapses, 'lapse')}.`
        : `Weakest topics by predicted recall across ${plural(w.clusters.length, 'topic')}. `
          + `Lowest is ${w.clusters[0].title} at ${pct(w.clusters[0].avgR)}.`);

    for (const b of boxes) {
      const x = b.item.ref;
      const g = x.g;
      const bx = n(b.x) + 1.5;
      const by = n(b.y) + 1.5;
      const bw = Math.max(0, n(b.w) - 3);
      const bh = Math.max(0, n(b.h) - 3);
      const rec = ctx.recordFor(g.number);
      const tip = w.mode === 'lapses'
        ? `${g.number} ${g.title} · ${plural(g.lapses, 'lapse')} across ${plural(g.seen, 'card')} · recall ${pct(g.avgR)}`
        : `${g.number} ${g.title} · recall ${pct(g.avgR)} across ${plural(g.seen, 'card')}`;

      /* The treemap is a redundant view: every cluster in it also appears in
       * the ranked list below, with the same link and the same numbers. So the
       * boxes are deliberately taken out of the tab order and hidden from
       * assistive tech (`tabindex="-1"` + `aria-hidden`) rather than creating a
       * second, unlabelled set of tab stops inside an element that is already
       * `role="img"`. Pointer users get the map; everyone gets the list. */
      const cls = `an-tm-c${(x.i % 8) + 1}`;
      const group = rec
        ? sv('a.an-tm-cell', {
          href: `#/item/${encodeURIComponent(rec.id)}`,
          tabindex: '-1', 'aria-hidden': 'true',
        })
        : sv('g.an-tm-cell', { 'aria-hidden': 'true' });
      group.setAttribute('data-tip', tip);
      group.append(sv(`rect.an-tm-box.${cls}`, {
        x: r1(bx), y: r1(by), width: r1(bw), height: r1(bh), rx: 6,
      }));
      titled(group, tip);

      // Only label a box that can hold the label. Everything else relies on the
      // tooltip, the title and the ranked list underneath — an unreadable
      // 9px-clipped label is worse than none.
      if (bw > 62 && bh > 34) {
        group.append(sv('text.an-tm-num', { x: r1(bx + 8), y: r1(by + 17), text: g.number }));
        const room = Math.floor(div(bw - 16, 6.4, 8));
        group.append(sv('text.an-tm-name', {
          x: r1(bx + 8), y: r1(by + 32),
          text: g.title.length > room ? `${g.title.slice(0, Math.max(3, room - 1))}…` : g.title,
        }));
        if (bh > 54) {
          group.append(sv('text.an-tm-val', {
            x: r1(bx + 8), y: r1(by + 48),
            text: w.mode === 'lapses' ? `${plural(g.lapses, 'lapse')} · ${pct(g.avgR)}`
              : `recall ${pct(g.avgR)}`,
          }));
        }
      }
      svg.append(group);
    }

    const threadRow = (t) => {
      const label = t.kind === 'module'
        ? (ctx.moduleLabel(t.key) || t.key)
        : t.key;
      const names = t.clusters.map((k) => {
        const g = w.clusters.find((c) => c.key === k);
        return g ? `${g.number} ${g.title}` : k;
      });
      return el('.conn-thread', {}, [
        el(`span.chip.chip-thread.${t.kind === 'module' ? 'is-module' : 'is-tag'}`, { text: label }),
        el('span.conn-thread-sub', {
          text: `${t.clusters.length} of your ${w.clusters.length} weak spots`
            + `${t.elsewhere ? `, but only ${t.elsewhere} other ${t.elsewhere === 1 ? 'topic' : 'topics'} you have studied` : ', and nothing else you have studied'}`
            + ` — ${names.join(', ')}`,
        }),
      ]);
    };

    const rankRow = (g, i) => {
      const rec = ctx.recordFor(g.number);
      const maxMetric = Math.max(...w.clusters.map(metric), 1);
      const frac = clamp(div(metric(g), maxMetric, 0), 0, 1);
      const body = [
        el('.conn-rank', { text: String(i + 1) }),
        el('.conn-main', {}, [
          el('.conn-name', { text: `${g.number} ${g.title}` }),
          el('.meter.conn-meter', {}, [el('i', {
            style: { width: `${r1(frac * 100)}%` },
            class: w.mode === 'lapses' ? 'is-bad' : 'is-warn',
          })]),
          el('.chip-row.conn-tags', {}, [
            ...g.tagList.slice(0, 3).map((t) => el('span.chip.chip-thread.is-tag', { text: t })),
            ...g.moduleList.filter((m) => /^algo-/.test(m)).slice(0, 2)
              .map((m) => el('span.chip.chip-thread.is-module', { text: ctx.moduleLabel(m) || m })),
          ]),
        ]),
        el('.conn-nums', {}, [
          el('strong', { text: w.mode === 'lapses' ? plural(g.lapses, 'lapse') : pct(g.avgR) }),
          el('span', { text: `${g.seen}/${g.total} seen · recall ${pct(g.avgR)}` }),
        ]),
      ];
      return rec
        ? el('a.conn-row', { href: `#/item/${encodeURIComponent(rec.id)}` }, body)
        : el('.conn-row', {}, body);
    };

    return [
      el('p.an-caption', {
        text: w.mode === 'lapses'
          ? `Your ${plural(w.totalLapses, 'lapse')} are not spread evenly — they bunch around a `
            + `handful of guidelines and drugs. Box area is lapses; tap one to read the source.`
          : `Nothing has lapsed yet, so these are ranked by predicted recall instead: the topics `
            + `closest to slipping. Box area is how far below full recall each one sits.`,
      }),
      el('.an-chart-wrap', {}, [svg]),
      w.threads.length
        ? el('.conn-threads', {}, [
          el('h3.an-sub-title', { text: 'What those topics share' }),
          el('p.an-caption', {
            text: 'These tags link several of your weak spots without covering everything else '
              + 'you have studied — which is what makes them worth chasing. One thing to learn, '
              + 'instead of several to re-read.',
          }),
          ...w.threads.slice(0, 5).map(threadRow),
        ])
        : null,
      el('.conn-list', {}, w.clusters.map(rankRow)),
    ];
  }

  /* ------------------------------------------- 8. difficulty table */

  function hardestPanel(ctx) {
    const rows = hardestCards(ctx.historyQs, ctx.cards, srs, ctx.now, 15);
    if (!rows.length) {
      return [emptyNote('No card history yet.',
        'The cards that fight you hardest — most lapses, least stability — collect here with a link straight to the guideline behind each one.')];
    }
    const anyLapse = rows.some((r) => r.lapses > 0);

    return [
      el('p.an-caption', {
        text: anyLapse
          ? 'Ranked by lapses, then by how fragile the memory still is. These are worth reading in '
            + 'the source rather than grinding in the queue — a card you keep failing usually means '
            + 'the underlying material was never clear.'
          : 'Nothing has lapsed yet, so these are simply your least stable cards — the ones whose '
            + 'memory is still shortest-lived.',
      }),
      el('.hard-list', { role: 'list' }, rows.map((r, i) => {
        const rec = ctx.recordFor(r.q.source && r.q.source.number);
        const label = ctx.label(r.q);
        const body = [
          el('.hard-rank', { text: String(i + 1) }),
          el('.hard-main', {}, [
            el('.hard-stem', { text: r.q.stem || r.q.id }),
            el('.hard-src', { text: label }),
          ]),
          el('.hard-nums', {}, [
            el(`span.chip${r.lapses ? '.chip-lapse' : ''}`, { text: plural(r.lapses, 'lapse') }),
            el('span.chip', { text: `half-life ${humanDays(r.stability)}` }),
            el('span.chip', { text: `recall ${pct(r.r)}` }),
          ]),
        ];
        return rec
          ? el('a.hard-row', { href: `#/item/${encodeURIComponent(rec.id)}`, role: 'listitem' }, body)
          : el('.hard-row', { role: 'listitem' }, body);
      })),
    ];
  }

  /* ======================================================== render */

  function buildContext() {
    const d = dataset();
    const cfg = settings();
    const now = Date.now();
    let log = [];
    try { log = store.getLog() || []; } catch { log = []; }
    let cards = {};
    try { cards = store.allCards() || {}; } catch { cards = {}; }

    /* Scope for the summary and coverage is the learner's enabled modules.
     * Scope for the *history* panels (weak spots, leaderboard) is that union
     * the cards they have actually reviewed. Those two differ whenever a module
     * is turned off after being studied, and hiding a card the learner keeps
     * failing because they toggled its module off would be exactly backwards —
     * "where you keep failing" has to see every failure. */
    let enabledQs = [];
    try { enabledQs = data.enabledQuestions(cfg) || []; } catch { enabledQs = []; }
    const scopeIsAll = !enabledQs.length;
    if (scopeIsAll && d && Array.isArray(d.questions)) enabledQs = d.questions;

    let historyQs = enabledQs;
    if (d && Array.isArray(d.questions)) {
      const inScope = new Set(enabledQs.map((q) => q && q.id));
      const extra = d.questions.filter((q) => q && cards[q.id] && !inScope.has(q.id));
      if (extra.length) historyQs = enabledQs.concat(extra);
    }

    let todayCounts = { new: 0, reviews: 0 };
    try { todayCounts = store.todayCounts() || todayCounts; } catch { /* keep default */ }

    let sum = { total: 0, seen: 0, young: 0, mature: 0, due: 0, newAvail: 0,
                nextDue: null, retention: null };
    try {
      const s = srs.summarize(enabledQs, cards, cfg, todayCounts, now, log);
      if (s && typeof s === 'object') {
        sum = {
          total: n(s.total, 0), seen: n(s.seen, 0), young: n(s.young, 0),
          mature: n(s.mature, 0), due: n(s.due, 0), newAvail: n(s.newAvail, 0),
          nextDue: s.nextDue || null,
          retention: isNum(s.retention) ? s.retention : null,
        };
      }
    } catch { /* defaults */ }

    const seen = seenCards(cards);
    let rSum = 0;
    for (const c of seen) {
      try { rSum += clamp(n(srs.retrievability(c, now), 1), 0, 1); } catch { rSum += 1; }
    }

    return {
      d, cfg, now, log, cards, enabledQs, historyQs, scopeIsAll, sum, seen,
      recallNow: div(rSum, seen.length, 0),
      ls: logStats(log, now),
      recordFor: (num) => {
        if (!num || !d) return null;
        const rec = (d.glByNumber && d.glByNumber.get(num))
          || (d.drugByNumber && d.drugByNumber.get(num)) || null;
        return rec && rec.id ? rec : null;
      },
      moduleLabel: (id) => {
        try { const m = data.moduleById(id); return m && m.label ? m.label : null; }
        catch { return null; }
      },
      label: (q) => {
        try { return data.sourceLabel(q); }
        catch {
          const s = q && q.source;
          return s ? `${s.number || ''} ${s.title || ''}`.trim() : '';
        }
      },
    };
  }

  function render() {
    const width = measure();
    S.lastWidth = width;
    const ctx = buildContext();

    const horizonSeg = el('.seg.an-seg.an-seg-sm', { 'aria-label': 'Forecast horizon' },
      HORIZONS.map((hz) => el('button', {
        type: 'button', text: hz.label,
        'aria-pressed': String(hz.d === S.horizon),
        onclick: () => { S.horizon = hz.d; render(); },
      })));

    const head = el('.page-head', {}, [
      el('h1', { text: 'Analytics' }),
      el('p', {
        text: ctx.ls.total
          ? `${plural(ctx.ls.total, 'review')} across ${plural(ctx.ls.activeDays, 'day')}, `
            + `${plural(ctx.seen.length, 'card')} learned. Everything below is computed from your `
            + `review log in this browser — nothing leaves the device.`
          : 'Nothing has been reviewed yet, so most of this is showing you what it will look like. '
            + 'The forgetting model below works without any history — it is the scheduler\'s own '
            + 'prediction, not a summary of your past.',
      }),
      ctx.scopeIsAll && ctx.d
        ? el('p.an-note', {
          text: 'No modules are enabled, so scope falls back to the whole deck. '
            + 'Enabling modules narrows these numbers to what you are actually studying.',
        })
        : null,
    ]);

    const node = el('.analytics', {}, [
      head,
      panel('headline', 'Where you stand', null, headlinePanel(ctx)),
      panel('heatmap', 'Review activity',
        'Every square is one day. This is the only panel that measures effort rather than memory.',
        heatmapPanel(ctx, width)),
      panel('retention', 'Retention over time',
        'What you actually remembered, week by week, against the target you set.',
        retentionPanel(ctx, width)),
      panel('forgetting', 'Learning and forgetting',
        'The scheduler models memory as a decay curve per card. These are its predictions, not your history.',
        trajectoryPanel(ctx, width), horizonSeg),
      panel('workload', 'Workload forecast',
        'What the schedule has already committed you to over the next 30 days.',
        workloadPanel(ctx, width)),
      panel('coverage', 'Coverage and scope',
        'How much of the document you have touched, and how well it has settled.',
        coveragePanel(ctx, width)),
      panel('connections', 'Where you keep failing',
        'Failures grouped by the guideline or drug behind them, and what those groups have in common.',
        connectionsPanel(ctx, width)),
      panel('hardest', 'Hardest cards',
        'The fifteen cards costing you the most.',
        hardestPanel(ctx)),
    ]);

    S.node = node;
    mount(root, node);
    wireTips(node);
    observe();
  }

  /* --------------------------------------------------- tooltips */

  /**
   * One tooltip per panel, driven by `data-tip` on whatever is hovered or
   * focused. Delegated rather than per-element so a 182-cell heatmap costs two
   * listeners, and positioned inside the panel so it can never push the page
   * wide — a tooltip that causes horizontal scroll on a phone is worse than no
   * tooltip.
   */
  function wireTips(node) {
    for (const p of node.querySelectorAll('.an-panel')) {
      const tip = p.querySelector(':scope > .an-tip');
      if (!tip) continue;
      const hide = () => { tip.classList.remove('is-on'); };
      const show = (ev) => {
        const t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
        if (!t || !p.contains(t)) return hide();
        const txt = t.getAttribute('data-tip');
        if (!txt) return hide();
        tip.textContent = txt;
        tip.classList.add('is-on');
        const pr = p.getBoundingClientRect();
        const tr = t.getBoundingClientRect();
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        let x = tr.left - pr.left + tr.width / 2 - tw / 2;
        x = clamp(x, 6, Math.max(6, pr.width - tw - 6));
        let y = tr.top - pr.top - th - 8;
        if (y < 2) y = tr.bottom - pr.top + 8;
        tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        return undefined;
      };
      p.addEventListener('pointerover', show);
      p.addEventListener('pointerleave', hide);
      p.addEventListener('focusin', show);
      p.addEventListener('focusout', hide);
      p.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
    }
  }

  function observe() {
    if (ro || typeof ResizeObserver !== 'function') return;
    ro = new ResizeObserver(() => onResize());
    try { ro.observe(root); } catch { ro = null; }
  }

  render();
  if (!S.node) toast('Analytics could not render');
}

/** Pure helpers, exported for the test script. Not part of the app's API. */
export const _analytics = {
  logStats, streakFrom, bestStreakFrom, heatmapGrid, heatLevel, retentionWeekly,
  sampleCurve, aggregateDecay, aggregateWithReviews, learningLadder,
  coverageFor, weakClusters, treemap, hardestCards, seenCards, maturity,
  strided, path, areaPath, div, clamp,
};

export default mountAnalytics;

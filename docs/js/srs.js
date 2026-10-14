/**
 * srs.js — the scheduler and the learner model.
 *
 * This is an implementation of FSRS-5 (Free Spaced Repetition Scheduler),
 * not SM-2. The difference matters for this app specifically.
 *
 * SM-2 carries one number per card (an ease factor) and multiplies the
 * interval by it. It has no notion of *how likely you are to remember this
 * card right now* — it only knows when it last decided to show it. You cannot
 * draw a forgetting curve from SM-2 state, because SM-2 never models one.
 *
 * FSRS carries two numbers per card and they mean separate things:
 *
 *   stability  (S) — memory half-life, expressed in days. Concretely: the
 *                    number of days after a review at which predicted recall
 *                    has fallen to 90%. Big S = durable memory. S grows every
 *                    time you successfully recall the card, and collapses when
 *                    you forget it.
 *
 *   difficulty (D) — 1..10, how hard *this particular item* is for *this
 *                    learner*. D does not decay with time; it is a property of
 *                    the material-plus-person pair. High D means every
 *                    successful review buys less stability than it would for an
 *                    easy card. "What is the adult epinephrine dose in cardiac
 *                    arrest" is a low-D card. "Which of these four
 *                    similar-looking mcg/min infusion ranges belongs to which
 *                    pressor" is a high-D card, and it should keep coming back
 *                    more often forever, not just until you get it right once.
 *
 * Separating the two is what lets the analytics view answer two different
 * questions — "how fast is this learner acquiring the material" (trajectory,
 * driven by D and by stability growth rates) and "what will they still know in
 * three weeks" (the forgetting curve, driven by S). That was the explicit ask
 * in the brief, so FSRS it is.
 *
 * Purity: nothing in this file touches localStorage, the network, or the DOM.
 * `schedule()` returns a brand-new card object; the quiz is responsible for
 * handing that to `store.putCard`. This is deliberate — a pure scheduler can be
 * replayed over the review log to re-derive every card's state, which is how
 * the analytics module reconstructs history, and it means a scheduling bug can
 * never corrupt saved progress on its own.
 *
 * Robustness: every exported function treats its card argument as hostile.
 * Imported progress files, a half-written localStorage record, a card from a
 * future schema — any of these can arrive malformed. A throw here would kill
 * the learner's whole session mid-review, so malformed input is repaired into a
 * sane fresh card instead.
 */

/** Grade buttons. These values are persisted in the review log — never renumber. */
export const RATINGS = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

/**
 * FSRS-5 default weight vector (19 parameters), as published by the FSRS
 * project (open-spaced-repetition/fsrs-rs, `DEFAULT_PARAMETERS`). These are the
 * values fitted against the aggregate of a very large public review dataset;
 * they are the right starting point for a learner with no history of their own.
 *
 * Exported so the analytics view (and anyone reading this code) can inspect
 * what the model is actually assuming. Roughly, by index:
 *
 *   w0..w3   initial stability for a first rating of Again/Hard/Good/Easy,
 *            in days. Note w0 = 0.40 days: a card you failed on first contact
 *            is assumed to be ~10 hours from 90% recall. w3 = 15.7 days: a card
 *            you found trivially easy on first contact is already durable.
 *   w4, w5   initial difficulty curve. D0(g) = w4 - e^(w5*(g-1)) + 1.
 *   w6       how far one grade moves difficulty.
 *   w7       mean-reversion weight for difficulty (see updateDifficulty).
 *   w8..w10  stability gain on a successful recall: scale, the penalty for
 *            high difficulty / already-high stability, and the bonus for having
 *            recalled it when recall was unlikely.
 *   w11..w14 post-lapse stability.
 *   w15      Hard penalty (a "Hard" success earns less than a "Good").
 *   w16      Easy bonus.
 *   w17, w18 same-day ("short-term") stability change — the learning-steps
 *            regime, new in FSRS-5, where elapsed time is too small for the
 *            long-term formulas to be meaningful.
 */
export const DEFAULT_W = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105,
  7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395,
  0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621,
]);

/**
 * The forgetting curve.
 *
 * FSRS used to model forgetting as a pure exponential, R = 0.9^(t/S), which is
 * what you get if a memory has a constant per-unit-time chance of decaying.
 * Fitting against real review data showed that is wrong in a specific way:
 * exponential decay is too pessimistic in the long tail. Memories that survive
 * a long time keep surviving — the hazard rate falls as the memory ages. That
 * is the shape of a *power* function, not an exponential, and it is the same
 * result Wickelgren and others found in the retention literature.
 *
 * So FSRS-4.5 onward uses the power forgetting curve
 *
 *     R(t) = (1 + FACTOR * t/S) ^ DECAY
 *
 * with DECAY = -0.5. FACTOR is not free: it is pinned so that the definition of
 * stability still holds exactly, i.e. R(S) = 0.9. Solving
 * (1 + FACTOR)^DECAY = 0.9 gives FACTOR = 0.9^(1/DECAY) - 1 = 19/81.
 *
 * Practical consequence: the tail is fatter, so long intervals get longer than
 * an exponential model would allow, and the learner does fewer reviews for the
 * same retention. That is the whole point of using a fitted model.
 */
const DECAY = -0.5;
const FACTOR = 19 / 81;        // = 0.9^(1/DECAY) - 1, exactly 0.2345679…

const MIN_STABILITY = 0.1;     // days; floor so S^-w9 and logs stay finite
const MAX_INTERVAL = 36500;    // 100 years — the contract's upper clamp
const MIN_INTERVAL = 1;        // review-state intervals are whole days up
const MATURE_DAYS = 21;        // stability threshold for young vs mature
const DAY_MS = 86400000;
const MIN_MS = 60000;

/* Sub-day steps. Learning and relearning cards come back inside the session
 * rather than being handed a multi-day interval off a stability value that was
 * computed from a single data point. These are deliberately short: the job of a
 * learning step is to get one clean successful recall before the card is
 * trusted to the long-term scheduler. */
const LEARN_STEP_AGAIN = 1 / 1440;      // 1 minute
const LEARN_STEP_HARD = 6 / 1440;       // 6 minutes
const RELEARN_STEP_AGAIN = 1 / 1440;    // 1 minute
const RELEARN_STEP_HARD = 10 / 1440;    // 10 minutes

/* ------------------------------------------------------------- utilities */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** Coerce anything date-ish into epoch ms, falling back to the current time. */
function ms(t) {
  if (t === undefined || t === null) return Date.now();
  if (t instanceof Date) { const v = t.getTime(); return isFinite(v) ? v : Date.now(); }
  if (typeof t === 'number') return isFinite(t) ? t : Date.now();
  const v = Date.parse(t);
  return isFinite(v) ? v : Date.now();
}

const iso = (msVal) => new Date(msVal).toISOString();

/** Local-calendar day key, matching store.todayKey so the two agree on "today". */
function dayKeyLocal(msVal) {
  const d = new Date(msVal);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Validate a caller-supplied weight vector, else fall back to the defaults. */
function weights(opts) {
  const w = opts && opts.w;
  if (Array.isArray(w) && w.length >= 19 && w.every(isNum)) return w;
  return DEFAULT_W;
}

function retentionTarget(opts) {
  const r = opts && opts.desiredRetention;
  // Outside roughly 0.7–0.99 the interval maths stops being useful (and at 1.0
  // it diverges), so clamp rather than trusting a stray setting value.
  return isNum(r) ? clamp(r, 0.7, 0.99) : 0.9;
}

const STATES = new Set(['new', 'learning', 'review', 'relearning']);

/**
 * Repair a possibly-malformed card into something the maths can run on.
 * Anything unreadable is replaced with the fresh-card value for that field, so
 * a corrupt record degrades to "treat this as new" instead of throwing.
 */
function normalize(card) {
  if (!card || typeof card !== 'object') return initCard();
  const state = STATES.has(card.state) ? card.state : (isNum(card.stability) ? 'review' : 'new');
  const out = {
    due: typeof card.due === 'string' && isFinite(Date.parse(card.due)) ? card.due : null,
    stability: isNum(card.stability) && card.stability > 0
      ? clamp(card.stability, MIN_STABILITY, MAX_INTERVAL) : null,
    difficulty: isNum(card.difficulty) ? clamp(card.difficulty, 1, 10) : null,
    reps: isNum(card.reps) && card.reps >= 0 ? Math.floor(card.reps) : 0,
    lapses: isNum(card.lapses) && card.lapses >= 0 ? Math.floor(card.lapses) : 0,
    state,
    lastReview: typeof card.lastReview === 'string' && isFinite(Date.parse(card.lastReview))
      ? card.lastReview : null,
    elapsed: isNum(card.elapsed) ? card.elapsed : 0,
    scheduled: isNum(card.scheduled) ? card.scheduled : 0,
  };
  // A card claiming to be a review card with no stability is not usable as one.
  if (out.state !== 'new' && (out.stability === null || out.difficulty === null)) {
    out.state = 'new';
    out.stability = null;
    out.difficulty = null;
  }
  return out;
}

/* ---------------------------------------------------------- FSRS kernel */

/** S0: stability immediately after the very first grade, in days. */
function initialStability(w, rating) {
  return clamp(w[rating - 1], MIN_STABILITY, MAX_INTERVAL);
}

/**
 * D0: difficulty immediately after the very first grade.
 * Exponential in the grade, so the gap between Again and Hard is much larger
 * than the gap between Good and Easy — failing on first contact is strong
 * evidence the item is hard, whereas "Easy" vs "Good" is largely self-report.
 */
function initialDifficulty(w, rating) {
  return clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
}

/**
 * Difficulty update, with the two corrections that keep D well-behaved.
 *
 * 1. Linear damping, the `(10 - D) / 9` term. Without it, repeated Agains walk
 *    D straight into the 10 clamp and it sticks there. Damping makes each step
 *    smaller as D approaches the ceiling, so D saturates smoothly instead of
 *    pinning.
 *
 * 2. Mean reversion toward D0(Easy), weighted by w7. This exists because
 *    difficulty estimated from a handful of grades is noisy, and because the
 *    grades themselves are biased: learners press Again more readily than Easy.
 *    Left alone, D ratchets upward over a card's life and never comes back
 *    down, which would permanently over-schedule material the learner has
 *    actually mastered. The reversion is a slow pull (w7 ≈ 0.005, so ~0.5% of
 *    the way per review) toward the difficulty of a card someone found easy on
 *    first sight. It is the prior fighting the noise.
 */
function updateDifficulty(w, difficulty, rating) {
  const deltaD = -w[6] * (rating - 3);
  const damped = difficulty + deltaD * ((10 - difficulty) / 9);
  const reverted = w[7] * initialDifficulty(w, RATINGS.EASY) + (1 - w[7]) * damped;
  return clamp(reverted, 1, 10);
}

/**
 * Stability after a successful recall (Hard, Good or Easy).
 *
 *   S' = S * (1 + e^w8 * (11 - D) * S^(-w9) * (e^(w10*(1-R)) - 1) * hard * easy)
 *
 * Read the three middle terms as the three things that determine how much a
 * review is worth:
 *
 *   (11 - D)        easy cards gain more stability per review than hard ones.
 *   S^(-w9)         diminishing returns: the more durable a memory already is,
 *                   the less one more review adds. This is why intervals grow
 *                   by a shrinking multiplier instead of a fixed 2.5x.
 *   e^(w10*(1-R))-1 the spacing effect, and the most important term here.
 *                   R is how likely you were to remember at the moment you were
 *                   asked. Recalling something you were 95% likely to remember
 *                   teaches you almost nothing (the term → 0); recalling
 *                   something you were only 70% likely to remember is a large
 *                   stability gain. Reviewing too early is close to wasted
 *                   effort, and this term is where that falls out of the model
 *                   rather than being asserted.
 */
function stabilityAfterRecall(w, difficulty, stability, r, rating) {
  const hardPenalty = rating === RATINGS.HARD ? w[15] : 1;
  const easyBonus = rating === RATINGS.EASY ? w[16] : 1;
  const gain = Math.exp(w[8])
    * (11 - difficulty)
    * Math.pow(stability, -w[9])
    * (Math.exp(w[10] * (1 - r)) - 1)
    * hardPenalty
    * easyBonus;
  return clamp(stability * (1 + gain), MIN_STABILITY, MAX_INTERVAL);
}

/**
 * Stability after a lapse (Again).
 *
 *   S' = w11 * D^(-w12) * ((S+1)^w13 - 1) * e^(w14*(1-R))
 *
 * Note what this is *not*: it is not S multiplied by some penalty factor. Post-
 * lapse stability is computed largely from scratch, which is correct — once you
 * have forgotten the item, the fact that it used to be stable for 200 days
 * tells you very little about how long it will survive now. The `(S+1)^w13`
 * term (w13 ≈ 0.30) keeps a faint memory of the old stability, so a card you
 * had known for a year comes back slightly stronger than one you had known for
 * a week, but only slightly.
 *
 * The result is additionally floored under the previous stability: a lapse must
 * never leave a card more durable than it was before the learner forgot it.
 * Without that guard, a long-overdue card with a very low R can come out of the
 * formula with S' > S, which would be nonsense to show a learner.
 */
function stabilityAfterLapse(w, difficulty, stability, r) {
  const s = w[11]
    * Math.pow(difficulty, -w[12])
    * (Math.pow(stability + 1, w[13]) - 1)
    * Math.exp(w[14] * (1 - r));
  return clamp(Math.min(s, stability), MIN_STABILITY, MAX_INTERVAL);
}

/**
 * Same-day stability change. When a card is re-graded within a day of its last
 * review, elapsed time is far below S and the long-term formulas are being
 * asked to extrapolate from a region they were not fitted on. FSRS-5 handles
 * that regime separately: S' = S * e^(w17 * (G - 3 + w18)). Again shrinks S,
 * Good nudges it up, Easy more so.
 */
function stabilityShortTerm(w, stability, rating) {
  const s = stability * Math.exp(w[17] * (rating - 3 + w[18]));
  return clamp(s, MIN_STABILITY, MAX_INTERVAL);
}

/**
 * Invert the forgetting curve: the interval at which predicted recall will have
 * decayed to `target`.
 *
 *   R = (1 + FACTOR*t/S)^DECAY   →   t = S/FACTOR * (R^(1/DECAY) - 1)
 *
 * At target = 0.9 this returns exactly S, which is the definition of stability.
 * Raise the target and intervals shorten sharply; this is the one knob the
 * learner actually has, and it is the honest one — it trades review volume
 * against how much they forget.
 */
function intervalForRetention(stability, target) {
  const t = (stability / FACTOR) * (Math.pow(target, 1 / DECAY) - 1);
  return isFinite(t) && t > 0 ? t : MIN_INTERVAL;
}

/* ------------------------------------------------------------------ fuzz */

/**
 * Deterministic pseudo-random in [0,1) derived from the card's own state
 * (FNV-1a over a few fields). Using the card's state rather than Math.random
 * keeps `schedule()` pure and referentially transparent: replaying the review
 * log reproduces exactly the same due dates, which the analytics module relies
 * on, and tests do not flake.
 */
function cardNoise(card, rating) {
  const s = `${card.reps}|${card.lapses}|${card.lastReview || ''}|`
    + `${(card.stability || 0).toFixed(4)}|${(card.difficulty || 0).toFixed(4)}|${rating}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Spread intervals slightly so that cards learned on the same day do not all
 * come due on the same day forever. Without fuzz, a learner who enables a
 * module on Monday gets a recurring Monday spike that grows into an
 * unmanageable cliff — exactly the failure `workloadForecast` is there to make
 * visible. The band widens for short intervals (where a day either way matters
 * little) and narrows for long ones (where ±5% is already days).
 */
function fuzzInterval(days, noise) {
  if (days < 2.5) return days;
  const ratio = days < 7 ? 0.15 : days < 20 ? 0.10 : 0.05;
  const spread = Math.max(1, days * ratio);
  const fuzzed = days - spread + noise * (2 * spread);
  return clamp(fuzzed, MIN_INTERVAL, MAX_INTERVAL);
}

/* --------------------------------------------------------------- exports */

/**
 * A fresh, never-reviewed card.
 * @returns {{due: null, stability: null, difficulty: null, reps: number,
 *            lapses: number, state: 'new', lastReview: null,
 *            elapsed: number, scheduled: number}}
 */
export function initCard() {
  return {
    due: null,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    state: 'new',
    lastReview: null,
    elapsed: 0,
    scheduled: 0,
  };
}

/**
 * Predicted probability of recalling this card right now, 0..1.
 *
 * Returns 1 for a card that has never been reviewed or whose state is
 * unreadable — "we have no evidence of decay" is the safe answer, and it keeps
 * callers from having to null-check before charting.
 *
 * @param {object} card  card record (tolerates malformed input)
 * @param {Date|number|string} [now]
 * @returns {number} 0..1
 */
export function retrievability(card, now) {
  const c = normalize(card);
  if (c.state === 'new' || !c.lastReview || c.stability === null) return 1;
  const elapsedDays = Math.max(0, (ms(now) - Date.parse(c.lastReview)) / DAY_MS);
  const r = Math.pow(1 + FACTOR * (elapsedDays / c.stability), DECAY);
  return clamp(isFinite(r) ? r : 1, 0, 1);
}

/**
 * Grade a card. Pure: returns a new card object and mutates nothing.
 *
 * @param {object} card    current card record, or null/garbage for a new card
 * @param {number} rating  1 Again | 2 Hard | 3 Good | 4 Easy
 * @param {Date|number|string} [now]  review timestamp
 * @param {{desiredRetention?: number, w?: number[]}} [opts]
 * @returns {object} the next card record, shaped per DATA_CONTRACT section 4
 */
export function schedule(card, rating, now, opts) {
  const w = weights(opts);
  const target = retentionTarget(opts);
  const g = [1, 2, 3, 4].includes(rating) ? rating : RATINGS.GOOD;
  const nowMs = ms(now);
  const prev = normalize(card);

  const elapsedDays = prev.lastReview
    ? Math.max(0, (nowMs - Date.parse(prev.lastReview)) / DAY_MS)
    : 0;
  const r = retrievability(prev, nowMs);

  let stability;
  let difficulty;

  if (prev.state === 'new' || prev.stability === null || prev.difficulty === null) {
    // First contact: seed S and D straight from the weight vector.
    stability = initialStability(w, g);
    difficulty = initialDifficulty(w, g);
  } else {
    difficulty = updateDifficulty(w, prev.difficulty, g);
    if (elapsedDays < 1) {
      // Same-day regrade (learning steps, or a card answered twice in a
      // session). The long-term formulas are not valid at t ≈ 0.
      stability = stabilityShortTerm(w, prev.stability, g);
    } else if (g === RATINGS.AGAIN) {
      stability = stabilityAfterLapse(w, difficulty, prev.stability, r);
    } else {
      stability = stabilityAfterRecall(w, difficulty, prev.stability, r, g);
    }
  }

  // ---- state machine + interval ----------------------------------------
  let state;
  let intervalDays;
  const graduate = () => {
    const raw = intervalForRetention(stability, target);
    const clamped = clamp(raw, MIN_INTERVAL, MAX_INTERVAL);
    return clamp(fuzzInterval(clamped, cardNoise(prev, g)), MIN_INTERVAL, MAX_INTERVAL);
  };

  let lapses = prev.lapses;

  if (prev.state === 'new') {
    if (g === RATINGS.EASY) {
      state = 'review';
      intervalDays = graduate();
    } else {
      state = 'learning';
      intervalDays = g === RATINGS.AGAIN ? LEARN_STEP_AGAIN
        : g === RATINGS.HARD ? LEARN_STEP_HARD
        : 10 / 1440;               // Good on first sight: back in 10 minutes
    }
  } else if (prev.state === 'learning' || prev.state === 'relearning') {
    const relearning = prev.state === 'relearning';
    if (g === RATINGS.AGAIN) {
      state = prev.state;
      intervalDays = relearning ? RELEARN_STEP_AGAIN : LEARN_STEP_AGAIN;
    } else if (g === RATINGS.HARD) {
      state = prev.state;
      intervalDays = relearning ? RELEARN_STEP_HARD : LEARN_STEP_HARD;
    } else {
      // One clean recall is enough to hand the card to the long-term scheduler.
      state = 'review';
      intervalDays = graduate();
    }
  } else {
    // review
    if (g === RATINGS.AGAIN) {
      state = 'relearning';
      lapses = prev.lapses + 1;
      intervalDays = RELEARN_STEP_AGAIN;
    } else {
      state = 'review';
      intervalDays = graduate();
    }
  }

  return {
    due: iso(nowMs + Math.round(intervalDays * DAY_MS)),
    stability: Math.round(stability * 10000) / 10000,
    difficulty: Math.round(difficulty * 10000) / 10000,
    reps: prev.reps + 1,
    lapses,
    state,
    lastReview: iso(nowMs),
    elapsed: Math.round(elapsedDays * 100) / 100,
    scheduled: Math.round(intervalDays * 10000) / 10000,
  };
}

/**
 * What each button would do, in days, without committing to any of them.
 * Used to label the grade buttons so the learner can see the consequence of
 * their self-assessment rather than guessing at it.
 *
 * @param {object} card
 * @param {Date|number|string} [now]
 * @param {{desiredRetention?: number, w?: number[]}} [opts]
 * @returns {{1: number, 2: number, 3: number, 4: number}} days until next due
 */
export function intervalPreview(card, now, opts) {
  const nowMs = ms(now);
  const out = {};
  for (const rating of [1, 2, 3, 4]) {
    let days;
    try {
      const next = schedule(card, rating, nowMs, opts);
      days = (Date.parse(next.due) - nowMs) / DAY_MS;
    } catch {
      days = MIN_INTERVAL;
    }
    out[rating] = isNum(days) && days > 0 ? days : MIN_INTERVAL;
  }
  return out;
}

/* ----------------------------------------------------------- queue build */

function queueSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    dailyNew: isNum(s.dailyNew) ? Math.max(0, Math.floor(s.dailyNew)) : 15,
    dailyMax: isNum(s.dailyMax) ? Math.max(1, Math.floor(s.dailyMax)) : 120,
    desiredRetention: isNum(s.desiredRetention) ? s.desiredRetention : 0.9,
  };
}

function counts(todayCounts) {
  const t = todayCounts && typeof todayCounts === 'object' ? todayCounts : {};
  return {
    new: isNum(t.new) ? Math.max(0, t.new) : 0,
    reviews: isNum(t.reviews) ? Math.max(0, t.reviews) : 0,
  };
}

function isNewRecord(card) {
  return !card || typeof card !== 'object' || !card.due || card.state === 'new'
    || !isNum(card.stability);
}

/**
 * Build today's study queue.
 *
 * Ordering policy, and why:
 *  - Due reviews come first, most overdue first. An overdue card is the one
 *    whose retrievability is lowest and still falling, so it is both the most
 *    at risk and (per the spacing-effect term in stabilityAfterRecall) the most
 *    valuable review available.
 *  - New cards are interleaved among the reviews rather than stacked at the
 *    front or the back. Front-loading new material means the learner meets all
 *    the hard, unfamiliar items while fresh and then grinds through reviews
 *    while tired; back-loading means new material is met at the point of lowest
 *    attention, and in practice means it is skipped. Interleaving also spaces
 *    the first and second exposure of a new card, since learning-step cards
 *    re-enter the session a few minutes later.
 *  - `dailyNew` bounds intake; `dailyMax` bounds the whole session. Both are
 *    reduced by what has already been done today, so reopening the app
 *    mid-session does not reset the caps.
 *  - If nothing is due and no new cards are left, the queue falls back to the
 *    soonest-due cards flagged `ahead: true`, so "study anyway" works but the
 *    quiz can tell the learner they are reviewing early (and that doing so buys
 *    them less than waiting would).
 *
 * @param {Array<{id: string}>} questions  in-scope questions (already filtered
 *   by enabled modules and confidence by data.js)
 * @param {Record<string, object>} cards  id -> card record
 * @param {object} settings  reads dailyNew, dailyMax
 * @param {{new?: number, reviews?: number}} todayCounts
 * @param {Date|number|string} [now]
 * @returns {Array<{q: object, card: object, isNew: boolean, ahead: boolean,
 *                  overdue: number}>}
 */
export function buildQueue(questions, cards, settings, todayCounts, now) {
  const qs = Array.isArray(questions) ? questions.filter((q) => q && q.id) : [];
  const map = cards && typeof cards === 'object' ? cards : {};
  const cfg = queueSettings(settings);
  const done = counts(todayCounts);
  const nowMs = ms(now);

  const totalCap = Math.max(0, cfg.dailyMax - done.reviews);
  const newCap = Math.max(0, cfg.dailyNew - done.new);
  if (totalCap === 0) return [];

  const due = [];
  const fresh = [];
  const upcoming = [];

  for (const q of qs) {
    const rec = map[q.id];
    if (isNewRecord(rec)) {
      fresh.push({ q, card: rec && typeof rec === 'object' ? rec : null, isNew: true, ahead: false, overdue: 0 });
      continue;
    }
    const dueMs = Date.parse(rec.due);
    if (!isFinite(dueMs)) {
      // Unreadable due date: safest is to surface it now rather than lose it.
      due.push({ q, card: rec, isNew: false, ahead: false, overdue: 0 });
      continue;
    }
    const overdue = (nowMs - dueMs) / DAY_MS;
    if (dueMs <= nowMs) due.push({ q, card: rec, isNew: false, ahead: false, overdue });
    else upcoming.push({ q, card: rec, isNew: false, ahead: true, overdue });
  }

  // Most overdue first; ties broken by id so the order is stable across reloads.
  due.sort((a, b) => (b.overdue - a.overdue) || (a.q.id < b.q.id ? -1 : 1));
  // New cards in question order, which is document order — section 5 before
  // section 12 — so related material arrives together.
  fresh.sort((a, b) => (a.q.id < b.q.id ? -1 : 1));

  if (!due.length && !fresh.length) {
    upcoming.sort((a, b) => Date.parse(a.card.due) - Date.parse(b.card.due));
    return upcoming.slice(0, totalCap);
  }

  // Share the session budget. Reviews have priority, but not absolute
  // priority: a slice of the session (up to NEW_RESERVE of it) is reserved for
  // new material first. Without that reservation, a learner carrying a backlog
  // larger than dailyMax would see nothing but reviews forever and could never
  // progress through the deck — the queue would be "correct" and the app
  // useless. The reserve is a minority share, so clearing a backlog still
  // dominates the session.
  const NEW_RESERVE = 0.3;
  const reserve = Math.min(fresh.length, newCap, Math.ceil(totalCap * NEW_RESERVE));
  const reviewTake = Math.min(due.length, Math.max(0, totalCap - reserve));
  const newTake = Math.min(fresh.length, newCap, Math.max(0, totalCap - reviewTake));

  const picked = due.slice(0, reviewTake);
  const newPicked = fresh.slice(0, newTake);

  // Bresenham-style interleave: at each slot, take a new card only once its
  // share of the emitted queue has fallen behind its share of the total. With
  // 10 reviews and 5 new this yields R R N R R N … rather than N N N N N R R …
  const out = [];
  const R = picked.length;
  const N = newPicked.length;
  let ri = 0;
  let ni = 0;
  while (ri < R || ni < N) {
    const takeNew = ni < N && (ri >= R || (ni + 1) * (R + N) <= (ri + ni + 1) * N);
    if (takeNew) out.push(newPicked[ni++]);
    else out.push(picked[ri++]);
  }
  return out.slice(0, totalCap);
}

/* -------------------------------------------------------------- summary */

/**
 * Pull a review log out of whichever argument carries it. main.js calls
 * `summarize(qs, cards, settings, todayCounts)` with four arguments, so the log
 * has to be optional and discoverable: it may arrive as the 6th parameter, in
 * place of `now` (5th), or stashed on `settings._log`. Absent → retention null.
 */
function resolveLog(settings, now, log) {
  if (Array.isArray(log)) return log;
  if (Array.isArray(now)) return now;
  if (settings && Array.isArray(settings._log)) return settings._log;
  if (settings && Array.isArray(settings.log)) return settings.log;
  return null;
}

/**
 * Headline numbers for the home screen.
 *
 * `retention` is measured, not predicted: the share of the last 30 days' graded
 * reviews that scored Good or better. It is the honest counterweight to the
 * model's own predictions — if the model says 90% and this says 72%, the model
 * is wrong about this learner and the target retention setting needs lowering
 * (or the daily new-card rate does). Returns null when no log is supplied or
 * the window is empty, which the shell renders as an em dash rather than a
 * misleading 0%.
 *
 * `young` vs `mature` splits on 21 days of stability: a card is mature once a
 * three-week gap still leaves 90% recall. It is a progress signal that cannot
 * be gamed by cramming, unlike "cards seen".
 *
 * @param {Array<{id: string}>} questions  in-scope questions
 * @param {Record<string, object>} cards
 * @param {object} settings
 * @param {{new?: number, reviews?: number}} todayCounts
 * @param {Date|number|string|Array} [now]  timestamp, or the log itself
 * @param {Array<{t: string, rating: number}>} [log]  review log
 * @returns {{total: number, seen: number, young: number, mature: number,
 *            due: number, newAvail: number, nextDue: (string|null),
 *            retention: (number|null)}}
 */
export function summarize(questions, cards, settings, todayCounts, now, log) {
  const qs = Array.isArray(questions) ? questions.filter((q) => q && q.id) : [];
  const map = cards && typeof cards === 'object' ? cards : {};
  const cfg = queueSettings(settings);
  const done = counts(todayCounts);
  const nowMs = Array.isArray(now) ? Date.now() : ms(now);
  const reviewLog = resolveLog(settings, now, log);

  let seen = 0;
  let young = 0;
  let mature = 0;
  let dueCount = 0;
  let unseen = 0;
  let nextDueMs = Infinity;

  for (const q of qs) {
    const rec = map[q.id];
    if (isNewRecord(rec)) {
      // A card record that exists but is still in 'new' state has never been
      // graded, so it is not "seen" — it is still available as new material.
      unseen += 1;
      continue;
    }
    seen += 1;
    if (rec.stability >= MATURE_DAYS) mature += 1; else young += 1;
    const dueMs = Date.parse(rec.due);
    if (!isFinite(dueMs) || dueMs <= nowMs) dueCount += 1;
    else if (dueMs < nextDueMs) nextDueMs = dueMs;
  }

  const newAvail = Math.min(unseen, Math.max(0, cfg.dailyNew - done.new));

  let retention = null;
  if (reviewLog && reviewLog.length) {
    const cutoff = nowMs - 30 * DAY_MS;
    let graded = 0;
    let passed = 0;
    for (const e of reviewLog) {
      if (!e || !isNum(e.rating)) continue;
      const t = Date.parse(e.t);
      if (!isFinite(t) || t < cutoff || t > nowMs + DAY_MS) continue;
      graded += 1;
      if (e.rating >= RATINGS.GOOD) passed += 1;
    }
    if (graded > 0) retention = passed / graded;
  }

  return {
    total: qs.length,
    seen,
    young,
    mature,
    due: dueCount,
    newAvail,
    nextDue: isFinite(nextDueMs) ? iso(nextDueMs) : null,
    retention,
  };
}

/* ------------------------------------------------------- learner model */

/**
 * Sample the card's predicted forgetting curve for charting.
 *
 * `d` is days elapsed since the card's last review (so d = 0 is the moment of
 * review and r = 1), and `r` is predicted recall at that point. Plotting this
 * alongside the scheduled interval is the clearest way to show a learner *why*
 * a card is coming back when it is: the scheduler is picking the point where
 * this curve crosses their target retention.
 *
 * A new or malformed card has no decay to predict, so it returns a flat line at
 * 1 rather than an empty array — charts stay drawable either way.
 *
 * @param {object} card
 * @param {number} [days]  horizon in days
 * @param {number} [samples]  points to emit (inclusive of both ends)
 * @returns {Array<{d: number, r: number}>}
 */
export function forgettingCurve(card, days, samples) {
  const c = normalize(card);
  const horizon = isNum(days) && days > 0 ? Math.min(days, MAX_INTERVAL) : 30;
  const n = isNum(samples) && samples >= 2 ? Math.min(Math.floor(samples), 2000) : 60;
  const s = c.stability === null ? null : c.stability;
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const d = (horizon * i) / n;
    const r = s === null ? 1 : clamp(Math.pow(1 + FACTOR * (d / s), DECAY), 0, 1);
    out.push({ d: Math.round(d * 1000) / 1000, r: Math.round(r * 10000) / 10000 });
  }
  return out;
}

/**
 * How many cards fall due on each of the next `days` calendar days.
 *
 * This is the cliff detector. Spaced repetition failure mode number one is a
 * learner enabling six modules in one afternoon, then meeting 400 cards on a
 * single Tuesday five weeks later and quitting. Charting this makes the cliff
 * visible while it is still weeks away and the daily-new setting can still fix
 * it. Everything already overdue is bucketed into day 0, since that is the
 * backlog the learner actually faces now. Days with no cards are emitted as
 * zeroes so the series is evenly spaced on an axis.
 *
 * @param {Record<string, object>} cards  id -> card record
 * @param {number} [days]  horizon in days (default 30)
 * @param {Date|number|string} [now]
 * @returns {Array<{date: string, count: number}>}  'YYYY-MM-DD', local days
 */
export function workloadForecast(cards, days, now) {
  const map = cards && typeof cards === 'object' ? cards : {};
  const span = isNum(days) && days > 0 ? Math.min(Math.floor(days), 3650) : 30;
  const nowMs = ms(now);

  const buckets = new Map();
  const keys = [];
  for (let i = 0; i < span; i += 1) {
    const k = dayKeyLocal(nowMs + i * DAY_MS);
    keys.push(k);
    buckets.set(k, 0);
  }
  const todayKey = keys[0];

  for (const rec of Object.values(map)) {
    if (isNewRecord(rec)) continue;
    const dueMs = Date.parse(rec.due);
    if (!isFinite(dueMs)) continue;
    // Overdue work is work you have now, not work you had last month.
    const key = dueMs <= nowMs ? todayKey : dayKeyLocal(dueMs);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
  }

  return keys.map((date) => ({ date, count: buckets.get(date) }));
}

/** Constants other modules may want to read rather than re-derive. */
export const _model = Object.freeze({
  DECAY, FACTOR, MATURE_DAYS, MIN_INTERVAL, MAX_INTERVAL, MIN_STABILITY,
});

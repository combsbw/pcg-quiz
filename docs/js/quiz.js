/**
 * quiz.js — the study session. This is the screen the learner actually spends
 * their time in, so everything here is organised around one loop:
 *
 *     start screen  →  (question → answer → grade) × N  →  session complete
 *
 * Design constraints that drove the layout, since they are not obvious from
 * the code alone:
 *
 * - The audience is flight crew, often studying one-handed on a phone between
 *   legs. Every interactive target is a real <button> at least 56px tall and
 *   full width on a narrow screen; the four grade buttons land in a 2×2 block
 *   so both rows stay inside thumb reach rather than a 4-wide strip where the
 *   far button needs a second hand.
 *
 * - The source citation is *hidden until the answer is revealed*. This is not
 *   decoration: 550 of the 2964 questions are `guideline_match` type, whose
 *   stem is a quoted line and whose options are guideline titles — the source
 *   title is literally the correct answer. Showing `sourceLabel()` in the
 *   question header would give those away. Only the "new/review" chip and the
 *   question type are safe to show before the answer.
 *
 * - Option order is rendered exactly as it appears in the data. `answer` is a
 *   fixed index into `options` and the generator already shuffled them; a
 *   render-time shuffle would desynchronise the two.
 *
 * - Nothing here is trusted. A question with fewer than two options, a
 *   non-integer `answer`, an out-of-range `answer` or an empty stem is dropped
 *   from the queue before the session starts (and again defensively at render
 *   time), because a thrown error mid-session costs the learner the whole
 *   session's unsaved work. Every answer is persisted the moment it is graded,
 *   so there is no unsaved work to lose if the tab dies.
 *
 * Interfaces: `mountQuiz(root, deps, route)` per DATA_CONTRACT section 6.
 * Emits `review:logged` after each graded answer and `session:complete` at the
 * end. Scheduling decisions all come from srs.js; this file never does date
 * maths on a card beyond formatting what `intervalPreview` returns.
 */

import { el, mount, toast, humanDays, plural, pct, confirmDialog } from './ui.js';
import { navigate } from './router.js';

/* ------------------------------------------------------------- constants */

/** Grade buttons, in key order. `key` is both the shown digit and the hotkey. */
const GRADES = [
  { r: 1, key: '1', label: 'Again', hint: 'forgot it',  tone: 'bad' },
  { r: 2, key: '2', label: 'Hard',  hint: 'a struggle', tone: 'warn' },
  { r: 3, key: '3', label: 'Good',  hint: 'recalled',   tone: 'ok' },
  { r: 4, key: '4', label: 'Easy',  hint: 'instant',    tone: 'ok' },
];

/** Plain-English wording for a question whose generation was not certain. */
const CONFIDENCE_NOTE = {
  medium: 'Auto-generated — verify against the source text below.',
  low: 'Low confidence — this item may be imprecise. Trust the source, not the question.',
};

/** Human labels for the generator's question types. */
const TYPE_LABEL = {
  drug_dose: 'Dose',
  drug_indication: 'Indication',
  drug_info: 'Drug information',
  care_level_scope: 'Scope of practice',
  guideline_step: 'Guideline step',
  guideline_match: 'Which guideline',
  max_dose: 'Maximum dose',
  route: 'Route',
  compare: 'Comparison',
};

/* Fallback per-card time estimates, used until the learner's own review log
 * has enough entries to measure from. A review of familiar material runs
 * ~12s; first contact with a new card takes longer because the learner reads
 * the explanation and the source snippet. */
const EST_REVIEW_MS = 13000;
const NEW_MULTIPLIER = 1.7;

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/* One session at a time. Module-level so a re-mount (the learner navigating
 * away and back) can detach the previous session's listeners. Nothing here
 * touches `document` at module scope — the file must be importable in a
 * DOM-less environment for parse checks. */
let activeTeardown = null;

/* ------------------------------------------------------------- utilities */

/**
 * Is this question renderable? Anything false here is dropped from the queue
 * rather than crashing the session.
 */
function usable(q) {
  return !!q
    && typeof q.id === 'string'
    && typeof q.stem === 'string' && q.stem.trim().length > 0
    && Array.isArray(q.options)
    && q.options.length >= 2
    && q.options.every((o) => typeof o === 'string')
    && Number.isInteger(q.answer)
    && q.answer >= 0
    && q.answer < q.options.length;
}

/** "45s", "6 min", "1h 10m" — for session estimates and elapsed time. */
function fmtDuration(msTotal) {
  const s = Math.max(0, Math.round(msTotal / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Median answer time from the learner's own log, or null if too little data. */
function measuredPace(log) {
  if (!Array.isArray(log) || log.length < 8) return null;
  const xs = log.slice(-200)
    .map((e) => (e && typeof e.ms === 'number' ? e.ms : NaN))
    .filter((n) => isFinite(n) && n > 800 && n < 120000)
    .sort((a, b) => a - b);
  if (xs.length < 8) return null;
  return xs[Math.floor(xs.length / 2)];
}

function svgIcon(path, size = 18) {
  return el('span.ico', {
    'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
      stroke-linejoin="round">${path}</svg>`,
  });
}

const ICON_TICK = '<path d="M20 6 9 17l-5-5"/>';
const ICON_CROSS = '<path d="M18 6 6 18M6 6l12 12"/>';

/* ========================================================================
   mount
   ===================================================================== */

/**
 * Mount the study session into `root`.
 *
 * @param {HTMLElement} root  container owned by the shell (`#view`)
 * @param {{store: object, srs: object, data: object, bus: object}} deps
 * @param {{path: string, params: object}} [route]  `?go=1` skips the start screen
 */
export function mountQuiz(root, deps, route) {
  if (typeof activeTeardown === 'function') activeTeardown();

  const { store, srs, data, bus } = deps || {};
  if (!root || !store || !srs || !data) {
    if (root) mount(root, el('.empty', {}, [el('h3', { text: 'Study is unavailable' })]));
    return;
  }

  /* ---------------------------------------------------- session state */
  const S = {
    phase: 'start',        // start | question | done
    items: [],             // [{ q, card, isNew, ahead, overdue }]
    index: 0,
    skipped: 0,
    ahead: false,
    answered: 0,
    correct: 0,
    ratings: { 1: 0, 2: 0, 3: 0, 4: 0 },
    counts: { new: 0, reviews: 0 },
    lapsed: [],            // [{ id, stem, label, href }]
    moduleIds: new Set(),
    startedAt: 0,
    elapsedMs: 0,          // summed per-answer time, not wall clock
    shownAt: 0,
    chosen: -1,            // index of the chosen option, -1 before answering
    revealed: false,
    pendingRating: 0,      // currently highlighted grade
    node: null,            // the .quiz element we mounted, for liveness checks
    nodes: {},             // cached child nodes of the current question
  };

  const settings = () => {
    try { return store.getSettings() || {}; } catch { return {}; }
  };
  const retention = () => {
    const r = settings().desiredRetention;
    return typeof r === 'number' ? r : 0.9;
  };

  /* --------------------------------------------------- content lookups */

  /** Guideline or drug record behind a question's `source.number`. */
  function sourceRecord(q) {
    try {
      const d = data.getData();
      const num = q && q.source && q.source.number;
      if (!num) return null;
      const rec = (d.glByNumber && d.glByNumber.get(num))
        || (d.drugByNumber && d.drugByNumber.get(num))
        || null;
      return rec && rec.id ? rec : null;
    } catch { return null; }
  }

  function sourceText(q) {
    try {
      if (typeof data.sourceLabel === 'function') return data.sourceLabel(q);
    } catch { /* fall through to a local format */ }
    const s = (q && q.source) || {};
    return [s.number, s.title].filter(Boolean).join(' ') + (s.page ? ` · p.${s.page}` : '');
  }

  function moduleLabel(id) {
    try {
      const m = data.moduleById(id);
      return (m && m.label) || id;
    } catch { return id; }
  }

  /* ------------------------------------------------------ queue build */

  function buildSession() {
    const st = settings();
    let questions = [];
    try { questions = data.enabledQuestions(st) || []; } catch { questions = []; }

    let raw = [];
    try {
      raw = srs.buildQueue(questions, store.allCards(), st, store.todayCounts(), new Date()) || [];
    } catch (err) {
      console.error('could not build the study queue', err);
      raw = [];
    }

    const items = [];
    let skipped = 0;
    for (const it of raw) {
      if (it && usable(it.q)) items.push(it);
      else skipped += 1;
    }

    S.items = items;
    S.skipped = skipped;
    S.ahead = items.length > 0 && items.every((i) => i.ahead);
    S.index = 0;
    S.answered = 0;
    S.correct = 0;
    S.ratings = { 1: 0, 2: 0, 3: 0, 4: 0 };
    S.counts = { new: 0, reviews: 0 };
    S.lapsed = [];
    S.moduleIds = new Set();
    S.elapsedMs = 0;
    return { questions, settings: st };
  }

  /* ========================================================= screens */

  /* --------------------------------------------------- start screen */

  function renderStart() {
    S.phase = 'start';
    const { questions, settings: st } = buildSession();
    const enabled = Array.isArray(st.enabledModules) ? st.enabledModules : [];

    if (!enabled.length) {
      return paint(el('.quiz.quiz-start', {}, [
        el('.empty', {}, [
          el('h3', { text: 'No modules are switched on yet' }),
          el('p', {
            text: 'Scheduling only covers modules you have enabled, which is what keeps '
              + 'the deck from dumping two thousand cards on you at once. Turn on one or '
              + 'two to begin — you can add more whenever you like.',
            style: { maxWidth: '54ch', margin: '0 auto var(--sp-5)' },
          }),
          el('a.btn.btn-primary.btn-hero', { href: '#/modules', text: 'Choose modules' }),
        ]),
      ]));
    }

    if (!S.items.length) {
      const capped = (() => {
        try {
          const t = store.todayCounts();
          return (t.reviews || 0) >= (st.dailyMax || 120);
        } catch { return false; }
      })();
      return paint(el('.quiz.quiz-start', {}, [
        el('.empty', {}, [
          el('h3', { text: capped ? "That is today's limit" : 'Nothing to study right now' }),
          el('p', {
            style: { maxWidth: '54ch', margin: '0 auto var(--sp-5)' },
            text: capped
              ? `You have hit your cap of ${st.dailyMax} reviews for today. The cap exists `
                + 'so a backlog never becomes unmanageable; raise it in settings if you want more.'
              : `Every card in your ${plural(enabled.length, 'enabled module')} is scheduled `
                + 'for later. Enable another module to bring new material in.',
          }),
          el('div.quiz-actions', {}, [
            el('a.btn.btn-primary', { href: '#/modules', text: 'Manage modules' }),
            el('a.btn', { href: '#/stats', text: 'View analytics' }),
            el('a.btn', { href: '#/', text: 'Home' }),
          ]),
        ]),
      ]));
    }

    const dueCount = S.items.filter((i) => !i.isNew).length;
    const newCount = S.items.filter((i) => i.isNew).length;
    const pace = measuredPace(typeof store.getLog === 'function' ? store.getLog() : null);
    const perReview = pace || EST_REVIEW_MS;
    const estMs = dueCount * perReview + newCount * perReview * NEW_MULTIPLIER;

    const modChips = enabled.slice(0, 6).map((id) => el('span.chip', { text: moduleLabel(id) }));
    if (enabled.length > 6) {
      modChips.push(el('span.chip', { text: `+${enabled.length - 6} more` }));
    }

    const startBtn = el('button.btn.btn-primary.btn-hero', {
      type: 'button',
      text: S.ahead ? `Study ahead — ${plural(S.items.length, 'card')}` : `Start — ${plural(S.items.length, 'card')}`,
      onclick: () => beginSession(),
    });

    paint(el('.quiz.quiz-start', {}, [
      el('.page-head', {}, [
        el('h1', { text: S.ahead ? 'Nothing is due — want to work ahead?' : 'Ready to study' }),
        el('p', {
          text: S.ahead
            ? 'These are early reviews. The scheduler picks the moment a card is about to '
              + 'slip, and reviewing before then teaches you less per card than waiting '
              + 'would — but working ahead is better than not studying at all.'
            : `${plural(dueCount, 'card')} due and ${plural(newCount, 'new card')} queued, `
              + `drawn from ${plural(questions.length, 'question')} in scope.`,
        }),
      ]),

      el('.grid.grid-stats', { style: { marginBottom: 'var(--sp-5)' } }, [
        statTile('Due', dueCount, 'scheduled reviews', dueCount ? 'var(--accent)' : null),
        statTile('New', newCount, `limit ${st.dailyNew ?? 15}/day`),
        statTile('Estimated', fmtDuration(estMs), pace ? 'at your usual pace' : 'rough estimate'),
      ]),

      el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
        el('h3', { text: 'In scope' }),
        el('.chip-row', {}, modChips),
        S.skipped
          ? el('p', {
            style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)', margin: 'var(--sp-3) 0 0' },
            text: `${plural(S.skipped, 'malformed question')} skipped.`,
          })
          : null,
      ]),

      el('.quiz-actions', {}, [
        startBtn,
        el('a.btn', { href: '#/modules', text: 'Modules' }),
        el('a.btn', { href: '#/', text: 'Home' }),
      ]),

      keyLegend('start'),
    ]));

    S.nodes = { startBtn };
    try { startBtn.focus({ preventScroll: true }); } catch { /* non-fatal */ }

    if (route && route.params && route.params.go === '1') beginSession();
  }

  function beginSession() {
    if (!S.items.length) return renderStart();
    S.startedAt = Date.now();
    S.index = 0;
    renderQuestion();
  }

  /* ------------------------------------------------- question screen */

  function current() { return S.items[S.index] || null; }

  function renderQuestion() {
    const item = current();
    if (!item) return renderDone();

    // Belt and braces: the queue was filtered, but never render an unusable
    // question — skip forward instead.
    if (!usable(item.q)) {
      S.skipped += 1;
      S.index += 1;
      return renderQuestion();
    }

    S.phase = 'question';
    S.chosen = -1;
    S.revealed = false;
    S.pendingRating = 0;
    S.shownAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const q = item.q;
    const total = S.items.length;
    const pos = S.index + 1;
    const prog = total ? S.index / total : 0;

    const meter = el('.meter', { style: { flex: '1' } }, [
      el('i', { style: { width: `${prog * 100}%` } }),
    ]);

    const scoreText = el('span.quiz-score', {
      text: S.answered ? `${S.correct}/${S.answered} correct` : 'first card',
    });

    const bar = el('.quiz-bar', {}, [
      el('.quiz-bar-row', {}, [
        el('span.quiz-pos', {
          text: `${pos} / ${total}`,
          'aria-label': `Card ${pos} of ${total}`,
        }),
        meter,
        scoreText,
        el('button.icon-btn.quiz-exit', {
          type: 'button', title: 'End session', 'aria-label': 'End session',
          onclick: () => requestExit(),
        }, [svgIcon(ICON_CROSS, 16)]),
      ]),
    ]);

    const optionNodes = q.options.map((text, i) => {
      const btn = el('button.q-opt', {
        type: 'button',
        'aria-pressed': 'false',
        dataset: { i: String(i) },
        onclick: () => choose(i),
      }, [
        el('span.q-key', { text: DIGITS[i] || String(i + 1), 'aria-hidden': 'true' }),
        el('span.q-text', { text }),
        el('span.q-mark', { 'aria-hidden': 'true' }),
        el('span.sr-only.q-sr'),
      ]);
      return btn;
    });

    const longest = q.options.reduce((a, o) => Math.max(a, o.length), 0);
    const options = el('.q-options', {
      role: 'group',
      'aria-label': 'Answer options',
      dataset: { cols: q.options.length === 4 && longest <= 56 ? '2' : '1' },
    }, optionNodes);

    const stem = el('h2.q-stem', { text: q.stem, tabindex: '-1' });

    const live = el('.sr-only', { role: 'status', 'aria-live': 'assertive' });
    const reveal = el('.q-reveal', { hidden: true });

    const node = el('.quiz.quiz-run', {}, [
      bar,
      el('.quiz-stage', {}, [
        el('.q-meta', {}, [
          el(`span.chip.${item.isNew ? 'chip-new' : 'chip-due'}`, {
            text: item.isNew ? 'New card' : 'Review',
          }),
          !item.isNew && item.overdue >= 1
            ? el('span.chip', { text: `${humanDays(item.overdue)} overdue` })
            : null,
          el('span.q-type', { text: TYPE_LABEL[q.type] || 'Question' }),
        ]),
        stem,
        options,
        reveal,
        live,
      ]),
      keyLegend('question'),
    ]);

    paint(node);
    S.nodes = { bar, meter, scoreText, options, optionNodes, reveal, live, stem };

    try { window.scrollTo(0, 0); } catch { /* non-fatal */ }
    try { stem.focus({ preventScroll: true }); } catch { /* non-fatal */ }
  }

  /* -------------------------------------------------------- answering */

  function choose(i) {
    if (S.phase !== 'question' || S.revealed) return;
    const item = current();
    if (!item) return;
    const q = item.q;
    if (!Number.isInteger(i) || i < 0 || i >= q.options.length) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    S.chosen = i;
    S.revealed = true;
    S.answerMs = Math.max(0, Math.round(now - S.shownAt));

    const right = i === q.answer;
    if (right) S.correct += 1;

    // --- paint the tiles -------------------------------------------------
    S.nodes.optionNodes.forEach((btn, idx) => {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-pressed', String(idx === i));
      const sr = btn.querySelector('.q-sr');
      const markWrap = btn.querySelector('.q-mark');
      if (idx === q.answer) {
        btn.classList.add('is-correct');
        markWrap.append(svgIcon(ICON_TICK, 20));
        if (sr) sr.textContent = idx === i ? ' — your answer, correct' : ' — correct answer';
      }
      if (idx === i && !right) {
        btn.classList.add('is-wrong');
        markWrap.append(svgIcon(ICON_CROSS, 20));
        if (sr) sr.textContent = ' — your answer, incorrect';
      }
      if (idx === i) btn.classList.add('is-chosen');
      else if (idx !== q.answer) btn.classList.add('is-muted');
    });

    // --- announce --------------------------------------------------------
    if (S.nodes.live) {
      S.nodes.live.textContent = right
        ? 'Correct. Rate how well you recalled it.'
        : `Incorrect. The correct answer is: ${q.options[q.answer]}.`;
    }

    // --- feedback + grading ---------------------------------------------
    S.pendingRating = right ? 3 : 1;
    buildReveal(item, right);
  }

  function buildReveal(item, right) {
    const q = item.q;
    const wrap = S.nodes.reveal;
    wrap.hidden = false;
    wrap.replaceChildren();

    const rec = sourceRecord(q);
    const label = sourceText(q);
    const note = CONFIDENCE_NOTE[q.confidence];

    // Node.append() stringifies null into a literal "null" text node,
    // unlike el()'s child handling which drops it. Several of these
    // children are conditional, so filter before appending.
    wrap.append(...[
      // The correct option is already highlighted green with a tick directly
      // above, so the verdict does not restate it — on a phone that repetition
      // pushed the explanation and the grade buttons a full screen further
      // down for no added information.
      el(`.q-verdict.${right ? 'is-ok' : 'is-bad'}`, {}, [
        svgIcon(right ? ICON_TICK : ICON_CROSS, 20),
        el('strong', { text: right ? 'Correct' : 'Not quite' }),
      ]),

      q.explanation ? el('p.q-explain', { text: q.explanation }) : null,

      el('.q-source', {}, [
        el('.q-source-head', {}, [
          el('span.q-source-label', { text: label }),
          note ? el('span.chip.chip-conf', { text: note }) : null,
        ]),
        q.source && q.source.snippet
          ? el('blockquote.q-snippet', { text: q.source.snippet })
          : null,
        rec
          ? el('a.q-source-link', { href: `#/item/${encodeURIComponent(rec.id)}` }, [
            `Read ${rec.number || ''} ${rec.title || rec.name || 'the full guideline'} →`.replace(/\s+/g, ' '),
          ])
          : null,
      ]),
    ].filter(Boolean));

    // --- grade buttons ---------------------------------------------------
    const card = item.card || (typeof srs.initCard === 'function' ? srs.initCard() : null);
    let preview = {};
    try {
      preview = srs.intervalPreview(card, new Date(), { desiredRetention: retention() }) || {};
    } catch { preview = {}; }

    const gradeBtns = GRADES.map((g) => el('button.btn.gbtn', {
      type: 'button',
      dataset: { r: String(g.r), tone: g.tone },
      'aria-pressed': String(S.pendingRating === g.r),
      // When the answer was right, "Again" stays reachable for an honest
      // guesser but is visually demoted so the eye goes to Good.
      class: right && g.r === 1 ? 'gbtn-demoted' : null,
      onclick: () => commit(g.r),
    }, [
      el('span.gbtn-key', { text: g.key, 'aria-hidden': 'true' }),
      el('span.gbtn-label', { text: g.label }),
      el('span.gbtn-int', { text: preview[g.r] ? humanDays(preview[g.r]) : '—' }),
      el('span.gbtn-hint', { text: g.hint }),
    ]));

    wrap.append(el('.q-grade', {}, [
      el('.q-grade-head', {}, [
        el('strong', {
          text: right ? 'How well did you recall it?' : 'Rate it — Again is already set',
        }),
        el('span.q-grade-sub', {
          text: right
            ? 'The interval under each button is when this card comes back.'
            : 'You missed it, so the card is scheduled to return shortly. Override if you were close.',
        }),
      ]),
      el('.q-grade-row', {}, gradeBtns),
    ]));

    S.nodes.gradeBtns = gradeBtns;
    highlightGrade(S.pendingRating);

    const primary = gradeBtns.find((b) => b.dataset.r === String(S.pendingRating));
    if (primary) {
      // Let the live region start speaking before focus moves.
      setTimeout(() => {
        try { if (primary.isConnected) primary.focus({ preventScroll: true }); } catch { /* ok */ }
      }, 60);
    }
  }

  function highlightGrade(r) {
    S.pendingRating = r;
    (S.nodes.gradeBtns || []).forEach((b) => {
      const on = b.dataset.r === String(r);
      b.dataset.primary = String(on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  /* -------------------------------------------------------- persistence */

  /**
   * Record the grade, persist everything, and move on. One call writes the
   * card, the log entry and the daily counter, then forces a synchronous
   * flush: store.saveProgress() is debounced 400ms by default, which is a
   * sensible optimisation for settings toggles but wrong here — a learner who
   * closes the tab or loses the tab to an OOM kill immediately after grading
   * would otherwise lose that review. A session is a sequence of small
   * durable commits, so each one is written through.
   */
  function commit(rating) {
    if (S.phase !== 'question' || !S.revealed) return;
    const item = current();
    if (!item) return;
    const q = item.q;
    const r = [1, 2, 3, 4].includes(rating) ? rating : 3;
    const now = new Date();
    const card = item.card || (typeof srs.initCard === 'function' ? srs.initCard() : null);

    let next = null;
    let retr = null;
    try {
      retr = typeof srs.retrievability === 'function' ? srs.retrievability(card, now) : null;
      next = srs.schedule(card, r, now, { desiredRetention: retention() });
    } catch (err) {
      console.error('scheduling failed for', q.id, err);
      toast('Could not schedule that card — it will come back.');
    }

    try {
      if (next) store.putCard(q.id, next);
      store.logReview({
        q: q.id,
        rating: r,
        ms: S.answerMs || 0,
        state: next ? next.state : (card && card.state) || 'new',
        retr: typeof retr === 'number' ? retr : undefined,
      });
      store.bumpDaily(item.isNew ? 'new' : 'reviews');
      if (typeof store.saveProgress === 'function') store.saveProgress(true);
    } catch (err) {
      console.error('could not persist that review', err);
      toast('This browser would not save that review.');
    }

    // --- session tallies --------------------------------------------------
    S.answered += 1;
    S.ratings[r] = (S.ratings[r] || 0) + 1;
    S.counts[item.isNew ? 'new' : 'reviews'] += 1;
    S.elapsedMs += S.answerMs || 0;
    for (const m of Array.isArray(q.modules) ? q.modules : []) S.moduleIds.add(m);
    if (r === 1) {
      const rec = sourceRecord(q);
      S.lapsed.push({
        id: q.id,
        stem: q.stem,
        label: sourceText(q),
        href: rec ? `#/item/${encodeURIComponent(rec.id)}` : null,
      });
    }

    try { bus.emit('review:logged', { q: q.id, rating: r }); } catch { /* non-fatal */ }

    S.index += 1;
    if (S.index >= S.items.length) renderDone();
    else renderQuestion();
  }

  /* --------------------------------------------------- complete screen */

  function renderDone() {
    S.phase = 'done';

    const answered = S.answered;
    const accuracy = answered ? S.correct / answered : 0;
    const wall = S.startedAt ? Date.now() - S.startedAt : S.elapsedMs;
    const stats = {
      answered,
      correct: S.correct,
      accuracy,
      ms: S.elapsedMs,
      wallMs: wall,
      ratings: { ...S.ratings },
      new: S.counts.new,
      reviews: S.counts.reviews,
      lapsed: S.lapsed.map((l) => l.id),
      modules: [...S.moduleIds],
      skipped: S.skipped,
      ahead: S.ahead,
      startedAt: S.startedAt ? new Date(S.startedAt).toISOString() : null,
      endedAt: new Date().toISOString(),
    };
    try { bus.emit('session:complete', stats); } catch { /* non-fatal */ }

    if (!answered) {
      return paint(el('.quiz.quiz-done', {}, [
        el('.empty', {}, [
          el('h3', { text: 'Session ended' }),
          el('p', { text: 'Nothing was graded, so nothing changed.' }),
          el('.quiz-actions', { style: { justifyContent: 'center' } }, [
            el('button.btn.btn-primary', { type: 'button', text: 'Study again', onclick: () => renderStart() }),
            el('a.btn', { href: '#/', text: 'Home' }),
          ]),
        ]),
      ]));
    }

    const enabled = new Set(settings().enabledModules || []);
    const touched = [...S.moduleIds].filter((m) => enabled.has(m));
    const accentForAccuracy = accuracy >= 0.85 ? 'var(--ok)' : accuracy >= 0.6 ? 'var(--warn)' : 'var(--bad)';

    const breakdown = el('.rb', {}, GRADES.map((g) => {
      const n = S.ratings[g.r] || 0;
      return el('.rb-row', { dataset: { tone: g.tone } }, [
        el('span.rb-label', { text: g.label }),
        el('.meter.rb-meter', {}, [el('i', { style: { width: `${answered ? (n / answered) * 100 : 0}%` } })]),
        el('span.rb-n', { text: String(n) }),
      ]);
    }));

    paint(el('.quiz.quiz-done', {}, [
      el('.page-head', {}, [
        el('h1', { text: accuracy >= 0.85 ? 'Strong session' : 'Session complete' }),
        el('p', {
          text: `${plural(answered, 'card')} graded in ${fmtDuration(wall)} — `
            + `${S.counts.reviews} ${S.counts.reviews === 1 ? 'review' : 'reviews'} and `
            + `${plural(S.counts.new, 'new card')}. `
            + (S.lapsed.length
              ? `${plural(S.lapsed.length, 'card')} lapsed; they are listed below so you can go read them.`
              : 'Nothing lapsed.'),
        }),
      ]),

      el('.grid.grid-stats', { style: { marginBottom: 'var(--sp-5)' } }, [
        statTile('Accuracy', pct(accuracy), `${S.correct} of ${answered}`, accentForAccuracy),
        statTile('Cards', answered, `${S.counts.new} new · ${S.counts.reviews} review`),
        statTile('Time', fmtDuration(wall), `${fmtDuration(answered ? S.elapsedMs / answered : 0)} per card`),
      ]),

      el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
        el('h3', { text: 'How you rated yourself' }),
        breakdown,
      ]),

      touched.length
        ? el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
          el('h3', { text: 'Modules touched' }),
          el('.chip-row', {}, touched.slice(0, 12).map((m) => el('span.chip', { text: moduleLabel(m) }))),
        ])
        : null,

      S.lapsed.length
        ? el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
          el('h3', { text: `Go back over ${plural(S.lapsed.length, 'card')}` }),
          el('p', {
            style: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
            text: 'These come back within a minute or two of study time. Reading the source '
              + 'once now is worth more than meeting them cold again.',
          }),
          el('.lapse-list', {}, S.lapsed.map((l) => (l.href
            ? el('a.lapse-row', { href: l.href }, [
              el('span.lapse-stem', { text: l.stem }),
              el('span.lapse-src', { text: l.label }),
            ])
            : el('.lapse-row', {}, [
              el('span.lapse-stem', { text: l.stem }),
              el('span.lapse-src', { text: l.label }),
            ])))),
        ])
        : null,

      el('.quiz-actions', {}, [
        el('button.btn.btn-primary.btn-hero', {
          type: 'button', text: 'Study more', onclick: () => renderStart(),
        }),
        el('a.btn', { href: '#/stats', text: 'Analytics' }),
        el('a.btn', { href: '#/', text: 'Home' }),
      ]),
    ]));
  }

  /* -------------------------------------------------------------- exit */

  async function requestExit() {
    const mid = S.answered > 0 && S.index < S.items.length;
    if (mid) {
      const ok = await confirmDialog({
        title: 'End this session?',
        body: `${plural(S.answered, 'card')} already counted and saved. `
          + `${plural(S.items.length - S.index, 'card')} left in the queue — they stay due.`,
        okLabel: 'End session',
      });
      if (!ok) return;
    }
    if (S.answered > 0) renderDone();
    else navigate('/');
  }

  /* ----------------------------------------------------------- plumbing */

  function statTile(k, v, sub, accent) {
    return el('.stat', {}, [
      el('.k', { text: k }),
      el('.v', { text: String(v), style: accent ? { color: accent } : {} }),
      sub ? el('.s', { text: sub }) : null,
    ]);
  }

  function keyLegend(phase) {
    const rows = phase === 'start'
      ? [['Enter', 'start the session']]
      : [['1 – 4', 'choose an answer'], ['1 – 4', 'rate it after the answer'], ['Enter', 'confirm and continue']];
    return el('.q-keys', { 'aria-hidden': 'true' }, rows.map(([k, t]) => el('span.q-keys-item', {}, [
      el('kbd', { text: k }), el('span', { text: t }),
    ])));
  }

  function paint(node) {
    S.node = node;
    mount(root, node);
    return node;
  }

  /* ---------------------------------------------------------- keyboard */

  function typingTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  function onKey(e) {
    // The view may have been replaced by another route without a hashchange
    // we saw (or by an error path). Detach rather than act on a dead session.
    if (!S.node || !S.node.isConnected) { teardown(); return; }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (typingTarget(e.target)) return;
    // Never steal keys from a modal (confirmDialog uses <dialog>).
    if (document.querySelector('dialog[open]')) return;

    const k = e.key;

    if (S.phase === 'start') {
      if (k === 'Enter' && S.items.length) {
        e.preventDefault();
        beginSession();
      }
      return;
    }

    if (S.phase === 'done') {
      if (k === 'Enter') { e.preventDefault(); renderStart(); }
      return;
    }

    if (S.phase !== 'question') return;

    if (k === 'Escape') { e.preventDefault(); requestExit(); return; }

    const digit = DIGITS.indexOf(k);

    if (!S.revealed) {
      const item = current();
      const n = item && item.q ? item.q.options.length : 0;
      if (digit >= 0 && digit < n) { e.preventDefault(); choose(digit); }
      return;
    }

    // Revealed: 1–4 pick a grade and commit it; Enter commits the highlighted
    // one. Committing on the digit keeps the loop to a single keystroke per
    // card, which is the whole point of having hotkeys.
    if (digit >= 0 && digit < GRADES.length) {
      e.preventDefault();
      highlightGrade(GRADES[digit].r);
      commit(GRADES[digit].r);
      return;
    }
    if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      commit(S.pendingRating || 3);
    }
  }

  function onHash() {
    const path = (location.hash || '').replace(/^#/, '').split('?')[0].replace(/\/+$/, '') || '/';
    if (path !== '/study') teardown();
  }

  function teardown() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onHash);
    if (activeTeardown === teardown) activeTeardown = null;
  }

  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  activeTeardown = teardown;

  renderStart();
}

export default mountQuiz;

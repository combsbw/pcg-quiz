# PROGRESS / CHECKPOINT LOG

Resume point for this build. **Update this file at every checkpoint.** If a
session ends, the next session reads this file first and continues from the last
unchecked box without redoing completed work.

Source of truth for data shapes: `DATA_CONTRACT.md` (frozen v1).

## Build state

- [x] **C0 — Scaffold.** Dirs created, `DATA_CONTRACT.md` frozen, this log started.
- [x] **C1 — Content pipeline.** `tools/build_content.py` → `app/data/content.json`
- [x] **C2 — Question generator.** `tools/build_questions.py` → `questions.json`, `modules.json`
- [x] **C3 — App shell.** index.html, tokens.css, router, store, data loader, theming
- [x] **C4 — Quiz UI.** tile-based MCQ, keyboard, session flow
- [x] **C5 — SRS engine.** FSRS scheduling + forgetting/trajectory model
- [x] **C6 — Analytics.** coverage, connections, retention curves
- [x] **C7 — Packaging.** service worker, offline, GH Pages, README
- [x] **C8 — Verification.** end-to-end test, question spot-audit vs source PDF

## Environment facts (re-establish after a session break)

- Parsed guideline data: `/mnt/user-data/outputs/lfn_build/<version>/subsections.jsonl`
  Versions present: `2026.03.18`, `2026.07.14`, `2026.09.15`. Build against **2026.09.15**.
- Parser: `/mnt/user-data/outputs/parse_lfn.py` (do not modify; already verified).
- Source PDFs: `/mnt/user-data/uploads/2026-09-15_PCGs.pdf` (+ two older).
- `pip install pymupdf --break-system-packages` is needed after a container reset.
- Project root: `/home/claude/lfn-learn`. Deliverable copy: `/mnt/user-data/outputs/lfn-learn/`.

## Key decisions (do not relitigate)

1. **Zero-build vanilla ES modules.** No React, no bundler, no npm at runtime.
   Must run from `file://` and from GitHub Pages unchanged.
2. **Every question is source-cited.** Distractors are real values pulled from
   elsewhere in the document — never invented numbers. Low-confidence items are
   generated but hidden by default.
3. **Formulary doses come from PDF table extraction** (`page.find_tables()`),
   not from the flat parsed text. The flat text is column-major and would
   mis-pair an indication with the wrong dose — unacceptable for dosing content.
4. **Modules gate scheduling.** Only questions in enabled modules are scheduled,
   so the learner never faces a 2000-card due pile.
5. FSRS (not SM-2) for scheduling, because the brief asks to model both learning
   and forgetting trajectories.
6. Default taxonomy on landing = `section`.

## Checkpoint notes

### C0 — 2026-10-14
Scaffolded. Confirmed `find_tables()` recovers Indication/Adult/Pediatric/Neonatal
cell structure on the Epinephrine page (25 rows x 12 cols, with empty spacer
columns and continuation rows to collapse). This validated decision #3.

### C1 — content pipeline — DONE
`tools/build_content.py` → 117 guidelines, 84 drugs, 169 dose rows, 633 info fields.
Formulary doses come from `find_tables()` with cells mapped onto headings by
x-overlap. Two extraction bugs were found and fixed by auditing output against
the PDF:
1. Continuation rows. One logical dose entry wraps over several physical rows
   (indication text spills down; "Max single dose" sits on its own row). A new
   entry is now recognised only where a row has BOTH an indication and a dose;
   everything else merges upward. Before this, answers like "with sodium < 120"
   were being emitted as doses.
2. Wrapped cells. `cell_join` joins all lines of an indication; `dose_text`
   takes lines up to the first qualifier bullet, so "0.1 mL/kg (0.01 mg/kg)
   SIVP / over 2 min" stays whole without dragging in "May repeat q 3-5 min".
Dose answers must additionally lead with a number (`is_dose`), which rejects
fragments that land in a dose column.

### C2 — question generator — DONE
`tools/build_questions.py` → **2964 questions**, 0 orphans, all source-cited.
Types: guideline_step 1479, guideline_match 550, drug_info 407, drug_dose 212,
max_dose 111, route 59, care_level_scope 107, drug_indication 35, compare 4.
Confidence: 2195 high / 769 medium (no low survived the filters).

**219 modules across 5 taxonomies**, every module 10-85 questions. Oversized
modules are chunked along the document's own numbering (`chunk_module`), e.g.
"Procedures 8.01-8.09", with each chunk listing the previous as `prereq`, so
enabling a section never dumps 900 cards into one day's queue.
Taxonomies: `section` (55), `care-level` (39), `drug-class` (59),
`algorithm` (49), `comparison` (14).

Data files written to `app/data/`: content.json (1.2MB), questions.json (2.4MB),
modules.json (187KB).

### C5 — SRS engine — DONE
`app/js/srs.js` (~840 lines, pure ES module: no imports, no DOM, no I/O, no
store.js dependency). FSRS-5, not SM-2, per decision #5.

**Implemented**
- Power forgetting curve `R = (1 + FACTOR*t/S)^DECAY`, DECAY = -0.5,
  FACTOR = 19/81 (pinned so R(S) = 0.9 exactly — verified to 1e-9).
- Initial S/D from the weight vector; difficulty update with linear damping
  plus mean reversion toward D0(Easy); stability-after-recall (with the
  spacing-effect term `e^(w10*(1-R))-1`); stability-after-lapse, additionally
  floored under the previous S so a lapse can never increase stability;
  FSRS-5 short-term (same-day) stability for elapsed < 1 day.
- Interval = inverse forgetting curve at `settings.desiredRetention`
  (default 0.9, clamped 0.7–0.99), result clamped to [1, 36500] days.
  Sub-day steps (1–10 min) for `learning` / `relearning`.
- Deterministic fuzz: FNV-1a hash of the card's own state, ±15/10/5% by
  interval band. Keeps `schedule()` referentially transparent so replaying the
  log reproduces identical due dates (analytics relies on this) and tests
  don't flake.
- Exports: `RATINGS`, `DEFAULT_W`, `initCard`, `schedule`, `retrievability`,
  `intervalPreview`, `buildQueue`, `summarize`, `forgettingCurve`,
  `workloadForecast`, plus `_model` (constants for analytics).

**Weight vector source** — `DEFAULT_W` is the 19-parameter FSRS-5
`DEFAULT_PARAMETERS` from open-spaced-repetition/fsrs-rs, fitted on the
project's aggregate public review dataset. Exported frozen and documented
index-by-index so it is inspectable. `opts.w` overrides it (validated: must be
19+ finite numbers, else falls back to defaults).

**Deviations / additions to the contract (all additive — no signature broken)**
1. `summarize()` takes two optional extra params: `(…, now, log)`. The log is
   also discovered from the 5th arg or from `settings._log` / `settings.log`.
   main.js's existing 4-arg call still works and returns `retention: null`.
2. `buildQueue()` items carry two extra fields beyond `{q, card, isNew}`:
   `ahead` (true when nothing was due and these are study-ahead cards, so the
   quiz can label the session) and `overdue` (days overdue, for display).
3. `forgettingCurve(card, days, samples)` and `workloadForecast(cards, days,
   now)` take an optional trailing arg; both default sensibly.
4. **Queue policy decision:** reviews do *not* get absolute priority. Up to 30%
   of the session is reserved for new cards first. Caught by the test suite — a
   learner whose backlog exceeds `dailyMax` was getting a queue of 100% reviews
   and could never advance through the deck. Reviews still dominate.
5. New cards are interleaved by a Bresenham-style distribution (e.g. 15 reviews
   + 5 new → new at positions 3, 7, 11, 15, 19), not front- or back-loaded.
6. A card record that exists but is still `state: 'new'` counts as unseen, not
   seen — it has never been graded.

**Test results** — `node` script (scratchpad, not in the project):
**70 assertions, 70 passed, 0 failed.** Highlights:
- New card rated GOOD ×4 on time → 0.007d → 4.95d → 17.84d → 52.44d (strictly
  increasing); also verified strictly increasing over 6 reps at retention
  targets 0.85 / 0.90 / 0.95.
- AGAIN on a mature card (S = 382d) → S 9.55d, lapses 0→1, state `relearning`,
  D 5.24→6.77; relearning + GOOD → `review`.
- `retrievability` = exactly 1.0 at t=0, strictly decreasing across 0–400d at
  0.25d steps, R(S) = 0.900000000.
- `buildQueue` honours both caps including caps already partly consumed today
  (120/120 max, 15/15 new, 20 remaining after 100 reviews done, empty at cap);
  most-overdue-first ordering; study-ahead fallback sorted by due and flagged.
- `summarize` 4-arg returns all 8 documented keys with `retention: null`;
  retention = 0.5 from a 4-in-window log via any of the three paths.
- Purity: `schedule()` does not mutate its input and is byte-identical on
  repeat calls. Every public function survives `null` / string / NaN / Infinity
  / bogus-state input without throwing.

Next: C6 — Analytics can consume `forgettingCurve`, `workloadForecast` and
`DEFAULT_W`/`_model` directly; it must pass `store.getLog()` into `summarize`
as the 6th arg to get a non-null retention.

---

### C4 — Quiz UI — DONE

**Files:** `app/js/quiz.js` (924 lines), `app/css/quiz.css` (362 lines). Nothing
else touched. Signature matches the contract: `mountQuiz(root, deps, route)`,
`deps = { store, srs, data, bus }`.

**What it builds** — the three screens of one loop
(start → question → answer → grade → … → complete):

1. **Start screen.** Due vs new counts, time estimate, in-scope module chips,
   one oversized Start button. Empty state → `#/modules`. When nothing is due,
   `buildQueue`'s `ahead` flag flips the copy and the button to "Study ahead".
   A separate branch fires when `dailyMax` is already spent today.
2. **Question card.** Stem at `clamp(fs-lg → fs-2xl)`, four option tiles ≥64px
   tall (68px on phones), full width, 2-up only above 720px *and* only when all
   four options are ≤56 chars. Numbered 1–4 with key badges.
3. **Reveal.** Correct tile green, chosen-wrong red, other two dimmed to 50%;
   explanation, source citation (`number title · p.page`), verbatim snippet in
   a quote block, and a `#/item/<id>` link resolved through
   `getData().glByNumber` / `drugByNumber`. Confidence chip when not `high`.
4. **Grading.** Four FSRS buttons with `intervalPreview` days via `humanDays`.
   Wrong → Again preselected; correct → Good preselected and Again demoted.
5. **Persistence.** Per answer: `srs.schedule` → `store.putCard` →
   `store.logReview({q, rating, ms, state, retr})` → `store.bumpDaily` →
   `bus.emit('review:logged')`. `ms` is `performance.now()` from render to click.
6. **Progress header.** Sticky; position, `.meter`, running correct count, exit
   button gated behind `confirmDialog` only mid-session.
7. **Keyboard.** 1–4 answer; 1–4 grade after reveal; Enter/Space commit the
   highlighted grade; Esc exits. Suppressed while a `dialog[open]` exists or
   focus is in a form field. On-screen legend, shown only at ≥720px with hover.
8. **Complete screen.** Accuracy, counts, time, per-rating breakdown, modules
   touched, lapsed cards linked to their sources, and study-more / analytics /
   home. Emits `session:complete` with the full stats object.

**UX decisions worth knowing**

- **The source citation is hidden until reveal.** Not cosmetic: 550 questions
  are `guideline_match`, whose options *are* guideline titles — showing
  `sourceLabel()` in the header would print the answer above the options.
  Pre-reveal the header carries only the new/review chip and the question type.
- **Grades are 2×2 on phones**, not a 4-wide strip, so the far button stays in
  thumb reach. Tone is a 4px inset bar, not a fill, so the four read as one
  control group.
- **The verdict line does not restate the correct answer** — the green tile
  with a tick sits directly above it, and on a phone the repetition pushed the
  explanation and grade buttons a screen further down for no information.
- **Every grade flushes synchronously** (`store.saveProgress(true)`), overriding
  store.js's 400ms debounce. A session is a sequence of small durable commits;
  closing the tab right after grading must not lose the review.
- **Options render in data order.** No render-time shuffle — `answer` is a fixed
  index and the generator already shuffled.
- **Defensive skip:** `usable()` drops any question with <2 options, a
  non-integer or out-of-range `answer`, or an empty stem, both at queue-build
  and again at render.

**Bugs found and fixed during browser verification** (all were real, all in my
own files):

1. `.q-opt:hover` outranked `.is-correct` / `.is-wrong` on specificity, so the
   tile the learner had just clicked snapped back to a neutral border under the
   cursor — the feedback colour vanished on the one tile they were looking at.
   Hover is now scoped `:not([aria-disabled="true"])`.
2. **Focus rings were invisible on every option and grade button.** app.css
   provides `:focus-visible { box-shadow: var(--focus) }`, but `.q-opt` and
   `.gbtn` both set `box-shadow` themselves (elevation, tone bar) — same
   property, later rule wins. Restated at higher specificity and composed with
   the tone bar. This broke keyboard navigation for exactly the controls a
   keyboard user drives the whole session with.
3. The shell's `.grid-stats` (auto-fit/170px) orphaned the third of three stat
   tiles at half width on a 390px phone; overridden to 3-up / 1-up.

**Verification**

- `node --input-type=module -e "import(…/quiz.js)"` → `['default','mountQuiz']`.
  Nothing touches `document` at module scope, so it imports in a DOM-less env.
- **Data conformance over all 2964 questions** (scratchpad script): 0 failures
  on every renderer assumption — usable(), exactly 4 options, no blank options,
  `source.number/title/page/snippet` present, non-empty explanation, every
  `source.number` resolving to a real `glByNumber`/`drugByNumber` record with an
  `.id`, non-empty `modules`, valid `confidence`. All 9 question types have a
  display label. 1312 (44.3%) qualify for the 2-up grid.
- **End-to-end in real Chromium** (Playwright, scratchpad): **141 assertions,
  141 passed, 0 failed**, run at 390×844 and 1280×900. Covers tile geometry
  (≥56px, single-column on phone), no horizontal overflow inside `.quiz`,
  correct/wrong colour + background + non-colour inset cue all differing,
  citation absent before reveal and present after, `#/item/` link resolving to a
  real item page, Again auto-selected when wrong / Good primary when correct,
  keyboard answer + grade, localStorage after each grade (card state, rating,
  ms, daily counters), confirm-on-exit including keys not being hijacked while
  the dialog is open, the complete screen's breakdown and lapsed links, the
  empty / study-ahead / daily-cap states, three remounts producing exactly one
  advance and one log entry (no duplicate listeners), reduced-motion, and zero
  console/page errors.
- Screenshots reviewed at both widths in light and dark.

**For the integrator**

- **Nothing to wire up** — main.js's existing
  `route('/study', r => import('./quiz.js').then(m => m.mountQuiz(view, deps, r)))`
  is sufficient. `#/study?go=1` skips the start screen and begins immediately,
  if the home view ever wants a one-tap entry.
- **Pre-existing shell bug, not mine:** `.topbar` overflows to 674px at a 390px
  viewport because `.nav` is 402px wide and does not wrap or scroll. This gives
  the whole app a horizontal scrollbar on every phone-width page. The quiz
  subtree itself measures 366px in a 390px viewport. Fix belongs in app.css
  (`.nav { overflow-x: auto }` or hiding more labels below 640px).
- `sw.js` is referenced by main.js but does not exist yet → a 404 on every load
  over http. Harmless, but it is in the console.
- **Content observation for the questions generator:** `explanation` contains
  `source.snippet` verbatim in 85.9% of items, adding a median of only 34
  characters. The reveal therefore shows near-duplicate text twice. Worth either
  trimming the explanation to the part that is *not* the snippet, or dropping
  the separate explanation for those items.
- Analytics can read `session:complete`, whose payload is
  `{ answered, correct, accuracy, ms, wallMs, ratings{1..4}, new, reviews,
  lapsed[ids], modules[], skipped, ahead, startedAt, endedAt }`.

### C6 — Analytics — DONE

`app/js/analytics.js` (~2040 lines) + `app/css/analytics.css` (~520 lines).
`mountAnalytics(root, deps, route)` per DATA_CONTRACT section 6. Pure ES module,
no build step, no npm, no CDN; every chart is hand-rolled inline SVG.

**Panels built**

1. **Headline** — 8 `.stat` tiles: cards seen, mature, retention (30d, toned
   against the learner's target), streak (+ best / active days), total reviews,
   pace (mean ms/card), *memory now* (mean predicted recall across the
   collection), due today.
2. **Review activity heatmap** — 26 weeks × 7 days from `store.getLog()`, 5-step
   ramp, month + weekday gutters, hover/focus tooltip and a live readout.
   Keyboard: **roving tabindex** (one tab stop, then arrows/Home/End) rather
   than 182 tab stops.
3. **Retention over time** — weekly measured accuracy (rated ≥ Good) with the
   learner's target as a dashed reference line. Weeks with no reviews **break
   the line** instead of interpolating — a silent week is missing data, not 0%.
4. **Learning and forgetting** (the differentiator) — two charts:
   - *Your collection*: aggregate predicted recall over 7/30/90/365d built from
     `srs.forgettingCurve` per card, against a second line that replays
     `srs.schedule` forward (every card due inside the horizon graded Good on
     its due date). The gap between them is annotated in-chart and quantified in
     the caption — that gap is literally what reviewing buys.
   - *What one review buys*: one card graded Good 6× in a row, each resulting
     forgetting curve drawn, with a dot where each crosses the target. Makes
     "each successful review flattens the decay" visible (3d → 4d → 16d → 1.7mo
     → 5mo → 1.0y at 90%). Renders with **zero history** — it is the model's
     prediction, not a summary of the past.
5. **Workload forecast** — 30 daily bars from `srs.workloadForecast`, `dailyMax`
   drawn as a reference line, over-cap days flagged.
6. **Coverage and scope** — `.seg` taxonomy switch (all 5) + all/enabled/started
   filter; one stacked bar per module split mature / young / learning /
   untouched; rows link to `#/modules?tax=<id>`. 213 modules across 5 taxonomies.
7. **Connections** — weak spots grouped by `source.number`, drawn as a binary
   treemap (area = lapses, or 1−recall when nothing has lapsed yet) over a
   ranked list with tag/module chips, each linking to `#/item/<id>`.
8. **Hardest cards** — top 15 by lapses then stability, with source label, lapse
   count, half-life and current recall; each links to `#/item/<id>`.

**Four design decisions worth knowing**

1. **Charts are built at measured pixel width, not a fixed viewBox.** A 600-unit
   viewBox scaled into a 348px phone column shrinks an 11px axis label to ~7px.
   The dashboard measures its container and re-renders (debounced,
   ResizeObserver + resize, 24px threshold) when the width actually moves.
2. **Workload: the axis is fitted to the scheduled days, not the backlog.**
   `workloadForecast` buckets everything overdue into day 0 (correct), but a
   learner returning from a break gets a day-0 bar several times taller than any
   scheduled day — scaling to it flattens the next 29 days to a 1px baseline and
   destroys the panel's entire purpose. The backlog bar is clipped, labelled
   with its true value, and given an axis-break marker; the caption says so. The
   over-cap warning also distinguishes "backlog today" (clears itself, change
   nothing) from "a cliff ahead" (lower dailyNew) — different problems, different
   fixes.
3. **Connections threads are scored by lift, not by co-occurrence.** "Shared by
   2+ weak clusters" surfaced `pop:adult` and `field:contraindications` — tags on
   nearly every card, which describe the corpus and not the weakness. A thread
   now has to be *selective*: common among weak clusters and rarer across
   everything else studied (lift > 1.25, smoothed). That turned the output from
   wallpaper into `Dysrhythmia 3.10–12.04` / `class:antiarrhythmic` /
   `class:electrolyte` — the "these topics share a drug class" finding the brief
   asked for.
4. **History panels use a wider scope than the summary.** Weak spots and the
   leaderboard see enabled questions ∪ every question with a card. Hiding a card
   the learner keeps failing because they toggled its module off is backwards —
   "where you keep failing" has to see every failure.

**Accessibility**

- Every chart `role="img"` with a data-bearing `aria-label` (counts, extremes,
  the actual trend), verified ≥ 40 chars on all of them.
- **Focus rings use `outline`, never `box-shadow`** — as the brief warned,
  app.css's `:focus-visible { box-shadow: var(--focus) }` is silently overridden
  by any component with its own elevation shadow, and box-shadow does not paint
  on SVG shapes at all. Asserted in the browser that every row component shows a
  real outline.
- Treemap cells are `tabindex="-1"` + `aria-hidden` inside the `role="img"` svg;
  the ranked list below carries the same links and numbers as the a11y path,
  rather than minting a second unlabelled set of tab stops.
- Colour never carries meaning alone: forgetting is dashed as well as red, the
  heatmap ramp is monotonic, over-cap bars are both red and above a labelled line.

**Verification**

- **Pure helpers, node (scratchpad): 250 assertions, 250 passed, 0 failed.**
  Synthetic histories built by replaying the real `srs.schedule` (180 cards /
  698 reviews / 131 lapses over 5 months), plus a no-lapse history, plus a
  deliberately corrupt fixture (NaN stability, Infinity, negative lapses,
  unparseable dates, nulls, strings and numbers where objects belong). Covers
  monotonicity of the decay series, keep-up ≥ stop-today at every horizon,
  determinism across calls, ladder stability strictly increasing and each later
  curve flatter at a fixed horizon, coverage buckets summing to totals, treemap
  tiling the rectangle exactly with no overlaps, thread lift ordering, and
  divide-by-zero guards throughout.
- **End-to-end in real Chromium (Playwright, scratchpad): 280 assertions, 280
  passed, 0 failed.** Four fixtures (populated / brand-new / no-lapse /
  single-review) × 390px and 1280px × light and dark. Asserts: all 8 panels
  render; **zero NaN/Infinity/undefined** anywhere in the DOM *or* in any SVG
  attribute; no element in the analytics subtree overflows its column and no
  panel scrolls horizontally; every SVG geometry attribute finite and
  non-negative; **no hardcoded colour in any SVG attribute**; contrast measured
  in both themes (every chart colour ≥ 2:1 vs page; heatmap ramp monotonic with
  each step separable); heatmap roving tabindex (exactly one tab stop, arrows
  move focus and update the live region, visible outline); horizon and taxonomy
  switches re-render; a leaderboard link resolving to a real guideline page;
  tooltips never widening a panel; three route visits leaving exactly one root
  (no duplicate listeners); four viewport resizes re-rendering without overflow;
  and **read-only confirmed** — cards, log and daily counters byte-identical
  after exercising every control.
- Screenshots reviewed per-panel at 390px in both themes, and full-page at
  1280px. Three issues were found by eye and fixed that the assertions had
  passed: a ladder reference label sitting on top of its own curves, the
  backlog-flattened workload axis (decision 2), and the useless-thread problem
  (decision 3).

**For the integrator**

- **Nothing to wire up.** main.js's existing
  `route('/stats', r => import('./analytics.js').then(m => m.mountAnalytics(view, deps, r)))`
  is sufficient. `#/stats?tax=<id>` preselects the coverage taxonomy and
  `#/stats?h=7|30|90|365` the forecast horizon; both are verified.
- **One write, deliberate:** clicking a taxonomy tab calls
  `store.setSetting('taxonomy', id)` so the choice persists, matching what
  `renderModules` already does. It is wrapped in try/catch and never fires on
  render. Nothing else touches the store.
- The module re-renders on `review:logged`, `session:complete`,
  `settings:changed` and `progress:reset`, and tears its listeners down when its
  root leaves the DOM, so remounting is safe.
- **Pre-existing shell bug, unchanged and not mine** (already logged under C4):
  `.topbar` is 674px wide at a 390px viewport because `.nav` neither wraps nor
  scrolls, giving every page a horizontal scrollbar. The analytics subtree itself
  measures within its column at every width tested — the e2e overflow assertions
  measure against `.main`'s box for exactly this reason. Fix belongs in app.css.
- `summarize()` is called with the 6-arg form `(qs, cards, settings,
  todayCounts, now, log)` so retention is populated; the 4-arg call in main.js
  still returns `retention: null` and could be upgraded the same way.
- Pure helpers are re-exported on `_analytics` for testing; they are not part of
  the app's API and nothing else should import them.

### C3 — App shell — DONE
`index.html`, `tokens.css`, `app.css`, `router.js` (hash routing + event bus),
`store.js`, `data.js`, `ui.js`, `main.js` (home / modules / browse / item /
settings views). Theme is applied before first paint from localStorage to avoid
a flash. Hash routing is deliberate: GitHub Pages needs no rewrite rules and
deep links survive refresh.

Two integration fixes after the agents reported in:
- **Topbar overflowed at phone width** (674px in a 390px viewport), giving every
  page a horizontal scrollbar. Both UI agents independently hit this. The nav
  now drops to its own full-width scrolling row below 760px, and
  `html, body { overflow-x: hidden }` is a backstop.
- `summarize()` is now called with the review log as its 6th argument, so
  retention shows a real number instead of an em dash.

### C7 — Packaging — DONE
`sw.js` with two cache policies: the shell + the three JSON files (~3.6 MB) are
precached on install so a cold offline launch works; the 122 figures (~35 MB)
are cached on demand, because precaching them would make the first load hostile
on a phone tether. `manifest.webmanifest` + generated 192/512 icons make it
installable. `README.md` covers Pages deployment (publish `app/` as `/docs`),
offline install, studying, analytics, data export, and rebuilding for a new
guidelines edition.

Content fix found by the quiz agent: the `explanation` field repeated
`source.snippet` almost verbatim in ~86% of items, so the reveal screen showed
the same sentence twice. The generator now drops the explanation where it adds
nothing beyond the cited quote — **1,181 removed**, 1,783 kept where they add
real context.

### C8 — Verification — DONE
Integration tests driven through real Chromium (Playwright), at 390x844 and
1280x900:
- **E2E journey: 52 assertions, 52 passed.** First-run onboarding, module
  enable + taxonomy switch, a 3-question study session with grading, card and
  log persistence, analytics rendering with no NaN in text or SVG attributes,
  browse + detail, theme switching in both directions, and zero console or page
  errors. Explicitly asserts no horizontal overflow on document or topbar.
- **Data safety + offline: 22 assertions, 22 passed.** Export produces valid
  JSON preserving all 40 seeded cards and reviews with a dated filename; reset
  clears history but keeps settings; import restores exactly; malformed,
  foreign and future-schema files are all rejected **without destroying
  existing progress**; the service worker activates and precaches; and with the
  network cut the app still loads and renders.

Agent-level verification (reported in their own sections): SRS 70/70 node
assertions, Quiz 141/141 browser assertions + all 2,964 questions conforming to
the renderer's assumptions, Analytics 530/530 (250 node + 280 browser).

## Resuming after this point
The build is complete and deliverable. Likely next steps if work continues:
regenerate for a newer guidelines edition (see README "Rebuilding"), add the
in-app question review/edit queue (deferred option from the original brief), or
widen `VECTOR_FIGURE_MIN_CURVES` handling if a future edition adds rectilinear
vector flowcharts.

### Post-integration fixes (after visual review)
Screenshots caught three things the assertion suites passed over:
1. **Literal `null` rendered on the reveal screen.** `Node.append()` stringifies
   `null` into a text node, unlike `el()`'s child handling which drops it. The
   conditional children in quiz.js's reveal block are now filtered before
   appending. A green test suite did not catch this; looking at the page did.
2. **Sub-headings were leaking in as answer options** ("ADULT & PEDIATRIC:",
   "Limb Presentation"). These are discardable on form alone, so the question
   measured nothing. `is_actionable()` now rejects colon-terminated, shouted and
   two-word fragments from both answers and distractor pools. 2964 -> 2893
   questions; zero colon-terminated options remain.
3. **Overlapping module labels** ("2.02–2.05" then "2.05–2.07") because chunks
   split mid-subsection. `chunk_module` now packs whole subsections, so every
   chunk is a clean nameable span and no guideline is scattered across two
   modules of the same taxonomy.

Final: **2,893 questions · 231 modules · 5 taxonomies.**
Note: the `algorithm` taxonomy intentionally lists 526 questions in two families
(e.g. Traumatic Arrest is both arrest and trauma); scheduling de-duplicates by
question id, so this never double-schedules a card.

---

## Workstream 3 — verbiage pass + focused modules (2026-10-15)

User request: (1) questions must name the condition/procedure, never the
section number ("Aortic Emergencies", not "5.03"), with light rephrasing;
modules must list section titles alongside numbers. (2) Dedicated modules for
13 procedures and 6 supplemental references.

### Done
- [x] Stable ids: every authored question carries `uid` = its live id;
      `merge_questions.py` honours it, so rewording never orphans history.
- [x] Validator: errors on real section numbers in stems (unit-aware, so
      `0.05 mg/kg` is not flagged); grounds numbers against native text +
      OCR; grounding extended to equipment/landmark/route; new `calculation`
      type with machine-checked `calc` blocks (formula recomputed, constants
      grounded on page, inputs must appear in stem). `--no-grounding` mode.
- [x] `tools/build_ocr.py` → `authoring/ocr.json` (tesseract, 300 dpi, two
      passes). Slow on 2 CPUs; resumable — re-run until "up to date".
- [x] `authoring/REPHRASE_SPEC.md` + `tools/apply_rephrase.py` (patches keyed
      by uid; guards forbid touching answers/options/pages).
- [x] Focus manifests `authoring/focus/F01..F07.json`; rephrase assignments
      `authoring/rephrase/ASSIGNMENTS.json` (R1..R7).

- [x] Rephrase pass R1-R8 applied: 1,367 stems, 301 explanations, 1 option
      reworded; no answer/page/uid changed; 0 section numbers left in stems.
- [x] Focus batches F01-F07: 268 new questions (RSI 43 + checklist 15,
      ventilation 55 incl. IBW/respiratory calcs, invasive procedures 45,
      airway/IO devices 48, blood/push-dose 24, reference charts 37,
      arrest algorithms 16). uids stamped. 2 exact duplicates of formulary
      questions removed from F01.
- [x] OCR complete (406 pages). Full grounding audit of all 25 batches:
      2,353 questions, 0 errors.
- [x] Module cards list "number  title" for every section they cover
      (collapsed to "+N more" past six); new "Focused Drills" taxonomy with
      19 whole, unchunked modules (13 procedures, 6 supplemental references).
- [x] Suites: e2e 52, e2e2 22, pure 250, srs 70, icons 21, fixes 17,
      review 17, modules 11 — all pass; search top-3 30/30 and 27/28.
      sw CACHE_VERSION v4.

## Workstream 4 — reference tables readable (2026-10-16)

User report: 10.03 Hemodynamic Pressure Table rendered as one interleaved
block of uppercase text — unusable as a reference.

Cause: the outline extractor reads a page as lines in reading order, so every
table row interleaved with the next.

- [x] `tools/extract_tables.py`: finds data tables (skips care-level bands and
      the History/Indications layout boxes), merges spanned columns and
      overflow rows, re-reads each cell's words from inside its merged box
      (keeps bullets with their text, bold sub-headings as headings).
- [x] `tools/table_render.json`: tables shown as rows/columns only after the
      grid was checked against the page by eye (10.01 x2, 10.03, 10.06 BEFAST,
      8.23 strategy tables x4, 8.26 CPAP/BiPAP, 9.02 triage). All others show
      the original table image (tap to enlarge). Every table carries its crop.
- [x] Vector diagrams (8.18 p215, 8.23 p223) placed inline where they sit;
      `tools/figure_regions.json` for composite graphics (8.23 p224 Pmean,
      p227 monitoring gauges). Loose text inside removed from outline, kept for
      search; figures not repeated in the Figures list.
- [x] "View page N" on every band: original page image (`tools/build_pages.py`,
      290 pages, 28 MB, cached on demand). Table images precached (1.7 MB).
- [x] Band label: "Reference" for supplemental pages, "Overview" for non-
      assessment BODY bands (was "Assessment" everywhere).
- [x] Phone layout: one card per table row, each value under its column name.
- [x] sw v5. Suites all pass; new tables suite 29/29.

Rebuild order after a new edition: build_content → build_structure →
build_pages → build_search_index; then re-check table_render.json and
figure_regions.json against the new pages.

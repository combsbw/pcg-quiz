# DATA CONTRACT — v1 (frozen)

Every module in this app reads these shapes. **Do not change a field name without
updating this file and PROGRESS.md.** Agents: treat this as authoritative.

All data files live in `app/data/` and are plain JSON fetched at runtime.
The app is zero-build vanilla ES modules. No bundler, no npm, no framework.

---

## 1. `app/data/content.json`

```jsonc
{
  "version": "2026.09.15",          // source PDF edition
  "generated": "2026-10-14T00:00:00Z",
  "sections": [
    { "number": "5", "title": "Medical", "subsection_count": 13 }
  ],
  "guidelines": [                    // one per subsection
    {
      "id": "5-01-altered-mental-status",
      "number": "5.01",
      "title": "Altered Mental Status",
      "section_number": "5",
      "section_title": "Medical",
      "page": 91,
      "care_levels": ["BLS", "ALS", "PEARLS"],
      "images": ["p091_x770.png"],
      "blocks": [
        { "care_level": "BLS", "levels": ["BLS"], "text": "...", "page": 91,
          "bullets": ["Check blood glucose level", "..."] }
      ]
    }
  ],
  "drugs": [                         // section 12 formulary, table-extracted
    {
      "id": "12-26-epinephrine",
      "number": "12.26",
      "name": "Epinephrine",
      "page": 332,
      "doses": [                     // one row per indication
        { "indication": "Cardiac Arrest",
          "adult": "1 mg IV; may repeat q 3-5 min",
          "pediatric": "0.1 mL/kg (0.01 mg/kg) IV",
          "neonatal": "Same as pediatric" }
      ],
      "info": { "Mechanism of Action": "...", "Contraindications": "...",
                "Adverse Reactions": "...", "Trade Name": "..." }
    }
  ]
}
```

`info` keys are whatever the source table used; never invented.

---

## 2. `app/data/questions.json`

```jsonc
{
  "version": "2026.09.15",
  "generated": "2026-10-14T00:00:00Z",
  "questions": [
    {
      "id": "q_a1b2c3d4",              // stable hash; survives regeneration
      "type": "drug_dose",             // see type list below
      "stem": "What is the adult dose of Epinephrine for Cardiac Arrest?",
      "options": ["1 mg IV", "0.3 mg IM", "5 – 20 mcg IV", "2 – 10 mcg/min"],
      "answer": 0,                     // index into options
      "explanation": "Source text supporting the answer, verbatim.",
      "source": {
        "version": "2026.09.15",
        "number": "12.26",
        "title": "Epinephrine",
        "page": 332,
        "snippet": "1 mg IV • May repeat q 3 – 5 min"
      },
      "confidence": "high",            // high | medium | low
      "tags": ["drug:epinephrine", "indication:cardiac-arrest", "route:iv"],
      "modules": ["sec-12", "drug-vasopressor", "algo-arrest"]
    }
  ]
}
```

**Rules that make this trustworthy and must not be relaxed:**
- `explanation` and `source.snippet` are copied from the parsed guideline text.
  Nothing is paraphrased or invented.
- Every question carries exactly one correct `answer`; distractors are real
  values drawn from elsewhere in the same document (another dose, another
  indication), never fabricated numbers.
- `confidence: "low"` items are hidden by default behind a settings toggle.

### Question types
| type | asks |
|---|---|
| `drug_dose` | adult/peds/neonatal dose for a drug + indication |
| `drug_indication` | which indication a dose belongs to |
| `drug_info` | mechanism, contraindication, adverse reaction, trade name |
| `care_level_scope` | which care level may perform/give X |
| `guideline_step` | which action belongs to a guideline's BLS/ALS/CCT band |
| `guideline_match` | which guideline covers a given action |
| `max_dose` | maximum single/total dose |
| `route` | route of administration |
| `compare` | distinguishes two similar drugs/guidelines |

---

## 3. `app/data/modules.json`

Modules are the unit of progressive buildout. A learner enables modules; only
questions in enabled modules enter scheduling. This is what prevents a 2000-card
"everything is due" dump.

```jsonc
{
  "taxonomies": [
    {
      "id": "section",
      "label": "Guideline Section",
      "description": "Mirrors the document's own organization.",
      "default": true,
      "modules": [
        { "id": "sec-5", "label": "Medical", "subtitle": "13 guidelines",
          "question_count": 182, "question_ids": ["q_a1b2c3d4", "..."],
          "prereq": [] }
      ]
    }
  ]
}
```

Taxonomy ids to build: `section`, `care-level`, `drug-class`, `algorithm`,
`comparison`. A question may belong to modules in several taxonomies at once —
`question_ids` across taxonomies overlap by design; scheduling de-duplicates by
question id.

---

## 4. Progress state (localStorage key `lfn.progress.v1`)

```jsonc
{
  "schema": 1,
  "created": "2026-10-14T...",
  "settings": { "theme": "dark", "dailyNew": 15, "dailyMax": 120,
                "showLowConfidence": false, "enabledModules": ["sec-5"] },
  "cards": {
    "q_a1b2c3d4": {
      "due": "2026-10-15T09:00:00Z",
      "stability": 3.2, "difficulty": 5.1,   // FSRS state
      "reps": 4, "lapses": 1, "state": "review", // new|learning|review|relearning
      "lastReview": "2026-10-14T09:00:00Z",
      "elapsed": 1, "scheduled": 3
    }
  },
  "log": [                                   // append-only review log
    { "q": "q_a1b2c3d4", "t": "2026-10-14T09:00:00Z", "rating": 3,
      "ms": 4200, "state": "review" }
  ]
}
```

Export = this object as a `.json` download. Import = validate `schema`, replace.
Reset = delete key. The log is what analytics and the forgetting model read; it
is never truncated on export.

---

## 5. Module boundaries (who owns what file)

| File | Owner | Exports |
|---|---|---|
| `app/js/store.js` | shell | `loadProgress, saveProgress, exportProgress, importProgress, resetProgress, getSettings, setSetting` |
| `app/js/srs.js` | srs | `schedule(card, rating, now)`, `initCard()`, `retrievability(card, now)`, `RATINGS` |
| `app/js/quiz.js` | quiz | `mountQuiz(root, deps)` |
| `app/js/analytics.js` | analytics | `mountAnalytics(root, deps)` |
| `app/js/router.js` | shell | `navigate(route)`, hash routing |
| `app/js/data.js` | shell | `getContent(), getQuestions(), getModules(), questionById()` |

`deps` passed to mounts: `{ store, srs, data, bus }`. `bus` is a tiny
event emitter: `bus.on(evt, fn)`, `bus.emit(evt, payload)`.
Events: `review:logged`, `session:complete`, `settings:changed`, `progress:reset`.

Agents must not edit files they do not own. Shared CSS variables live in
`app/css/tokens.css` — use those tokens, never hardcode colors.

---

## 6. Module interfaces (exact signatures — agents must match these)

The shell (`main.js`) already calls these. Changing a signature breaks the app.

### `app/js/srs.js` — owned by the SRS agent
```js
export const RATINGS = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

export function initCard();                       // -> fresh card object
export function schedule(card, rating, now, opts); // -> new card (pure, no I/O)
export function retrievability(card, now);         // -> 0..1 predicted recall
export function intervalPreview(card, now, opts);  // -> {1:days,2:days,3:days,4:days}

// Queue + summary used by the shell and quiz:
export function buildQueue(questions, cards, settings, todayCounts, now);
//   -> ordered array of { q, card, isNew }  honouring dailyNew / dailyMax.
//      Due reviews first (most overdue first), new cards interleaved after.

export function summarize(questions, cards, settings, todayCounts, now);
//   -> { total, seen, young, mature, due, newAvail, nextDue (ISO|null),
//        retention (0..1|null, last 30d from the log) }

// Learner model (used by analytics):
export function forgettingCurve(card, days);   // -> [{d, r}] predicted decay
export function workloadForecast(cards, days); // -> [{date, count}] due per day
```
Card object: `{ due, stability, difficulty, reps, lapses, state, lastReview,
elapsed, scheduled }` exactly as in section 4.

`schedule()` must be **pure** — the quiz writes the result through
`store.putCard`, and `store.logReview` records the review. srs.js must not
import store.js.

### `app/js/quiz.js` — owned by the Quiz agent
```js
export function mountQuiz(root, deps, route);   // deps = { store, srs, data, bus }
```
Renders into `root`. Emits `bus.emit('review:logged', {q, rating})` after each
answer and `bus.emit('session:complete', stats)` at the end.

### `app/js/analytics.js` — owned by the Analytics agent
```js
export function mountAnalytics(root, deps, route);
```

### Shared helpers both may import
`./ui.js` → `el, mount, clear, toast, pct, plural, humanDays, relTime, dayKey,
confirmDialog`.  `./data.js` → `getData, enabledQuestions, moduleById,
sourceLabel, sourceRecord`.  `./router.js` → `navigate, bus`.

CSS: quiz agent owns `app/css/quiz.css`, analytics agent owns
`app/css/analytics.css`. Both are already linked from index.html. Use only
tokens from `tokens.css` — no hardcoded colours, no web fonts, no CDN imports.
Charts are hand-rolled inline SVG (no chart library: the app must run offline
with zero dependencies).

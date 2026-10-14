# LFN Learn

**Live: https://combsbw.github.io/pcg-quiz/**

A spaced-repetition learning app built from the Life Flight Network **Patient
Care Guidelines**, edition **2026.09.15**. It drills the content of the
guidelines — doses, indications, routes, maximums, care-level scope and
algorithm steps — rather than clinical scenarios.

- **2,964 questions**, every one generated from the published guidelines and
  carrying its section, page and the verbatim source text.
- **219 modules** across 5 different groupings, so you choose the path and add
  scope progressively instead of having the whole book come due at once.
- **FSRS** scheduling, which models both how you learn and how you forget.
- Runs entirely in the browser. No account, no server, no network after the
  first load. Progress can be exported, imported and reset.

---

## Quick start

The site is already published at **https://combsbw.github.io/pcg-quiz/** — open
that and you are studying. To run it locally instead:

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `docs/index.html` straight off the disk mostly works, but some browsers
block `fetch()` on `file://` URLs, which stops the question bank from loading.
Serving the folder avoids that. The app tells you if it hits this.

## How it is deployed

`docs/` is the entire site — no build step, no dependencies, nothing to compile.
GitHub Pages serves it directly from `main`, so **pushing to `main` publishes**;
a change is live within a minute or so.

If Pages ever needs reconnecting: **Settings → Pages → Build and deployment →
Deploy from a branch**, branch `main`, folder `/docs`.

Hash routing is used throughout specifically so Pages needs no rewrite rules and
every deep link survives a refresh. All asset paths are relative, so the app
works unchanged at the project subpath (`/pcg-quiz/`), at a custom domain, or
from a local folder.

## Using it offline / on a device

Once loaded over `http(s)`, a service worker precaches the app and the question
bank (~3.6 MB), so it works with no signal. Figures (~10 MB) are cached as you
open them rather than up front, so the first load stays light on a tether.

**iPhone / iPad:** open the site in **Safari** (Chrome on iOS cannot install
web apps), tap **Share → Add to Home Screen**. It gets the app icon, launches
standalone with no browser chrome, and runs fully offline.

**Android:** Chrome will offer **Install app**, or use the ⋮ menu.

A note on your data on iOS: Safari clears script-written storage for sites you
have not visited in a while, but apps added to the Home Screen are exempt from
that. Progress still lives only in that one browser profile, so export a copy
before changing devices or clearing site data.

To carry it without a network at all, copy the `docs/` folder onto the device and
serve it locally, or just install it once while online.

---

## Studying

**Modules are the unit of scope.** Nothing is scheduled until you enable a
module, which is what keeps the queue from becoming 3,000 cards due on day one.
Modules are deliberately small (10–85 questions) and large areas are split along
the document's own numbering, e.g. `Procedures 8.01–8.09`.

Five ways to slice the same material:

| Grouping | Use it when |
|---|---|
| **Guideline Section** | You want to mirror the book — Cardiac, Medical, OB, Trauma… |
| **Care Level** | Scope of practice first: learn BLS, then ALS, then CCT |
| **Drug & Mechanism** | Formulary by pharmacologic class, so related agents compete |
| **Algorithm Family** | Cross-cutting: arrest, airway, shock, dysrhythmia, tox, OB |
| **Cross-cutting & Comparison** | One concept pulled from everywhere (all maximum doses, all routes), plus drills that force you to discriminate between lookalike agents |

A question usually belongs to several modules at once. Scheduling de-duplicates
by question, so enabling overlapping modules never double-schedules a card.

**Grading.** After answering you rate recall — Again / Hard / Good / Easy — and
FSRS sets the next interval from that. A wrong answer defaults to Again. Target
retention is adjustable in Settings (85 / 90 / 95%); higher means shorter
intervals and more reviews.

## Analytics

Covers interaction, scope, coverage and connections: a review heatmap, retention
over time against your target, the predicted forgetting curve for your current
collection, a 30-day workload forecast that shows a cliff before you hit it,
per-module coverage by maturity, a "connections" panel that finds what your
weakest cards have in common (scored by lift, so it surfaces a shared drug class
rather than a tag that is on everything), and a difficulty leaderboard linking
straight back to the source guideline.

## Your data

Everything lives in this browser's `localStorage` under `lfn.progress.v1`.
Nothing is transmitted anywhere.

- **Export** writes a timestamped JSON file containing every card state and the
  full review log.
- **Import** validates before touching live state and offers merge or replace.
  Merge keeps whichever version of each card was reviewed most recently.
- **Reset** clears cards and history but keeps your settings.

Clearing site data in your browser deletes your progress, so export before you
do that, and before switching devices.

---

## Rebuilding the question bank

The app ships with generated data; you only need this when a new guidelines
edition comes out.

```bash
pip install pymupdf --break-system-packages
python3 tools/build_content.py  --version 2026.09.15   # -> docs/data/content.json
python3 tools/build_questions.py                       # -> questions.json, modules.json
python3 tools/build_icons.py                           # only if the icon changes
```

`build_content.py` reads the parsed `subsections.jsonl` produced by
`parse_lfn.py` (the upstream PDF parser) for guidelines, and re-extracts the
formulary **directly from the PDF with table detection**. That second path
matters: a formulary page's flat text is column-major, so an indication and its
dose end up far apart in the text stream, and pairing them from that would
eventually attach a dose to the wrong indication. Cell geometry keeps the
pairing intact.

After rebuilding, bump `CACHE_VERSION` in `docs/sw.js` so existing installs pick
up the new edition instead of serving the old one from cache.

### How questions are made

Nothing is invented. Stems, answers and distractors are all text that appears in
the guidelines, and distractors are real values pulled from elsewhere in the
document — usually another indication for the same drug — so a wrong option is
plausible for the right reason. Each item stores its source number, title, page
and a verbatim snippet, shown on the reveal screen.

Items are graded `high` or `medium` confidence; a `showLowConfidence` setting
exists for any future items generated with weaker guarantees.

---

## Project layout

```
docs/                    the published site (GitHub Pages serves this)
  index.html
  sw.js                  offline caching
  manifest.webmanifest   install metadata
  apple-touch-icon*.png  iOS home-screen icons (opaque; iOS masks them)
  icon-*.png             manifest icons, incl. an Android maskable variant
  css/   tokens.css      design tokens — all colour lives here
         app.css         shell + shared components
         quiz.css  analytics.css
  js/    main.js         shell: boot, routing, home/modules/browse/settings
         router.js       hash router + event bus
         store.js        progress, settings, export/import/reset
         data.js         loads and indexes the JSON
         srs.js          FSRS scheduling + forgetting model
         quiz.js         session UI
         analytics.js    dashboard
         ui.js           shared DOM/format helpers
  data/  content.json questions.json modules.json images/
tools/                   the generation pipeline
DATA_CONTRACT.md         frozen interfaces between modules
PROGRESS.md              build log and checkpoints
```

---

## A caveat worth stating plainly

This is a study aid built from a specific published edition. The questions are
generated automatically, and while every item is traceable to its source page,
automatic generation is not editorial review. Treat the current published
guidelines — not this app — as authoritative for patient care, and re-check
anything here that looks wrong against the cited page.

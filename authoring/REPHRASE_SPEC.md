# Rephrase pass — read fully before editing anything

You are rewording existing study questions for flight and ground crews. The
questions are already correct; **you are not changing any fact, answer, option
value or page**. You are changing how the question *reads*.

## What the user asked for

> Instead of referring to sections by the section number, they should refer to
> the section title or condition, e.g. "Aortic Emergencies" vs "5.03". Question
> wording may need a light rephrasing as well. Questions should refer directly
> to the pathology, condition, or procedure vs the document where appropriate —
> this will make the question more clear and easier to understand right away.
> Question sourcing and material provenance is maintained through when the
> answer is given, so the section number itself does not need to be stated in
> the question wording.

## Rules

1. **No section numbers in stems.** Remove every "in 5.02", "under 8.23",
   "per 12.26", "does 4.02 direct", "5.13 says". The answer screen already
   shows number, title and page.

2. **Ask about the clinical thing directly.** Prefer the pathology, condition,
   procedure or drug as the subject, not the document:

   | Before | After |
   |---|---|
   | What does 2.06 require whenever ondansetron is administered? | What must be done whenever ondansetron is given? |
   | How does 5.10 direct an ischemic stroke patient be positioned for transport? | How should a patient with an ischemic stroke be positioned for transport? |
   | What starting respiratory rate does 8.23 set for a 7 kg infant? | What starting ventilator rate is set for a 7 kg infant? |
   | What repeat dose does 12.29 give for procedural sedation with etomidate? | What is the repeat dose of etomidate for procedural sedation? |
   | What does 8.04 direct for a patient with excessive chest hair before pads are applied? | What should be done before applying defibrillation pads to a patient with excessive chest hair? |
   | When fibrinolytics were given before transfer, when does 3.05 direct the 12-lead be repeated? | After pre-transfer fibrinolytics in STEMI, when should the 12-lead ECG be repeated? |

3. **Replace the context, don't just delete it.** This is the rule that matters
   most. A section number often carried meaning: the same drug has different
   doses in different guidelines (ketamine for pain, for post-intubation
   sedation, for RSI, for combative patients). If you strip "in 2.08", you must
   put back "for post-intubation sedation" or the stem becomes ambiguous and
   more than one option could be right.

   **Test every rewritten stem: does it still pick out exactly one of the four
   options?** Read the options before finalising the stem. If the stem no
   longer determines the answer, add the condition, population, route or
   setting until it does.

4. **"The guidelines" / "LFN" only when the document is the real subject** —
   scope of practice, crew authority, documentation rules ("Which crew may…",
   "What must be documented when…"). Never a section number.

5. **Light touch.** If a stem has no section number and already reads as a
   direct clinical question, leave it alone. Do not rewrite good questions for
   the sake of it. Keep the clinical terminology the guidelines use.

6. **Explanations:** where an explanation uses a bare number *as a name*
   ("5.11 says…", "per 8.23"), replace it with the title or the condition.
   Leave dose values and everything else exactly as they are.

7. **Options:** change an option only if it contains a section-number
   reference ("Refer to 5.11" → "Refer to the Poisoning & Overdoses guideline").
   Never change an option's clinical content or value. The apply script rejects
   any option change at a position whose original text had no section number.

## Section titles

Look them up rather than guessing:

```bash
python3 -c "import json;c=json.load(open('/home/claude/pcg-quiz/docs/data/content.json'));[print(g['number'],g['title']) for g in c['guidelines']];[print(d['number'],d['name']) for d in c['drugs']]"
```

Note 5.05 is used twice in the document (Atraumatic Hemorrhagic Stroke &
Cerebral Edema, and Cardiogenic Shock) — use each question's `title` field.

## Output — a patch file, not an edit

Do **not** modify `authoring/out/*.json`. Write
`authoring/rephrase/<YOUR_ID>.json`:

```json
{
  "q_6d5a4df232": {"stem": "New stem text?"},
  "q_5692c7bf3c": {"stem": "…", "explanation": "…"},
  "q_70b5423682": {"options": ["…", "…", "…", "…"]}
}
```

Keys are each question's `uid`. Include a question only if you changed
something, and only the fields you changed (`stem`, `explanation`, `options`).

Load the questions with Python, but **write each new stem yourself** with
judgment, question by question — a regex that deletes "in 5.02" produces
exactly the ambiguous stems rule 3 forbids. It is fine to use Python to build
and save the patch dict once you have written the text.

## Then check it

```bash
cd /home/claude/pcg-quiz
python3 tools/apply_rephrase.py authoring/rephrase/<YOUR_ID>.json --dry-run
```

This applies your patch to a temporary copy, enforces the guards, and runs the
validator, which errors on any section number left in a stem. Fix everything it
reports and re-run until clean. Do not run it without `--dry-run`; the
integrator applies all patches together.

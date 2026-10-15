# Suspected errors in the Patient Care Guidelines, edition 2026.09.15

Collected while reading every page of the PCGs to author the question bank.
These are **not** app bugs — they are things in the published document that
look wrong, contradictory, or truncated. Worth sending to whoever maintains
the guidelines.

Page numbers are **PDF page indices**, which run one ahead of the printed
footer (PDF 400 = printed "399 | Page").

Ordered roughly by clinical consequence.

---

## A. Probably dangerous if read literally

1. **Succinylcholine IM dose is missing "/kg" — 12.78, PDF p400.**
   The combative-patient-without-IV-access row reads **"3 – 4 mg IM"**. The
   standard IM dose is 3–4 mg/**kg**, and a flat 3–4 mg would be
   sub-therapeutic. The "Max 200 mg (5 mL per injection site)" qualifier on the
   same line only makes sense with a weight-based dose.

2. **Dextrose hyperkalemia qualifier is reversed between adult and pediatric —
   12.19, PDF p332.** Adult reads "D10 not required if BGL **> 250** mg/dL";
   the pediatric cell in the same row reads "D10 not required if BGL
   **< 250** mg/dL". The pediatric version would withhold dextrose from a child
   whose glucose is low.

3. **Pediatric saline bolus missing "/kg" — 12.76, PDF p398.**
   "Typical bolus doses range from **10 – 20 mL**". 10–20 mL as an absolute
   volume is not a resuscitation bolus.

4. **Octreotide mixture is off by 1000x — 12.64.** Recommended Mixture reads
   **"500 mg / 250 mL"**; the drug is dosed in micrograms (25–50 mcg bolus,
   25–50 mcg/hr). Almost certainly 500 mcg.

5. **Hyperthermia chilled-saline conditional is probably inverted — 4.05,
   PDF p85.** Both adult and pediatric ALS bands read "If temperature is < 41c
   **or if an ice bath is available** for > 41c, administer chilled (4c) normal
   saline". Read literally this makes chilled saline redundant with immersion;
   it most likely should read "if an ice bath is **not** available".

6. **Sodium bicarbonate contraindication contradicts its own dosing — 12.75.**
   Contraindications list "Pediatric patients as it may cause cerebral edema",
   yet the same page gives pediatric doses for four indications including a
   full weight-based TCA protocol.

7. **Labetalol indication almost certainly means DBP — 12.43.**
   "Pre- or Non-Thrombolytic Therapy Candidates w/**SBP >220 or SBP > 120**".
   An SBP trigger of 120 is not plausible; standard pairing is SBP >220 or
   **DBP** >120.

---

## B. Internal contradictions

8. **Potassium chloride DKA bands do not align — 12.69.** Adult splits at
   4.0–5.4 (20 mEq/L) and <4.0 (40 mEq/L); pediatrics uses a single ≤5.4 band
   at 40 mEq/L, so a child with K 4.8 receives double the adult additive.
   Verified on the page; may be intentional, but it reads like a gap.

9. **Betamethasone gestational window stated two ways — 12.10.** Pregnancy
   Considerations says 24 0/7 to **33 6/7** weeks; Special Considerations #1
   says 24 0/7 to **36 6/7** weeks.

10. **Termination-of-resuscitation figure not regenerated — 10.07, PDF p297 vs
    9.06, PDF p283.** The 2026.09.15 update summary records that "agonal" was
    removed from 9.06, and 9.06's text now reads "ECG remains in **asystole**
    after 20 minutes". The 10.07 algorithm figure still reads "**Asystole or
    agonal rhythm** after 20 minutes".

11. **Hemoglobin transfusion trigger in two units on one page — 8.02, PDF
    p177.** Indications box reads "Hgb < 7 **g/dL**"; the CCT band three lines
    below reads "hemoglobin < 7 **mg/dL**".

12. **ALS pediatric naloxone is a flat dose while BLS is weight-based — 5.11,
    PDF p123.** BLS pediatric is 0.1 mg/kg IN (max single 0.4 mg, max total
    5 mg); ALS pediatric is a flat "0.4 mg IV/IM" with no weight adjustment.

13. **ETCO₂ target differs within one guideline — 5.05 stroke.** ALS band
    (PDF p102) says 35–45; PEARL 2 (PDF p103) says 35–40 mmHg for known or
    suspected head injury including suspected herniation.

14. **Norepinephrine start dose differs from the formulary — 7.06 vs 12.63.**
    7.06 gives 0.05 mcg/kg/min; the formulary gives 0.05–0.1 mcg/kg/min. Both
    agree on max 45 mcg/min.

15. **IO lidocaine pediatric qualifier only in the formulary — 8.18 vs 12.46.**
    8.18's flowchart gives pediatric 0.5 mg/kg (max 40 mg) with no weight
    qualifier; the formulary adds "Same as adult if >20 kg". A crew reading
    only the flowchart would dose a 25 kg child differently.

16. **Cefazolin for open fractures framed differently in two guidelines —
    7.03 vs 7.04.** 7.03: >50 kg 2 g, ≤50 kg 30 mg/kg max 2 g. 7.04: 2 g adult,
    pediatric 30 mg/kg max 2 g.

17. **CMOC expanded two ways.** Glossary 10.02 (PDF p288): "Clinical
    **Administrator** On Call". 9.03 (p278) and 9.06 (p283): "Clinical
    **Manager** On Call".

18. **Droperidol missing from the LFN Medication Table — 1.03.** It is an ALS
    medication in 2.04 and has its own formulary entry (12.25), but no row
    exists between Dopamine and Esmolol.

19. **Activated charcoal inconsistent — 1.03 vs 1.06.** The medication table
    marks it CCT/ALS only and asterisks it as not carried by LFN; 1.06 lists it
    in the Oregon EMT column.

20. **Calcium chloride and calcium gluconate share identical drug-information
    text — 12.11 / 12.12.** Same Mechanism, Category, Contraindications,
    Warnings and Adverse Reactions verbatim.

21. **N-acetylcysteine Mechanism of Action is milrinone's text — 12.57.**
    A cAMP phosphodiesterase description copy-pasted into the NAC entry.

22. **Amiodarone listed twice with different mixes — 12.01.** 450 mg/250 mL
    and 400 mg/250 mL; 12.07 names only 450 mg/250 mL. The second row sits
    between Dobutamine and Epinephrine in an otherwise alphabetical table,
    suggesting a mislabelled row (possibly Dopamine).

---

## C. Content pasted into the wrong place, or truncated

23. **Vasopressor guidance inside a hyperbaric facility list — 5.11, PDF
    p130.** Item 15.d.ii reads "You may exceed the max dose if the patient
    remains hypotensive despite adequate fluid resuscitation and the initiation
    of a second vasopressor", directly after "Billings Clinic: 24/7…". The same
    sentence appears correctly as PEARL 1 of 5.13.

24. **Pediatric IBW formula truncated — 8.23, PDF p228.** The IBW Formulas box
    ends mid-list at "Age 1-5 years: (Age in years x 2) + 8"; the next line is
    clipped by the box boundary and absent from the text layer, so the formula
    for older children is unrecoverable from this document.

25. **Procedure may be missing a step — 8.08, PDF p193.** The page ends with
    "CONTINUES TO NEXT PAGE" after step 13, but p194 contains only PEARLS
    figures. Either the banner is stale or a step was lost in layout.

26. **Defibrillation step 6b is an unfinished sentence — 8.04, PDF p184.**
    "If the defibrillator is not discharged within 60 seconds" — no consequence
    clause.

27. **Surgical cricothyrotomy has no Indications/Contraindications table —
    8.32, PDF p251.** Unlike every neighbouring procedure, it opens straight
    into Equipment.

28. **Orphaned list number mid-sentence — 6.09, PDF p153.** "Specifically note
    any late or variable decelerations. **8.** Initial treatment for
    hypotension is…"

29. **Cefazolin onset/peak/duration cell is garbled — 12.13.**
    "Peak (5 minutes)Rapid / 5 min / 90-180 min".

30. **Hydromorphone onset/peak/duration has two values for three fields —
    12.37.** "15 minutes / 2-4 hours"; peak is missing.

31. **Alteplase adult dose steps mis-numbered — 12.06.** "2. Give 10% of total
    dose / 3. over 60 seconds" splits one instruction across two numbered
    items.

32. **RAM cannula sizing table half blank — 8.12, PDF p199.** Weights given for
    four of seven colours; yellow, teal and purple rows are empty.

---

## D. Typos and cosmetic

33. **"skill in intact" for "skull is intact"** — 7.04 CCT, PDF p165. The BLS
    band on p163 has it correctly.
34. **"EMR equivalent"** — 1.04. A Montana CFRN's critical care endorsement
    "allows them to function as an EMR equivalent"; EMR is normally the lowest
    EMS level, so this reads like a typo for a higher one.
35. **"hypopontine-myelinolysis"** — 5.07 PEARLS, PDF p112. Intended: central
    pontine myelinolysis / osmotic demyelination.
36. **"Diltizem"** and **"max of 15 mghr"** — 3.10 Doses/Details box, PDF p72.
37. **"regardless of weighAt"** — 12.63 special consideration 3.
38. **"Pediatric infusions should be weight based regardless of weight"** —
    12.54 Midazolam; likely "regardless of age".
39. **"Apply wrapped hot packed to axilla"** — 4.06 BLS, PDF p87.
40. **"After reacting vial sign targets"** — 5.03, PDF p97 ("vital").
41. **"a grater oxygen diffusion gradient"** — 8.12 PEARLS, PDF p199.
42. **"if target vials not met"**, **"over 1 minutes"** — 12.28 Esmolol, p343.
43. **"PEDATRIC"** — 2.03 band heading. **"CONTIUES TO NEXT PAGE"** — 3.10.
    **"Pulmponary Artery Pressure"**, **"POSTIVE"** — 10.03 / 10.06.
44. **"Uticaria"** for urticaria — 5.02 differential.
45. **Band label renders as "LS" not "ALS"** — 8.15, PDF p208; the leading A is
    cut off in both the image and the text layer.
46. **Sub-list lettering restarts or skips** — 7.01 PEARLS item 8 runs b–e with
    no "a"; item 9 runs f–g continuing the previous page. 9.04's Montana
    sub-list restarts at "c./d.". 5.10 PEARL 7 runs ii–v with no "i".
    12.05 Albuterol's Special Considerations are numbered 6 and 7.
47. **APGAR timing** — 6.01 says "at time of birth and five minutes later",
    not the conventional 1 and 5 minutes. Authored to the document, but a crew
    trained to NRP may disagree.

---

## How these were handled in the question bank

Where a value was ambiguous or contradictory, the authoring agents either
wrote the question against the unambiguous part of the row, or wrote no
question at all rather than teach a value that may be wrong. Items 1, 3, 5, 7
and 23 in particular have **no questions written against the suspect value**.
Nothing here was silently "corrected" — the app teaches the document as
published, and this list is the record of where that may be a problem.

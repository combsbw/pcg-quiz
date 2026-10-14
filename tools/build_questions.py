#!/usr/bin/env python3
"""
build_questions.py — generate source-cited multiple-choice questions and the
modular groupings that gate them.

Design rules (see DATA_CONTRACT.md):
  * Nothing is invented. Every stem, answer and distractor is text that appears
    somewhere in the guidelines. Distractors for a dose question are other real
    doses — usually another indication for the same drug — so a wrong answer is
    plausible for the right reason and the learner is discriminating between
    things that actually exist.
  * Every question carries its source (number, title, page, verbatim snippet)
    so the learner can check it against the PDF.
  * Confidence is graded, and low-confidence items are hidden by default rather
    than silently dropped, so coverage stays auditable.

Usage:  python tools/build_questions.py
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Published site folder is `docs/`; `app/` is accepted for the original layout.
DATA = next((ROOT / n / "data" for n in ("docs", "app") if (ROOT / n / "data").exists()),
            ROOT / "docs" / "data")
RNG = random.Random(20261014)

BULLET = re.compile(r"^\s*[•▪○◦o–-]\s*")
WS = re.compile(r"\s+")
ROUTES = ["IV", "IO", "IM", "IN", "PO", "SQ", "SL", "PR", "ETT", "nebulizer", "IV/IO"]
MAXLINE = re.compile(r"^\s*[•\-–]?\s*Max\b.*", re.I | re.M)


def clean(s: str) -> str:
    s = BULLET.sub("", (s or "").strip())
    return WS.sub(" ", s).strip(" •–-")


def first_line(s: str) -> str:
    for ln in (s or "").splitlines():
        c = clean(ln)
        if c:
            return c
    return ""



def cell_join(s: str) -> str:
    """Join every line of a wrapped table cell into one readable string."""
    parts = [clean(ln) for ln in (s or "").splitlines()]
    return WS.sub(" ", " ".join(p for p in parts if p)).strip()


def dose_text(s: str) -> str:
    """The dose itself, without its qualifier bullets.

    A dose cell reads as the dose on the first line(s), then bullet-prefixed
    qualifiers ("May repeat q 3-5 min", "Max single dose 1 mg"). Take lines up
    to the first bullet so a wrapped dose ("0.1 mL/kg (0.01 mg/kg) SIVP" /
    "over 2 min") stays whole without dragging the qualifiers in.
    """
    out = []
    for ln in (s or "").splitlines():
        raw = ln.strip()
        if not raw:
            continue
        if BULLET.match(raw) and out:
            break
        out.append(clean(raw))
    return WS.sub(" ", " ".join(out)).strip()


HAS_NUM = re.compile(r"\d")
# A real dose leads with its number ("1 mg IV", "0.5 - 2 mL/kg/hr", "250 mL over
# 15 min"). Text that leads with a word is a wrapped fragment that landed in the
# dose column ("with sodium < 120"), not a dose.
DOSE_START = re.compile(r"^[^A-Za-z]*\d")


def is_dose(s: str) -> bool:
    return bool(s) and bool(DOSE_START.match(s))



HEADERISH = re.compile(r"^(adult|pediatric|peds|neonatal|adult\s*(&|and)\s*pediatric|"
                       r"all patients|indications?|contraindications?|notes?)\b[: ]*$", re.I)


def is_actionable(s: str) -> bool:
    """Reject sub-headings so they never become an answer or a distractor.

    Care-level bands are internally sub-headed ("ADULT:", "PEDIATRIC:",
    "Limb Presentation"). As options these are giveaways: a learner can discard
    them on form alone without knowing the content, which makes the question
    measure nothing.
    """
    s = (s or "").strip()
    if not s or s.endswith(":"):
        return False
    if HEADERISH.match(s):
        return False
    letters = [c for c in s if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.8:
        return False                       # shouted header
    return len(s.split()) >= 3


def qid(*parts) -> str:
    h = hashlib.sha1("||".join(parts).encode("utf-8")).hexdigest()[:10]
    return f"q_{h}"


def norm(s: str) -> str:
    return WS.sub(" ", (s or "").lower()).strip(" .•")


class Bank:
    def __init__(self):
        self.items = []
        self._seen_stem = set()
        self._seen_id = set()

    def add(self, *, type, stem, answer, distractors, explanation, source,
            confidence="high", tags=(), modules=()):
        answer = clean(answer)
        if not answer or len(answer) > 170:
            return False
        pool, seen = [], {norm(answer)}
        for d in distractors:
            d = clean(d)
            if not d or len(d) > 170:
                continue
            if norm(d) in seen:
                continue
            seen.add(norm(d))
            pool.append(d)
        if len(pool) < 3:
            return False
        opts = [answer] + RNG.sample(pool, 3)
        RNG.shuffle(opts)
        key = norm(stem) + "|" + norm(answer)
        if key in self._seen_stem:
            return False
        self._seen_stem.add(key)
        i = qid(type, stem, answer)
        if i in self._seen_id:
            return False
        self._seen_id.add(i)
        self.items.append({
            "id": i, "type": type, "stem": stem, "options": opts,
            "answer": opts.index(answer),
            "explanation": WS.sub(" ", explanation or "").strip()[:400],
            "source": source, "confidence": confidence,
            "tags": sorted(set(tags)), "modules": sorted(set(modules)),
        })
        return True


# ------------------------------------------------------------------ helpers

def drug_src(d):
    return {"version": VERSION, "number": d["number"], "title": d["name"],
            "page": d["page"], "snippet": ""}


def gl_src(g, page=None, snippet=""):
    return {"version": VERSION, "number": g["number"], "title": g["title"],
            "page": page or g["page"], "snippet": WS.sub(" ", snippet)[:240]}


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


# -------------------------------------------------------------- drug modules

def pharm_class(d):
    cat = d["info"].get("Pharmacologic Category", "")
    return clean(cat).split(",")[0].split(";")[0].strip() or "Unclassified"


ALGO_KEYWORDS = [
    ("algo-arrest", "Cardiac Arrest & Post-ROSC",
     ["cardiac arrest", "rosc", "resuscitation", "traumatic arrest", "termination"]),
    ("algo-airway", "Airway & Ventilation",
     ["airway", "intubation", "rapid sequence", "ventilation", "cricothyrotomy",
      "capnography", "respiratory", "oxygen", "thoracostomy"]),
    ("algo-shock", "Shock & Hemodynamics",
     ["shock", "hypotension", "hemorrhage", "vasopressor", "sepsis", "transfusion",
      "fluid", "balloon", "ventricular assist", "impella"]),
    ("algo-rhythm", "Dysrhythmia",
     ["bradycardia", "tachycardia", "pacing", "cardioversion", "rhythm", "stemi",
      "chest pain", "acs"]),
    ("algo-neuro", "Neurologic",
     ["stroke", "seizure", "altered mental", "head injury", "intracranial",
      "cerebral", "spinal"]),
    ("algo-tox", "Toxicology & Environmental",
     ["poison", "overdose", "envenomation", "hypothermia", "hyperthermia",
      "drowning", "burn", "electrical", "dive", "carbon monoxide"]),
    ("algo-ob", "Obstetric & Neonatal",
     ["obstetric", "delivery", "labor", "partum", "neonat", "eclampsia",
      "pregnan", "newborn"]),
    ("algo-trauma", "Trauma",
     ["trauma", "fracture", "amputation", "crush", "tourniquet", "hemostatic",
      "suspension", "blast"]),
    ("algo-sedation", "Sedation & Analgesia",
     ["sedation", "pain", "analgesia", "combative", "restraint", "paralytic"]),
]


def algo_modules(title, text=""):
    t = (title + " " + text[:400]).lower()
    hits = [mid for mid, _lab, kws in ALGO_KEYWORDS if any(k in t for k in kws)]
    return hits[:2]


# ----------------------------------------------------------------- generator

def gen_drugs(content, bank):
    drugs = content["drugs"]
    by_class = defaultdict(list)
    for d in drugs:
        by_class[pharm_class(d)].append(d)

    # all first-line doses, for cross-drug distractors of the same shape
    all_adult = [(d, r, dose_text(r["adult"])) for d in drugs for r in d["doses"]
                 if is_dose(dose_text(r["adult"]))]
    all_peds = [(d, r, dose_text(r["pediatric"])) for d in drugs for r in d["doses"]
                if is_dose(dose_text(r["pediatric"]))]

    for d in drugs:
        name = d["name"]
        cls = pharm_class(d)
        mods = ["sec-12", f"drug-{slugify(cls)}"] + algo_modules(name, d.get("text", ""))
        base_tags = [f"drug:{slugify(name)}", f"class:{slugify(cls)}"]

        for field, label, allrows in (("adult", "adult", all_adult),
                                      ("pediatric", "pediatric", all_peds)):
            for row in d["doses"]:
                ind = cell_join(row["indication"])
                dose = dose_text(row[field])
                if (not ind or not dose or norm(dose).startswith("same as")
                        or not is_dose(dose)):
                    continue       # answers must be real, number-leading doses
                # distractors: other indications of THIS drug first, then same-class
                same_drug = [x for x in (dose_text(r[field]) for r in d["doses"] if r is not row) if is_dose(x)]
                same_class = [t for dd, rr, t in allrows
                              if dd is not d and pharm_class(dd) == cls]
                other = [t for dd, rr, t in allrows if dd is not d]
                distr = [x for x in same_drug if x] + same_class + RNG.sample(
                    other, min(len(other), 40))
                snippet = WS.sub(" ", f"{ind}: {row[field]}")
                bank.add(
                    type="drug_dose",
                    stem=f"{name} — what is the {label} dose for {ind}?",
                    answer=dose, distractors=distr,
                    explanation=f"{name}, {ind} — {label} dose: {WS.sub(' ', row[field])}",
                    source={**drug_src(d), "snippet": snippet},
                    confidence="high" if len(dose) < 60 else "medium",
                    tags=base_tags + [f"indication:{slugify(ind)}", f"pop:{label}"],
                    modules=mods + ["pop-peds"] if field == "pediatric" else mods,
                )

                # maximum dose, when the row states one
                for m in MAXLINE.findall(row[field]):
                    mx = clean(m)
                    if not mx or len(mx) < 6:
                        continue
                    others = [clean(x) for dd in drugs for r2 in dd["doses"]
                              for x in MAXLINE.findall(r2[field])
                              if clean(x) and clean(x) != mx]
                    bank.add(
                        type="max_dose",
                        stem=f"{name} ({ind}) — what maximum is specified for the {label} dose?",
                        answer=mx, distractors=others,
                        explanation=f"{name}, {ind} — {label}: {WS.sub(' ', row[field])}",
                        source={**drug_src(d), "snippet": snippet},
                        confidence="high",
                        tags=base_tags + ["max-dose", f"pop:{label}"],
                        modules=mods + ["topic-max-dose"],
                    )

                # route
                r_hits = [rt for rt in ROUTES
                          if re.search(rf"\b{re.escape(rt)}\b", dose)]
                if len(r_hits) == 1 and field == "adult":
                    bank.add(
                        type="route",
                        stem=f"{name} for {ind} — by what route is the adult dose given?",
                        answer=r_hits[0],
                        distractors=[r for r in ROUTES if r != r_hits[0]],
                        explanation=f"{name}, {ind} — adult: {WS.sub(' ', row['adult'])}",
                        source={**drug_src(d), "snippet": snippet},
                        confidence="high",
                        tags=base_tags + ["route"],
                        modules=mods + ["topic-route"],
                    )

        # reverse: dose -> indication
        if len(d["doses"]) >= 4:
            for row in d["doses"]:
                ind = cell_join(row["indication"])
                dose = dose_text(row["adult"])
                if (not ind or not dose or norm(dose).startswith("same as")
                        or not is_dose(dose)):
                    continue
                # only indications from rows that carry a real dose: a row
                # without one is a wrapped fragment, not an indication
                others = [cell_join(r["indication"]) for r in d["doses"]
                          if r is not row and is_dose(dose_text(r["adult"]))
                          and len(cell_join(r["indication"]).split()) >= 2]
                bank.add(
                    type="drug_indication",
                    stem=f"An adult dose of {dose} of {name} corresponds to which indication?",
                    answer=ind, distractors=others,
                    explanation=f"{name}: {ind} — {WS.sub(' ', row['adult'])}",
                    source={**drug_src(d), "snippet": WS.sub(' ', f'{ind}: {row["adult"]}')},
                    confidence="high",
                    tags=[f"drug:{slugify(name)}", "reverse"],
                    modules=mods + ["topic-indication"],
                )

        # drug information fields
        for field in ("Pharmacologic Category", "Mechanism of Action",
                      "Contraindications", "Adverse Reactions", "Trade Name",
                      "Onset / Peak / Duration"):
            val = clean(d["info"].get(field, ""))
            if not val or len(val) > 170:
                continue
            others = [clean(dd["info"].get(field, "")) for dd in drugs if dd is not d]
            others = [o for o in others if o]
            same_cls = [clean(dd["info"].get(field, "")) for dd in by_class[cls]
                        if dd is not d and clean(dd["info"].get(field, ""))]
            bank.add(
                type="drug_info",
                stem=f"{name} — {field.lower()}?",
                answer=val, distractors=same_cls + others,
                explanation=f"{name} — {field}: {val}",
                source={**drug_src(d), "snippet": f"{field}: {val}"},
                confidence="high" if field != "Mechanism of Action" else "medium",
                tags=[f"drug:{slugify(name)}", f"field:{slugify(field)}"],
                modules=mods + [f"topic-{slugify(field)}"],
            )

    # comparison module: same pharmacologic class, which drug is which
    for cls, members in by_class.items():
        if len(members) < 3 or cls == "Unclassified":
            continue
        for d in members:
            tn = clean(d["info"].get("Trade Name", ""))
            if not tn or len(tn) > 60:
                continue
            others = [clean(m["info"].get("Trade Name", "")) for m in members if m is not d]
            bank.add(
                type="compare",
                stem=f"Among {cls.lower()} agents, which trade name belongs to {d['name']}?",
                answer=tn, distractors=[o for o in others if o],
                explanation=f"{d['name']} — Trade Name: {tn}",
                source={**drug_src(d), "snippet": f"Trade Name: {tn}"},
                confidence="high",
                tags=[f"class:{slugify(cls)}", "compare"],
                modules=["cmp-" + slugify(cls), f"drug-{slugify(cls)}"],
            )


def gen_guidelines(content, bank):
    gls = content["guidelines"]
    by_section = defaultdict(list)
    for g in gls:
        by_section[g["section_number"]].append(g)

    # pool of bullets per care level, for cross-guideline distractors
    pool = defaultdict(list)
    for g in gls:
        for b in g["blocks"]:
            for s in b["bullets"]:
                if 14 <= len(s) <= 150 and is_actionable(s):
                    pool[b["care_level"]].append((g, s))

    for g in gls:
        sec = g["section_number"]
        mods = [f"sec-{sec}"] + algo_modules(g["title"])
        for b in g["blocks"]:
            lvl = b["care_level"]
            if lvl == "BODY":
                continue
            bullets = [s for s in b["bullets"]
                       if 14 <= len(s) <= 150 and is_actionable(s)]
            if not bullets:
                continue
            lvl_mods = mods + [f"cl-{lvl.lower()}"]

            # which action belongs to this guideline+level
            for s in bullets[:6]:
                others = [t for gg, t in pool[lvl]
                          if gg["number"] != g["number"]
                          and gg["section_number"] != sec]
                if len(others) < 3:
                    others = [t for gg, t in pool[lvl] if gg["number"] != g["number"]]
                bank.add(
                    type="guideline_step",
                    stem=f"{g['number']} {g['title']} — which of these is listed under {lvl}?",
                    answer=s, distractors=RNG.sample(others, min(len(others), 40)),
                    explanation=f"{g['number']} {g['title']} — {lvl}: {s}",
                    source=gl_src(g, b["page"], s),
                    confidence="high" if len(s) < 110 else "medium",
                    tags=[f"guideline:{g['id']}", f"care-level:{lvl.lower()}"],
                    modules=lvl_mods,
                )

            # which guideline does this action come from
            sibs = [x["title"] for x in by_section[sec] if x["number"] != g["number"]]
            if len(sibs) >= 3:
                for s in bullets[:2]:
                    bank.add(
                        type="guideline_match",
                        stem=f"“{s}” is listed under {lvl} in which guideline?",
                        answer=g["title"], distractors=sibs,
                        explanation=f"{g['number']} {g['title']} — {lvl}: {s}",
                        source=gl_src(g, b["page"], s),
                        confidence="medium",
                        tags=[f"guideline:{g['id']}", "reverse"],
                        modules=lvl_mods,
                    )

        # care-level scope: a bullet unique to one band of this guideline
        texts = {b["care_level"]: " ".join(b["bullets"]).lower() for b in g["blocks"]}
        levels = [l for l in ("BLS", "ALS", "CCT") if l in texts]
        if len(levels) >= 2:
            for b in g["blocks"]:
                if b["care_level"] not in levels:
                    continue
                for s in b["bullets"][:4]:
                    if not (20 <= len(s) <= 130) or not is_actionable(s):
                        continue
                    key = norm(s)[:40]
                    if sum(1 for l in levels if key in texts[l]) != 1:
                        continue
                    bank.add(
                        type="care_level_scope",
                        stem=f"In {g['number']} {g['title']}, at which level is “{s}” listed?",
                        answer=b["care_level"],
                        distractors=[l for l in ("BLS", "ALS", "CCT", "PEARLS")
                                     if l != b["care_level"]],
                        explanation=f"{g['number']} {g['title']} — {b['care_level']}: {s}",
                        source=gl_src(g, b["page"], s),
                        confidence="high",
                        tags=[f"guideline:{g['id']}", "scope"],
                        modules=mods + [f"cl-{b['care_level'].lower()}", "topic-scope"],
                    )
                    break


# ------------------------------------------------------------------- modules


TARGET_MODULE = 55          # questions per module; keeps a day's "due" pile sane
MAX_MODULE = 85


def _numkey(q):
    """Sort key from the source number ('5.01', '12.26') for stable chunking."""
    n = q["source"]["number"]
    m = re.match(r"(\d+)\.(\d+)", n)
    return (int(m.group(1)), int(m.group(2))) if m else (999, 0)


def chunk_module(mid, label, qs, sublabel_fn=None):
    """Split an oversized module into ordered, semantically labelled chunks.

    A 900-question "Procedures" module would make every card due at once, which
    is the exact failure the brief calls out. Chunks follow the document's own
    numbering so each one is a contiguous, nameable slice the learner can
    reason about ("Procedures 8.01-8.09") rather than an arbitrary shard.
    """
    qs = sorted(qs, key=_numkey)
    if len(qs) <= MAX_MODULE:
        return [{"id": mid, "label": label, "subtitle": sublabel_fn(qs) if sublabel_fn else "",
                 "group": label, "question_count": len(qs),
                 "question_ids": [q["id"] for q in qs], "prereq": []}]
    # Pack whole source items into chunks rather than slicing at an arbitrary
    # question index. Splitting mid-subsection produced overlapping labels
    # ("2.02-2.05" followed by "2.05-2.07") and scattered one guideline across
    # two modules, which defeats the point of a nameable slice.
    by_num = {}
    for q in qs:
        by_num.setdefault(q["source"]["number"], []).append(q)
    groups = sorted(by_num.items(), key=lambda kv: _numkey(kv[1][0]))

    target = max(TARGET_MODULE, -(-len(qs) // max(1, round(len(qs) / TARGET_MODULE))))
    chunks, cur = [], []
    for num, items in groups:
        if cur and len(cur[1]) + len(items) > target and len(cur[1]) >= target * 0.55:
            chunks.append(cur)
            cur = None
        if cur is None or not cur:
            cur = [num, list(items), num]
        else:
            cur[1].extend(items)
            cur[2] = num
    if cur:
        chunks.append(cur)

    out, prev = [], None
    for i, (a, items, b) in enumerate(chunks):
        pid = f"{mid}-p{i + 1}"
        span = a if a == b else f"{a}\u2013{b}"
        out.append({"id": pid, "label": f"{label} {span}",
                    "subtitle": f"{len(items)} questions",
                    "group": label, "question_count": len(items),
                    "question_ids": [q["id"] for q in items],
                    "prereq": [prev] if prev else []})
        prev = pid
    return out


def build_modules(content, items):
    by_mod = defaultdict(list)
    for q in items:
        for m in q["modules"]:
            by_mod[m].append(q["id"])

    sec_titles = {s["number"]: s["title"] for s in content["sections"]}
    algo_labels = {mid: lab for mid, lab, _ in ALGO_KEYWORDS}
    cls_counts = defaultdict(int)
    for d in content["drugs"]:
        cls_counts[pharm_class(d)] += 1

    qmap = {q["id"]: q for q in items}

    def mk(mid, label, subtitle):
        qs = [qmap[i] for i in by_mod.get(mid, [])]
        if not qs:
            return []
        parts = chunk_module(mid, label, qs)
        if len(parts) == 1:
            parts[0]["subtitle"] = subtitle
        return parts

    def flat(lst):
        out = []
        for x in lst:
            out.extend(x)
        return out

    tax = []

    sec_mods = flat([mk(f"sec-{n}", sec_titles[n], f"Section {n}")
                     for n in sorted(sec_titles, key=int) if by_mod.get(f"sec-{n}")])
    tax.append({"id": "section", "label": "Guideline Section",
                "description": "Mirrors the document's own organization — the fastest way to study one area at a time.",
                "default": True, "modules": sec_mods})

    cl_mods = flat([mk(f"cl-{l}", l.upper(),
                  {"bls": "Basic Life Support scope", "als": "Advanced Life Support scope",
                   "cct": "Critical Care Transport scope",
                   "pearls": "Clinical pearls and caveats"}[l])
                    for l in ("bls", "als", "cct", "pearls") if by_mod.get(f"cl-{l}")])
    tax.append({"id": "care-level", "label": "Care Level",
                "description": "Scope of practice first: learn your level, then the level above it.",
                "default": False, "modules": cl_mods})

    drug_mods = []
    for cls, n in sorted(cls_counts.items(), key=lambda kv: -kv[1]):
        mid = f"drug-{slugify(cls)}"
        if by_mod.get(mid) and cls != "Unclassified":
            drug_mods.extend(mk(mid, cls, f"{n} agent{'s' if n != 1 else ''}"))
    tax.append({"id": "drug-class", "label": "Drug & Mechanism",
                "description": "Formulary grouped by pharmacologic class, so related agents are learned against each other.",
                "default": False, "modules": drug_mods})

    algo_mods = flat([mk(mid, lab, "Treatment algorithm family")
                      for mid, lab in algo_labels.items() if by_mod.get(mid)])
    tax.append({"id": "algorithm", "label": "Algorithm Family",
                "description": "Cuts across sections: everything touching arrest, airway, shock and so on, including where algorithms fork.",
                "default": False, "modules": algo_mods})

    topic_labels = {
        "topic-max-dose": ("Maximum Doses", "Ceiling doses across the formulary"),
        "topic-route": ("Routes of Administration", "Which route for which indication"),
        "topic-indication": ("Dose → Indication", "Reverse recall: match a dose to its use"),
        "topic-scope": ("Scope Boundaries", "Which level may do what"),
        "topic-pharmacologic-category": ("Drug Classes", "Agent to class"),
        "topic-mechanism-of-action": ("Mechanisms of Action", "How each agent works"),
        "topic-contraindications": ("Contraindications", "When not to give it"),
        "topic-adverse-reactions": ("Adverse Reactions", "What to watch for"),
        "topic-trade-name": ("Trade Names", "Generic to brand"),
        "topic-onset-peak-duration": ("Onset / Peak / Duration", "Pharmacokinetics"),
        "pop-peds": ("Pediatric Dosing", "Weight-based and pediatric-specific doses"),
    }
    cmp_mods = flat([mk(m, f"Compare: {m[4:].replace('-', ' ').title()}",
                        "Discriminate between similar agents")
                     for m in sorted(by_mod) if m.startswith("cmp-")])
    topic_mods = flat([mk(m, *topic_labels[m]) for m in topic_labels if by_mod.get(m)])
    tax.append({"id": "comparison", "label": "Cross-Cutting & Comparison",
                "description": "Semantic compression: one concept pulled from everywhere it appears, plus drills that force discrimination between lookalikes.",
                "default": False, "modules": topic_mods + cmp_mods})

    for t in tax:
        t["modules"] = [m for m in t["modules"] if m["question_count"] >= 5]
    return {"taxonomies": tax}


def main():
    global VERSION
    content = json.loads((DATA / "content.json").read_text(encoding="utf-8"))
    VERSION = content["version"]
    bank = Bank()
    gen_drugs(content, bank)
    gen_guidelines(content, bank)
    items = bank.items

    # The reveal screen shows the verbatim source snippet *and* the
    # explanation. For most generated items the explanation is a restatement of
    # the same sentence, so the learner reads the same text twice at exactly the
    # moment they are trying to absorb it. Where the explanation adds nothing
    # beyond the snippet, drop it and let the cited quote stand alone.
    def _tokens(x):
        return set(re.findall(r"[a-z0-9]+", (x or "").lower()))

    dropped = 0
    for q in items:
        snip, expl = q["source"].get("snippet", ""), q.get("explanation", "")
        st, et = _tokens(snip), _tokens(expl)
        if not st or not et:
            continue
        covered = len(st & et) / len(st)          # snippet covered by explanation
        adds = len(et - st)                        # genuinely new words
        if covered >= 0.8 and adds <= 4:
            q["explanation"] = ""
            dropped += 1

    mods = build_modules(content, items)
    # Rebuild each question's module list from actual chunk membership: chunking
    # renames ids (sec-5 -> sec-5-p2), so the pre-chunk labels on the question
    # are stale. Membership in the emitted modules is the single source of truth.
    membership = defaultdict(list)
    for t in mods["taxonomies"]:
        for m in t["modules"]:
            for qid_ in m["question_ids"]:
                membership[qid_].append(m["id"])
    for q in items:
        q["modules"] = sorted(membership.get(q["id"], []))
    orphan = [q for q in items if not q["modules"]]

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (DATA / "questions.json").write_text(json.dumps(
        {"version": VERSION, "generated": now, "questions": items},
        ensure_ascii=False), encoding="utf-8")
    (DATA / "modules.json").write_text(json.dumps(
        {"version": VERSION, "generated": now, **mods},
        ensure_ascii=False), encoding="utf-8")

    from collections import Counter
    print(f"questions: {len(items)}  orphan(no module): {len(orphan)}  redundant explanations dropped: {dropped}")
    print("  by type:", dict(Counter(q["type"] for q in items)))
    print("  by confidence:", dict(Counter(q["confidence"] for q in items)))
    for t in mods["taxonomies"]:
        print(f"  taxonomy {t['id']}: {len(t['modules'])} modules, "
              f"sizes {[m['question_count'] for m in t['modules']][:12]}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
merge_questions.py — build docs/data/questions.json and modules.json from the
agent-authored batches in authoring/out/.

This REPLACES the old algorithmically generated bank entirely. Nothing from the
previous generator survives: that set asked backwards questions ("a dose of X
corresponds to which indication?") and list-membership questions ("which of
these is listed under BLS?"), which test page memorisation rather than whether
someone can treat a patient.

Responsibilities here:
  * assign stable ids (hash of type+stem+answer, so a question keeps its id —
    and therefore its scheduling history — across rebuilds)
  * attach the `source` block the app's reveal screen cites
  * assign modules across the five taxonomies, chunked so no module is large
    enough to dump a day's worth of new cards at once
  * refuse to emit anything that fails a final structural check

Usage:  python3 tools/merge_questions.py
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data"
AUTHORED = ROOT / "authoring" / "out"

TARGET_MODULE = 55
MAX_MODULE = 85
MIN_MODULE = 5


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def qid(q):
    h = hashlib.sha1(
        f"{q['type']}||{q['stem']}||{q['options'][q['answer_index']]}"
        .encode("utf-8")).hexdigest()[:10]
    return f"q_{h}"


# --- taxonomy helpers -------------------------------------------------------

ALGO = [
    ("algo-arrest", "Cardiac Arrest & Post-ROSC",
     ["cardiac arrest", "rosc", "resuscitation", "traumatic arrest",
      "termination", "defibrillation", "cpr", "pacing", "cardioversion"]),
    ("algo-airway", "Airway & Ventilation",
     ["airway", "intubation", "rapid sequence", "rsi", "ventilation",
      "cricothyrotomy", "capnography", "etco2", "respiratory", "oxygen",
      "thoracostomy", "cpap", "bipap", "hfnc", "king airway", "i-gel",
      "nebulizer", "asthma", "copd", "croup", "epiglottitis", "chest tube"]),
    ("algo-shock", "Shock & Hemodynamics",
     ["shock", "hypotension", "hemorrhage", "vasopressor", "sepsis",
      "transfusion", "blood product", "fluid", "balloon pump", "impella",
      "ventricular assist", "hemodynamic", "push dose"]),
    ("algo-rhythm", "Dysrhythmia & ACS",
     ["bradycardia", "tachycardia", "rhythm", "stemi", "chest pain", "acs",
      "12-lead", "ecg"]),
    ("algo-neuro", "Neurologic",
     ["stroke", "seizure", "altered mental", "head injury", "intracranial",
      "cerebral", "spinal", "icp"]),
    ("algo-tox", "Toxicology & Environmental",
     ["poison", "overdose", "envenomation", "hypothermia", "hyperthermia",
      "drowning", "burn", "altitude", "decompression", "frost"]),
    ("algo-ob", "Obstetric & Neonatal",
     ["obstetric", "delivery", "labor", "partum", "neonat", "eclampsia",
      "pregnan", "newborn", "childbirth", "hellp", "vaginal"]),
    ("algo-trauma", "Trauma",
     ["trauma", "fracture", "amputation", "crush", "tourniquet", "hemostatic",
      "suspension", "entrapment", "pelvic", "extremity"]),
    ("algo-sedation", "Sedation & Analgesia",
     ["sedation", "pain", "analgesia", "combative", "anxiolysis", "paralytic",
      "post-intubation"]),
]

TOPIC_LABELS = {
    "topic-dose": ("Dosing", "Every drug dose in the guidelines"),
    "topic-max": ("Maximum Doses", "Ceiling doses across the formulary"),
    "topic-indication": ("Indications", "When each treatment applies"),
    "topic-contra": ("Contraindications", "When not to"),
    "topic-procedure": ("Procedures & Landmarks", "Steps, sites and confirmation"),
    "topic-threshold": ("Numbers & Thresholds", "Trigger values and targets"),
    "topic-pearl": ("Clinical Pearls", "The caveats that catch people out"),
    "topic-assessment": ("Assessment", "What to look for and monitor"),
    "topic-scope": ("Scope of Practice", "Who may do what"),
    "pop-peds": ("Pediatric", "Pediatric and neonatal specifics"),
}

TYPE_TOPIC = {
    "dose": "topic-dose", "max_dose": "topic-max", "route": "topic-dose",
    "indication": "topic-indication", "contraindication": "topic-contra",
    "procedure": "topic-procedure", "landmark": "topic-procedure",
    "equipment": "topic-procedure", "sequence": "topic-procedure",
    "threshold": "topic-threshold", "pearl": "topic-pearl",
    "assessment": "topic-assessment", "scope": "topic-scope",
}


def algo_modules(title, tags):
    hay = (title + " " + " ".join(tags)).lower()
    return [mid for mid, _lab, kws in ALGO if any(k in hay for k in kws)][:2]


def numkey(number):
    m = re.match(r"(\d+)\.(\d+)", str(number))
    return (int(m.group(1)), int(m.group(2))) if m else (999, 0)


def chunk(mid, label, items, subtitle=""):
    """Split a module along section boundaries so each chunk is a nameable
    span and no guideline is scattered across two chunks of one taxonomy."""
    items = sorted(items, key=lambda q: (numkey(q["source"]["number"]), q["id"]))
    if len(items) <= MAX_MODULE:
        return [{"id": mid, "label": label, "subtitle": subtitle or f"{len(items)} questions",
                 "group": label, "question_count": len(items),
                 "question_ids": [q["id"] for q in items], "prereq": []}]
    by_num = defaultdict(list)
    for q in items:
        by_num[q["source"]["number"]].append(q)
    groups = sorted(by_num.items(), key=lambda kv: numkey(kv[0]))
    target = max(TARGET_MODULE, -(-len(items) // max(1, round(len(items) / TARGET_MODULE))))
    chunks, cur = [], None
    for num, qs in groups:
        if cur and len(cur[1]) + len(qs) > target and len(cur[1]) >= target * 0.55:
            chunks.append(cur)
            cur = None
        if cur is None:
            cur = [num, list(qs), num]
        else:
            cur[1].extend(qs)
            cur[2] = num
    if cur:
        chunks.append(cur)
    # A trailing chunk can come out tiny when the last section is small. A
    # 1-question module is noise in the picker, so fold anything under a third
    # of target back into the chunk before it.
    floor = max(MIN_MODULE, target // 3)
    merged = []
    for c in chunks:
        if merged and len(c[1]) < floor:
            merged[-1][1].extend(c[1])
            merged[-1][2] = c[2]
        else:
            merged.append(c)
    chunks = merged
    out, prev = [], None
    for i, (a, qs, b) in enumerate(chunks):
        pid = f"{mid}-p{i+1}"
        span = a if a == b else f"{a}–{b}"
        out.append({"id": pid, "label": f"{label} {span}",
                    "subtitle": f"{len(qs)} questions", "group": label,
                    "question_count": len(qs),
                    "question_ids": [q["id"] for q in qs],
                    "prereq": [prev] if prev else []})
        prev = pid
    return out


def main():
    content = json.loads((OUT / "content.json").read_text(encoding="utf-8"))
    version = content["version"]
    sec_title = {g["number"]: g["section_title"] for g in content["guidelines"]}
    sec_num = {g["number"]: g["section_number"] for g in content["guidelines"]}
    drug_class = {}
    for d in content["drugs"]:
        cat = (d["info"].get("Pharmacologic Category") or "").split(",")[0]
        cat = re.sub(r"\s+", " ", cat).strip() or "Unclassified"
        drug_class[d["number"]] = cat
        sec_title[d["number"]] = "Formulary"
        sec_num[d["number"]] = "12"

    items, seen_id, dropped = [], set(), Counter()
    for f in sorted(AUTHORED.glob("*.json")):
        batch = json.loads(f.read_text(encoding="utf-8"))
        for q in batch.get("questions", []):
            opts = q.get("options") or []
            ai = q.get("answer_index")
            if len(opts) != 4 or not isinstance(ai, int) or not 0 <= ai < 4:
                dropped["malformed"] += 1
                continue
            if len({o.strip().lower() for o in opts}) != 4:
                dropped["dup_options"] += 1
                continue
            num = str(q["number"])
            rec = {
                "id": "", "type": q["type"], "stem": q["stem"].strip(),
                "options": [o.strip() for o in opts], "answer": ai,
                "explanation": (q.get("explanation") or "").strip(),
                "source": {"version": version, "number": num,
                           "title": q.get("title", ""), "page": q.get("page"),
                           "snippet": ""},
                "care_level": q.get("care_level"),
                "population": q.get("population"),
                "confidence": "high" if q.get("priority") == "core" else "medium",
                "priority": q.get("priority", "core"),
                "tags": sorted(set(q.get("tags") or [])),
                "modules": [],
            }
            rec["id"] = qid({"type": rec["type"], "stem": rec["stem"],
                             "options": rec["options"], "answer_index": ai})
            if rec["id"] in seen_id:
                dropped["duplicate"] += 1
                continue
            seen_id.add(rec["id"])
            items.append(rec)

    # ---- module assignment -------------------------------------------------
    buckets = defaultdict(list)
    for q in items:
        num = q["source"]["number"]
        sn = sec_num.get(num, num.split(".")[0])
        buckets[f"sec-{sn}"].append(q)

        if q.get("care_level"):
            buckets[f"cl-{q['care_level'].lower()}"].append(q)

        if num.startswith("12."):
            cls = drug_class.get(num, "Unclassified")
            if cls != "Unclassified":
                buckets[f"drug-{slugify(cls)}"].append(q)

        for mid in algo_modules(q["source"]["title"], q["tags"]):
            buckets[mid].append(q)

        t = TYPE_TOPIC.get(q["type"])
        if t:
            buckets[t].append(q)
        if q.get("population") in ("pediatric", "neonatal"):
            buckets["pop-peds"].append(q)

    sec_label = {}
    for num, sn in sec_num.items():
        sec_label.setdefault(f"sec-{sn}", sec_title.get(num, f"Section {sn}"))

    def mk(mid, label, subtitle=""):
        qs = buckets.get(mid, [])
        return chunk(mid, label, qs, subtitle) if len(qs) >= MIN_MODULE else []

    def flat(lists):
        out = []
        for x in lists:
            out.extend(x)
        return out

    tax = [
        {"id": "section", "label": "Guideline Section",
         "description": "Mirrors the document's own organization — the fastest way to study one area at a time.",
         "default": True,
         "modules": flat([mk(k, sec_label[k]) for k in
                          sorted(sec_label, key=lambda k: int(k.split("-")[1]))])},
        {"id": "care-level", "label": "Care Level",
         "description": "Scope of practice first: learn your level, then the level above it.",
         "default": False,
         "modules": flat([mk(f"cl-{l}", l.upper(), d) for l, d in
                          [("bls", "Basic Life Support scope"),
                           ("als", "Advanced Life Support scope"),
                           ("cct", "Critical Care Transport scope"),
                           ("pearls", "Clinical pearls and caveats")]])},
        {"id": "drug-class", "label": "Drug & Mechanism",
         "description": "Formulary grouped by pharmacologic class, so related agents are learned against each other.",
         "default": False,
         "modules": flat([mk(f"drug-{slugify(c)}", c) for c in
                          sorted({v for v in drug_class.values() if v != "Unclassified"})])},
        {"id": "algorithm", "label": "Algorithm Family",
         "description": "Cuts across sections: everything touching arrest, airway, shock and so on, including where algorithms fork.",
         "default": False,
         "modules": flat([mk(mid, lab, "Treatment algorithm family")
                          for mid, lab, _ in ALGO])},
        {"id": "comparison", "label": "Cross-Cutting",
         "description": "One concept pulled from everywhere it appears — all the doses, all the thresholds, all the contraindications.",
         "default": False,
         "modules": flat([mk(k, *TOPIC_LABELS[k]) for k in TOPIC_LABELS])},
    ]

    membership = defaultdict(list)
    for t in tax:
        for m in t["modules"]:
            for i in m["question_ids"]:
                membership[i].append(m["id"])
    for q in items:
        q["modules"] = sorted(membership.get(q["id"], []))
        q.pop("priority", None)
    orphan = [q for q in items if not q["modules"]]

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (OUT / "questions.json").write_text(json.dumps(
        {"version": version, "generated": now, "authored": True,
         "questions": items}, ensure_ascii=False), encoding="utf-8")
    (OUT / "modules.json").write_text(json.dumps(
        {"version": version, "generated": now, "taxonomies": tax},
        ensure_ascii=False), encoding="utf-8")

    print(f"questions: {len(items)}  orphan: {len(orphan)}  dropped: {dict(dropped)}")
    print("  types:", dict(Counter(q["type"] for q in items).most_common()))
    print("  sections covered:", len({q['source']['number'] for q in items}))
    for t in tax:
        sizes = [m["question_count"] for m in t["modules"]]
        print(f"  {t['id']}: {len(t['modules'])} modules, "
              f"min {min(sizes) if sizes else 0} max {max(sizes) if sizes else 0}")


if __name__ == "__main__":
    main()

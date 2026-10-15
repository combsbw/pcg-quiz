#!/usr/bin/env python3
"""
validate_authored.py — check an authored question batch before it is merged.

Two kinds of check:

  Structural — schema, option count, answer index in range, duplicate stems,
  options that give the answer away by shape (the correct one being much the
  longest is the classic tell), forbidden framings.

  Grounded — the numbers in a dose/max/threshold answer must actually appear in
  the text of the page the question cites. This is the guard against an
  authoring agent writing a plausible number that is not in the document. It
  cannot prove a question is clinically right, but it catches invention, which
  is the failure that matters most here.

Usage:
    python3 tools/validate_authored.py authoring/out/G05.json
    python3 tools/validate_authored.py authoring/out/*.json --quiet
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF = "/root/.claude/uploads/1e05ed93-1e78-5825-a7f6-fb7980293b89/93ea7f77-2026-09-15_PCGs.pdf"

TYPES = {
    "indication", "treatment", "dose", "max_dose", "route", "sequence",
    "threshold", "contraindication", "scope", "assessment", "procedure",
    "landmark", "complication", "equipment", "class", "adverse", "mechanism",
    "pearl", "special",
}
LEVELS = {"BLS", "ALS", "CCT", "PEARLS", None}
POPS = {"adult", "pediatric", "neonatal", "both", None}

BAD_STEM = [
    (re.compile(r"\b(dose|dosage)\b[^?]*\bcorresponds to\b", re.I),
     "reverse lookup framing (value -> indication)"),
    (re.compile(r"which of these is listed", re.I), "list-membership framing"),
    (re.compile(r"which of the following is true", re.I), "vague 'is true' framing"),
    (re.compile(r"\bis NOT\b"), "negative stem"),
]
BAD_OPTION = re.compile(r"^(all|none) of the above|^both [ab]\b", re.I)

NUM = re.compile(r"\d+(?:\.\d+)?")
NUMERIC_TYPES = {"dose", "max_dose", "threshold"}

_page_cache: dict[int, str] = {}


def page_text(pno: int) -> str:
    if pno not in _page_cache:
        try:
            import pymupdf
        except ImportError:
            return ""
        global _doc
        try:
            _doc
        except NameError:
            _doc = pymupdf.open(PDF)
        if 1 <= pno <= _doc.page_count:
            _page_cache[pno] = _doc[pno - 1].get_text()
        else:
            _page_cache[pno] = ""
    return _page_cache[pno]


def norm_num(s: str) -> str:
    """'0.30' -> '0.3', '1.0' -> '1' so formatting differences do not trip it."""
    try:
        f = float(s)
        return ("%g" % f)
    except ValueError:
        return s


def numbers_in(s: str) -> set:
    return {norm_num(n) for n in NUM.findall(s or "")}


def check_batch(path: Path, sections_by_number: dict, strict_pages=True):
    errs, warns = [], []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"{path.name}: unreadable JSON — {e}"], []

    qs = data.get("questions")
    if not isinstance(qs, list) or not qs:
        return [f"{path.name}: no questions array"], []

    seen_stems = {}
    for i, q in enumerate(qs):
        tag = f"{path.name}[{i}] {q.get('number','?')}"

        for f in ("number", "title", "page", "type", "stem", "options",
                  "answer_index", "explanation"):
            if f not in q:
                errs.append(f"{tag}: missing field '{f}'")
        if errs and f"{tag}: missing field 'options'" in errs:
            continue

        if q.get("type") not in TYPES:
            errs.append(f"{tag}: bad type {q.get('type')!r}")
        if q.get("care_level") not in LEVELS:
            errs.append(f"{tag}: bad care_level {q.get('care_level')!r}")
        if q.get("population") not in POPS:
            errs.append(f"{tag}: bad population {q.get('population')!r}")

        opts = q.get("options") or []
        if len(opts) != 4:
            errs.append(f"{tag}: {len(opts)} options (need exactly 4)")
            continue
        if len({o.strip().lower() for o in opts}) != 4:
            errs.append(f"{tag}: duplicate options")
        ai = q.get("answer_index")
        if not isinstance(ai, int) or not 0 <= ai < 4:
            errs.append(f"{tag}: answer_index {ai!r} out of range")
            continue
        for o in opts:
            if BAD_OPTION.search(o):
                errs.append(f"{tag}: forbidden option {o!r}")

        stem = q.get("stem", "")
        for rx, why in BAD_STEM:
            if rx.search(stem):
                errs.append(f"{tag}: {why} — {stem[:70]!r}")
        if len(stem) < 15:
            errs.append(f"{tag}: stem too short")
        key = re.sub(r"\W+", " ", stem.lower()).strip()
        if key in seen_stems:
            errs.append(f"{tag}: duplicate stem of [{seen_stems[key]}]")
        seen_stems[key] = i

        # Shape tell: the correct option being far longest.
        lens = [len(o) for o in opts]
        if lens[ai] > 1.7 * (sum(lens) - lens[ai]) / 3 and lens[ai] > 28:
            warns.append(f"{tag}: correct option is much the longest — "
                         f"{opts[ai][:48]!r}")

        # Superset options.
        for a in range(4):
            for b2 in range(4):
                if a != b2 and len(opts[a]) > 8 and opts[a].lower() in opts[b2].lower():
                    warns.append(f"{tag}: option {a} is contained in option {b2}")

        # Page must sit inside the declared section range.
        sec = sections_by_number.get(str(q.get("number")))
        if sec is None:
            errs.append(f"{tag}: unknown section number {q.get('number')!r}")
        elif strict_pages:
            lo, hi = sec["pages"]
            if not (lo <= q.get("page", -1) <= hi):
                errs.append(f"{tag}: page {q.get('page')} outside section range {lo}-{hi}")

        # Grounding: numbers in a numeric answer must appear on the page.
        if q.get("type") in NUMERIC_TYPES:
            want = numbers_in(opts[ai])
            if want:
                txt = page_text(q.get("page", -1))
                if txt:
                    have = numbers_in(txt)
                    missing = {n for n in want if n not in have}
                    if missing:
                        errs.append(
                            f"{tag}: answer numbers {sorted(missing)} not found on "
                            f"page {q.get('page')} — {opts[ai][:48]!r}")
    return errs, warns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-page-check", action="store_true")
    args = ap.parse_args()

    content = json.loads((ROOT / "docs" / "data" / "content.json").read_text())
    sections = {}
    for g in content["guidelines"]:
        sections[g["number"]] = {"pages": [g["page"], g.get("end_page", g["page"])]}
    for d in content["drugs"]:
        sections[d["number"]] = {"pages": [d["page"], d.get("end_page", d["page"])]}

    total_q = total_e = total_w = 0
    for f in args.files:
        p = Path(f)
        if not p.exists():
            print(f"missing: {f}")
            total_e += 1
            continue
        errs, warns = check_batch(p, sections, strict_pages=not args.no_page_check)
        try:
            n = len(json.loads(p.read_text()).get("questions", []))
        except Exception:
            n = 0
        total_q += n
        total_e += len(errs)
        total_w += len(warns)
        status = "OK " if not errs else "FAIL"
        print(f"{status} {p.name}: {n} questions, {len(errs)} errors, {len(warns)} warnings")
        for e in errs:
            print("   ERROR  " + e)
        if not args.quiet:
            for w in warns[:12]:
                print("   warn   " + w)

    print(f"\nTotal: {total_q} questions, {total_e} errors, {total_w} warnings")
    sys.exit(1 if total_e else 0)


if __name__ == "__main__":
    main()

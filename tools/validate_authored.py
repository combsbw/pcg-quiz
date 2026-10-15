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
    "pearl", "special", "calculation",
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
# Answers whose numbers must appear on the cited page. Before the OCR layer
# existed this was only dose/max_dose/threshold, and authors typed image-only
# values (i-gel sizes, IO landmark distances) as non-numeric to dodge a check
# that could not see the image. With OCR the check can see them, so it applies.
NUMERIC_TYPES = {"dose", "max_dose", "threshold", "equipment", "landmark", "route"}
SOFT_NUMERIC_TYPES = {"treatment", "procedure", "assessment", "sequence",
                      "special", "pearl", "indication", "contraindication",
                      "scope", "complication"}
OCR_PATH = ROOT / "authoring" / "ocr.json"
_ocr = None


def ocr_text(pno: int) -> str:
    global _ocr
    if _ocr is None:
        try:
            _ocr = json.loads(OCR_PATH.read_text(encoding="utf-8"))
        except Exception:
            _ocr = {}
    return _ocr.get(str(pno), "")

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
    # Native text layer plus OCR, so image-only tables and figures are visible
    # to the grounding check too.
    return _page_cache[pno] + "\n" + ocr_text(pno)


def norm_num(s: str) -> str:
    """'0.30' -> '0.3', '1.0' -> '1' so formatting differences do not trip it."""
    try:
        f = float(s)
        return ("%g" % f)
    except ValueError:
        return s


def numbers_in(s: str) -> set:
    return {norm_num(n) for n in NUM.findall(s or "")}



# --- section numbers in stems ----------------------------------------------
#
# A stem should name the condition or procedure ("aortic emergencies"), not
# the document's section number ("5.03"). Provenance is shown on the answer
# screen, so the number adds nothing to the question except an extra lookup.
# A bare decimal is NOT enough to call it a section reference — "0.05 mg/kg"
# is a dose — so only real section numbers count, and only when no unit
# follows.
_SECTIONS: set = set()
UNIT_AFTER = re.compile(
    r"^\s*(mg|mcg|g|kg|ml|mL|l|L|meq|mEq|units?|%|j|J|cm|mm|mmhg|mmHg|"
    r"hours?|hrs?|min|minutes?|seconds?|sec|lpm|LPM|kg/|mcg/|mg/|ml/|mL/)",
    re.I)


def section_refs(text: str) -> list:
    out = []
    for m in re.finditer(r"(?<![\d.])(\d{1,2}\.\d{2})(?![\d.])", text or ""):
        if m.group(1) in _SECTIONS and not UNIT_AFTER.match(text[m.end():]):
            out.append(m.group(1))
    return out


# --- calculation questions ---------------------------------------------------
#
# A calculation answer (IBW, minute ventilation, driving pressure, mL/kg
# volumes) is not on any page, so grounding cannot verify it. Instead the
# question carries its own working:
#
#   "calc": {"formula": "50 + 2.3 * (H - 60)", "inputs": {"H": 70},
#            "result": 73, "unit": "kg"}
#
# and the validator (a) recomputes the formula, (b) checks the correct option
# states that result, (c) checks every input value appears in the stem, and
# (d) grounds the formula's own constants (50, 2.3, 60) on the cited page — so
# the formula itself must be the document's, not one recalled from training.
import ast
import operator

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg,
        ast.UAdd: operator.pos}


def safe_eval(expr: str, names: dict) -> float:
    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return float(n.value)
        if isinstance(n, ast.Name):
            if n.id not in names:
                raise ValueError(f"unknown input {n.id!r}")
            return float(names[n.id])
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        if isinstance(n, ast.Call) and getattr(n.func, "id", "") in ("round", "min", "max"):
            args = [ev(a) for a in n.args]
            return {"round": lambda *a: round(*[a[0], int(a[1])] if len(a) > 1 else [a[0]]),
                    "min": min, "max": max}[n.func.id](*args)
        raise ValueError(f"unsupported expression element {type(n).__name__}")
    return ev(ast.parse(expr, mode="eval"))


def check_calc(tag, q, opts, ai, errs):
    blocks = q.get("calc")
    if isinstance(blocks, dict):
        blocks = [blocks]
    if not blocks:
        errs.append(f"{tag}: calculation question has no 'calc' block")
        return
    stem_nums = numbers_in(q.get("stem", ""))
    ans_nums = [float(x) for x in NUM.findall(opts[ai].replace(",", ""))]
    page = page_text(q.get("page", -1))
    page_nums = numbers_in(page) if page else set()
    for b in blocks:
        try:
            formula = b["formula"]
            inputs = b.get("inputs", {}) or {}
            got = safe_eval(formula, inputs)
        except Exception as e:
            errs.append(f"{tag}: calc formula does not evaluate — {e}")
            continue
        want = float(b.get("result"))
        tol = max(0.051, abs(got) * 0.011)
        if abs(got - want) > tol:
            errs.append(f"{tag}: calc says {want} but {formula} with {inputs} = {got:.3f}")
        if not any(abs(x - want) <= tol for x in ans_nums):
            errs.append(f"{tag}: correct option {opts[ai]!r} does not state the calc result {want}")
        for k, v in inputs.items():
            if norm_num(str(v)) not in stem_nums:
                errs.append(f"{tag}: calc input {k}={v} does not appear in the stem")
        if page_nums:
            consts = {norm_num(c) for c in NUM.findall(re.sub(r"[A-Za-z_]\w*", " ", formula))}
            consts -= {"0", "1", "2", "100", "1000"}       # unit conversions / trivial
            missing = sorted(c for c in consts if c not in page_nums)
            if missing:
                errs.append(f"{tag}: formula constants {missing} not found on page "
                            f"{q.get('page')} — the formula must be the document's")


def check_batch(path: Path, sections_by_number: dict, strict_pages=True, grounding=True):
    errs, warns = [], []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return [f"{path.name}: unreadable JSON — {e}"], []

    qs = data.get("questions")
    if not isinstance(qs, list) or not qs:
        return [f"{path.name}: no questions array"], []

    # Position skew. A batch where every correct answer sits at index 0 is
    # gameable without reading the question; it is also invisible to every
    # other check here, which is how ten batches shipped that way.
    pos = {}
    for q in qs:
        ai = q.get("answer_index")
        if isinstance(ai, int):
            pos[ai] = pos.get(ai, 0) + 1
    if qs and pos:
        share = max(pos.values()) / len(qs)
        if share > 0.45:
            warns.append(
                f"{path.name}: {share:.0%} of answers sit at one position "
                f"{[pos.get(i, 0) for i in range(4)]} — vary which option is "
                f"correct (the merge step also reshuffles, so this is advisory)")

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
        refs = section_refs(stem)
        if refs:
            errs.append(f"{tag}: stem cites section number {refs} — name the condition "
                        f"or procedure instead — {stem[:70]!r}")
        for o in opts:
            if section_refs(o):
                warns.append(f"{tag}: option cites a section number — {o[:50]!r}")
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
            pg = q.get("page", -1)
            if not any(lo <= pg <= hi for lo, hi in sec["ranges"]):
                rng = " or ".join(f"{lo}-{hi}" for lo, hi in sec["ranges"])
                errs.append(f"{tag}: page {pg} outside section range {rng}")

        if q.get("type") == "calculation" and grounding:
            check_calc(tag, q, opts, ai, errs)

        # Grounding: numbers in a numeric answer must appear on the page.
        if grounding and q.get("type") in NUMERIC_TYPES | SOFT_NUMERIC_TYPES:
            want = numbers_in(opts[ai])
            if want:
                txt = page_text(q.get("page", -1))
                if txt:
                    have = numbers_in(txt)
                    missing = {n for n in want if n not in have}
                    if missing:
                        msg = (f"{tag}: answer numbers {sorted(missing)} not found on "
                               f"page {q.get('page')} (text or OCR) — {opts[ai][:48]!r}")
                        (errs if q.get("type") in NUMERIC_TYPES else warns).append(msg)
    return errs, warns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-page-check", action="store_true")
    ap.add_argument("--no-grounding", action="store_true",
                    help="wording/structure checks only (used by the rephrase pass)")
    args = ap.parse_args()

    content = json.loads((ROOT / "docs" / "data" / "content.json").read_text())
    # The document reuses a number for two different guidelines (5.05 is both
    # "Atraumatic Hemorrhagic Stroke" and "Cardiogenic Shock"), so a number maps
    # to a LIST of page ranges. Keying on a single range silently made one of
    # the two unrepresentable and failed every question written against it.
    _SECTIONS.update(r["number"] for r in content["guidelines"] + content["drugs"])
    sections = {}
    for rec in content["guidelines"] + content["drugs"]:
        sections.setdefault(rec["number"], {"ranges": []})["ranges"].append(
            [rec["page"], rec.get("end_page", rec["page"])])

    total_q = total_e = total_w = 0
    for f in args.files:
        p = Path(f)
        if not p.exists():
            print(f"missing: {f}")
            total_e += 1
            continue
        errs, warns = check_batch(p, sections, strict_pages=not args.no_page_check,
                                  grounding=not args.no_grounding)
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

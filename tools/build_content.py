#!/usr/bin/env python3
"""
build_content.py — turn parsed LFN guideline data into app/data/content.json

Two very different extraction paths, on purpose:

* Guidelines (sections 1-11) come from the parsed subsections.jsonl produced by
  parse_lfn.py. Its care-level blocks are already verified, so we only split
  them into bullets.

* Drugs (section 12, the formulary) are re-extracted straight from the PDF with
  table detection. The flat parsed text of a formulary page is column-major, so
  an indication and a dose that sit in the same visual row end up far apart in
  the text stream. Generating dose questions from that would eventually pair an
  indication with the wrong number, which is not an acceptable failure mode for
  dosing content. Cell geometry keeps the pairing intact.

Usage:
    python tools/build_content.py --version 2026.09.15
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

try:
    import pymupdf
except ImportError:
    raise SystemExit("pip install pymupdf --break-system-packages")

ROOT = Path(__file__).resolve().parent.parent


def site_data_dir() -> Path:
    """Where the generated JSON lives.

    The published site folder is `docs/` (GitHub Pages serves the repo root or
    `/docs`, and `/docs` keeps the site out of the repo root). `app/` is
    accepted too so the tools still work against the original build layout.
    """
    for name in ("docs", "app"):
        d = ROOT / name / "data"
        if d.exists():
            return d
    return ROOT / "docs" / "data"
BUILD_DIRS = [
    ROOT / "lfn_build",
    ROOT.parent / "lfn_build",
    Path("/mnt/user-data/outputs/lfn_build"),
]
PDFS = {
    "2026.09.15": "/mnt/user-data/uploads/2026-09-15_PCGs.pdf",
    "2026.07.14": "/mnt/user-data/uploads/2026-07-14_PCGs.pdf",
    "2026.03.18": "/mnt/user-data/uploads/LFN_Guidelines_-_v2026-03-18.pdf",
}

BULLET_RE = re.compile(r"^\s*(?:[•▪○◦o–-]|\d{1,2}[.)]|[a-z][.)]|[ivx]+[.)])\s+",
                       re.I)
DOSE_HINT = re.compile(r"\d\s*(mg|mcg|g|ml|mL|units?|mEq|L|J|%)\b|\bmg/kg\b|\bmcg/kg\b", re.I)


# ---------------------------------------------------------------- guidelines

def split_bullets(text: str) -> list:
    """Split a care-level block into readable bullet lines.

    Wrapped continuation lines (no bullet marker, lower-case start) are joined
    back onto the bullet they belong to, otherwise half a dose instruction ends
    up as its own item.
    """
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if BULLET_RE.match(line):
            out.append(BULLET_RE.sub("", line).strip())
        elif out and (line[:1].islower() or line[:1].isdigit()):
            out[-1] = (out[-1] + " " + line).strip()
        else:
            out.append(line)
    return [b for b in out if len(b) > 2]


def build_guidelines(recs):
    guidelines = []
    for r in recs:
        if r["number"].startswith("12."):
            continue
        blocks = []
        for b in r["blocks"]:
            blocks.append({
                "care_level": b["care_level"],
                "levels": b.get("levels") or ([] if b["care_level"] == "BODY"
                                              else [b["care_level"]]),
                "page": b["page"],
                "text": b["text"],
                "bullets": split_bullets(b["text"]),
            })
        guidelines.append({
            "id": r["slug"],
            "number": r["number"],
            "title": r["title"],
            "section_number": r["section_number"],
            "section_title": r["section_title"],
            "page": r["start_page"],
            "end_page": r["end_page"],
            "care_levels": r["care_levels"],
            "images": r["images"],
            "blocks": blocks,
        })
    return guidelines


# --------------------------------------------------------------------- drugs

def named_columns(table):
    """Map a formulary table's spacer-padded columns onto its real headings.

    find_tables() reports these tables with empty spacer columns between the
    real ones (12 columns where there are 4 headings), and body cells span the
    merged ranges. Each heading therefore owns an x-range running up to the
    next heading, and a body cell belongs to the heading its centre falls in.
    """
    names = table.header.names
    cells = table.header.cells
    cols = []
    for i, nm in enumerate(names):
        if nm and nm.strip() and cells[i]:
            cols.append([nm.strip(), cells[i][0], cells[i][2]])
    if not cols:
        return []
    for i in range(len(cols) - 1):          # extend to the next heading
        cols[i][2] = cols[i + 1][1]
    cols[0][1] = min(c[0] for c in cells if c)
    cols[-1][2] = max(c[2] for c in cells if c)
    return cols


def extract_dose_table(table):
    cols = named_columns(table)
    if not cols or not any("indication" in c[0].lower() for c in cols):
        return None
    labels = [c[0] for c in cols]
    data = table.extract()
    rows = []
    for ri, row in enumerate(table.rows):
        if ri == 0:
            continue
        vals = {lab: [] for lab in labels}
        for ci, cell in enumerate(row.cells):
            if not cell:
                continue
            txt = (data[ri][ci] or "").strip()
            if not txt:
                continue
            mid = (cell[0] + cell[2]) / 2
            for lab, x0, x1 in cols:
                if x0 <= mid < x1:
                    vals[lab].append(txt)
                    break
        if not any(vals.values()):
            continue
        rows.append({k: "\n".join(v).strip() for k, v in vals.items()})

    # Collapse continuation rows.
    #
    # These tables wrap a single logical entry over several physical rows: the
    # indication text spills down ("Severe trauma that is" / "likely to require"
    # / "massive transfusions"), and dose qualifiers ("Max single dose 20 mcg")
    # sit on their own rows with no indication. A new logical entry therefore
    # begins only where a row has BOTH an indication and at least one dose;
    # everything else continues the entry above it. Merging on "indication is
    # empty" alone leaves half-sentences behind, which then surface as
    # nonsense answers like "with sodium < 120".
    ind_key = next(l for l in labels if "indication" in l.lower())
    dose_keys = [l for l in labels if l != ind_key]
    merged = []
    for r in rows:
        starts_entry = bool(r[ind_key]) and any(r[k] for k in dose_keys)
        if not starts_entry and merged:
            for k, v in r.items():
                if v:
                    merged[-1][k] = (merged[-1][k] + "\n" + v).strip()
        elif starts_entry:
            merged.append(dict(r))
    return [m for m in merged if m[ind_key]]


INFO_LABELS = {
    "mechanism of action", "pharmacologic category", "contraindications",
    "warnings / precautions", "warnings/precautions", "adverse reactions",
    "pregnancy considerations", "onset / peak / duration", "trade name",
    "indication", "special considerations",
}


def extract_info_table(table):
    """Two-column label/value tables ('Mechanism of Action' -> text)."""
    data = table.extract()
    info = {}
    for row in data:
        cells = [(c or "").strip() for c in row if (c or "").strip()]
        if len(cells) < 2:
            continue
        label = cells[0].rstrip(":").strip()
        if label.lower() in INFO_LABELS:
            info[label] = " ".join(cells[1:]).replace("\n", " ").strip()
    return info


def build_drugs(recs, pdf_path):
    doc = pymupdf.open(pdf_path)
    drugs = []
    for r in recs:
        if not r["number"].startswith("12."):
            continue
        doses, info = [], {}
        for pno in range(r["start_page"], r["end_page"] + 1):
            if pno - 1 >= doc.page_count:
                break
            page = doc[pno - 1]
            try:
                tables = page.find_tables().tables
            except Exception:
                continue
            for t in tables:
                try:
                    d = extract_dose_table(t)
                except Exception:
                    d = None
                if d:
                    ind_key = next(k for k in d[0] if "indication" in k.lower())
                    for row in d:
                        doses.append({
                            "indication": row.get(ind_key, ""),
                            "adult": row.get("Adult Dose", ""),
                            "pediatric": row.get("Pediatric Dose", ""),
                            "neonatal": row.get("Neonatal Dose", ""),
                        })
                    continue
                try:
                    info.update(extract_info_table(t))
                except Exception:
                    pass
        drugs.append({
            "id": r["slug"],
            "number": r["number"],
            "name": r["title"],
            "page": r["start_page"],
            "end_page": r["end_page"],
            "doses": [d for d in doses if d["indication"]],
            "info": info,
            "text": r["text"],
        })
    doc.close()
    return drugs


# ---------------------------------------------------------------------- main

def find_build_dir(version):
    for base in BUILD_DIRS:
        p = base / version / "subsections.jsonl"
        if p.exists():
            return p
    raise SystemExit(f"subsections.jsonl for {version} not found in {BUILD_DIRS}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="2026.09.15")
    ap.add_argument("--out", default=str(site_data_dir() / "content.json"))
    args = ap.parse_args()

    src = find_build_dir(args.version)
    recs = [json.loads(l) for l in open(src, encoding="utf-8")]

    guidelines = build_guidelines(recs)
    drugs = build_drugs(recs, PDFS[args.version])

    secs = {}
    for r in recs:
        secs.setdefault(r["section_number"],
                        {"number": r["section_number"],
                         "title": r["section_title"], "subsection_count": 0})
        secs[r["section_number"]]["subsection_count"] += 1

    content = {
        "version": args.version,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sections": [secs[k] for k in sorted(secs, key=lambda x: int(x))],
        "guidelines": guidelines,
        "drugs": drugs,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")

    nd = sum(len(d["doses"]) for d in drugs)
    ni = sum(len(d["info"]) for d in drugs)
    print(f"content.json: {len(guidelines)} guidelines, {len(drugs)} drugs, "
          f"{nd} dose rows, {ni} info fields -> {out}")


if __name__ == "__main__":
    main()

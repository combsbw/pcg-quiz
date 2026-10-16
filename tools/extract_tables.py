#!/usr/bin/env python3
"""
extract_tables.py — find the *data* tables on a guideline page and return them
as rows and columns.

Why: the outline extractor reads a page as lines in reading order. That is
right for bullet lists, and badly wrong for a grid. On the Hemodynamic Pressure
Table every row's three cells came out interleaved with the next row's —
"Pulmonary Artery Pressure / Right Atrial Pressure / Stroke Volume / SVR /
15-25 mmHg / 6-12 mmHg / 2-6 mmHg …" — so the page was unusable as a reference
and a value could not be matched to its parameter.

What counts as a data table here. Most ruled boxes in this template are page
*layout*, not data, and are handled well by the outline:

  * the care-level bands (a gutter cell reading BLS / ALS / CCT / PEARLS),
  * the History | Assessment | Differential box at the top of a guideline,
  * the Indications | Contraindications (| Complications) box on procedures.

Everything else with at least two real columns and two real rows is a table:
the BP treatment chart, hemodynamic table, stroke scales, ventilator strategy
tables, CPAP/BiPAP settings, state scope tables, and so on.

Usage (inspection):  python3 tools/extract_tables.py 290 286 293
"""
from __future__ import annotations

import re
import sys

LAYOUT_HEADS = {"history", "assessment", "differential", "indications",
                "contraindications", "complications", "acute", "chronic",
                "management principles"}
CARE = {"BLS", "ALS", "CCT", "PEARLS", "EMR", "LS"}
MARKER = re.compile(r"^\s*(?:[•▪○◦§]|o\s|[–-]\s|\d{1,2}[.)]\s|[a-z][.)]\s|[ivx]{1,4}[.)]\s"
                    r"|(?:Adult|Pedi|Pediatric|Neonat\w*|Guidance|Rational\w*)\b[^:]{0,20}:)",
                    re.I)


def _clean_cell(s: str | None) -> str:
    """Join wrapped lines; keep a line break only where a new list item starts."""
    if not s:
        return ""
    out = []
    for ln in s.split("\n"):
        ln = re.sub(r"[ \t]+", " ", ln).strip()
        if not ln:
            continue
        # Two stacked values ("15 - 25 mmHg" over "6 - 12 mmHg") are two
        # values, not one wrapped line.
        stacked = (out and re.match(r"^\d", ln) and re.search(r"\d\s*\S*$", out[-1])
                   and len(ln) < 25)
        if out and ln.startswith(HEAD) and out[-1].startswith(HEAD):
            out[-1] += " " + ln[1:]               # a heading wrapped over lines
            continue
        heading = ln.startswith(HEAD) or (out and out[-1].startswith(HEAD))
        if out and not MARKER.match(ln) and not stacked and not heading:
            out[-1] = (out[-1] + " " + ln).strip()
        else:
            out.append(ln)
    text = "\n".join(out)
    # dyn/sec/cm-5: the exponent is a superscript in the source
    text = re.sub(r"\s-5\s+dyn/sec/cm\b", " dyn/sec/cm⁻⁵", text)
    text = re.sub(r"cm\s?-5\b", "cm⁻⁵", text)
    return text


def _norm(c):
    c = (c or "").replace("\ufffd", "•").replace("\uf0b7", "•").replace("\uf0a7", "▪")
    return c


def _jcell(a, b):
    ra, rb = a["r"], b["r"]
    if ra is not None and rb is not None:
        r = (min(ra[0], rb[0]), min(ra[1], rb[1]), max(ra[2], rb[2]), max(ra[3], rb[3]))
    else:
        r = ra if ra is not None else rb
    return {"t": _join(a["t"], b["t"]), "r": r}


HEAD = "\u0001"     # marks a bold sub-heading line inside a cell


def _page_lines(page):
    """Words, not lines: one PDF text line can run across several cells (the
    MAP row of the hemodynamic table is a single line spanning all three).
    Each word also records whether it is bold, from the span it sits in."""
    bold_boxes = []
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            for sp in ln["spans"]:
                if sp["text"].strip() and ("bold" in sp["font"].lower() or sp["flags"] & 16):
                    bold_boxes.append(sp["bbox"])
    out = []
    for w in page.get_text("words"):
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        bold = any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in bold_boxes)
        out.append((cx, cy, w[1], w[0], _norm(w[4]), bold))
    return out


def _reread(cell, words):
    """Text inside the cell's rectangle, line by line, top to bottom; falls
    back to the find_tables text when the cell has no rectangle of its own."""
    r = cell["r"]
    if r is None:
        return cell["t"]
    got = sorted((y0, x0, txt, bold) for cx, cy, y0, x0, txt, bold in words
                 if r[0] - 1 <= cx <= r[2] + 1 and r[1] - 1 <= cy <= r[3] + 1)
    if not got:
        return cell["t"]
    rows = []                                  # words sharing a baseline
    for y0, x0, txt, bold in got:
        if rows and abs(rows[-1][0] - y0) < 3:
            rows[-1][1].append((x0, txt, bold))
        else:
            rows.append([y0, [(x0, txt, bold)]])
    lines = [(" ".join(t for _, t, _ in sorted(ws)), all(b for _, _, b in ws))
             for _, ws in rows]
    # Bold lines are sub-headings ("Falls", "High-Auto") only when the cell
    # also has plain text; a wholly bold cell is just a bold label.
    mixed = any(b for _, b in lines) and not all(b for _, b in lines)
    return "\n".join((HEAD + t) if (b and mixed) else t for t, b in lines)


def _join(a, b):
    a, b = (a or "").rstrip(), (b or "").strip()
    return f"{a}\n{b}" if a and b else (a or b)


def _looks_clean(header, rows):
    """Heuristics for a grid find_tables got wrong. A table that fails is
    shown as the original image instead of a misleading HTML grid."""
    width = len(header or rows[0])
    if any(len(r) != width for r in rows):
        return False
    for r in rows:
        for c in r:
            if re.fullmatch(r"[•▪\s]*", c) and c.strip():
                return False                 # a bullet split from its text
    # a data row that is almost entirely empty while its neighbours are full
    if width >= 4:
        dense = [sum(1 for c in r if c) / width for r in rows]
        if any(d < 0.4 for d in dense) and sum(dense) / len(dense) > 0.8:
            return False
    return True


def _is_bold_row(page, cells) -> bool:
    """A header row is set in bold (white-on-blue in this template)."""
    bold = total = 0
    for c in cells:
        if c is None:
            continue
        for b in page.get_text("dict", clip=c)["blocks"]:
            for ln in b.get("lines", []):
                for s in ln["spans"]:
                    if s["text"].strip():
                        total += 1
                        bold += ("bold" in s["font"].lower()) or bool(s["flags"] & 16)
    return total > 0 and bold / total >= 0.6


def data_tables(page):
    """[{bbox, header, rows}] for each data table on the page, top to bottom."""
    found = []
    for t in page.find_tables().tables:
        grid = t.extract()
        if len(grid) < 2 or t.col_count < 2:
            continue
        flat = [(c or "").strip() for r in grid for c in r]
        if any(c.upper() in CARE for c in flat):
            continue                                  # care-level band
        first_row = {(c or "").strip().lower() for c in grid[0] if c and c.strip()}
        if first_row and first_row <= LAYOUT_HEADS:
            continue                                  # History/Indications box
        # Each cell carries its rectangle as well as its text: once spanned
        # columns and overflow rows are merged, the cell's text is re-read from
        # the page inside the merged rectangle, which keeps a bullet with the
        # words it belongs to (find_tables splits "•" into a column of its own).
        grid = [[{"t": _norm(c), "r": t.rows[i].cells[j]} for j, c in enumerate(r)]
                for i, r in enumerate(grid)]
        keep = [j for j in range(t.col_count)
                if any(r[j]["t"].strip() for r in grid)]
        if len(keep) < 2:
            continue
        hdr_cells = [t.rows[0].cells[j] for j in keep]
        grid = [[r[j] for j in keep] for r in grid]
        grid = [r for r in grid if any(c["t"].strip() for c in r)]
        if sum(1 for r in grid if sum(1 for c in r if c["t"].strip()) >= 2) < 2:
            continue

        header = None
        filled = sum(1 for c in grid[0] if c["t"].strip())
        if _is_bold_row(page, hdr_cells) and filled >= max(2, len(grid[0]) / 2):
            header, grid = grid[0], grid[1:]
            # A header cell spanning two grid columns leaves the second blank;
            # text overflowing into it ("Pedi:" under Targets) belongs to the
            # column on its left.
            for j in range(len(header) - 1, 0, -1):
                if not header[j]["t"].strip():
                    for r in grid:
                        r[j - 1] = _jcell(r[j - 1], r[j])
                        del r[j]
                    del header[j]

        # A row whose label cell is empty is the overflow of the row above
        # (a long Notes cell pushes find_tables into inventing extra rows).
        labelled = sum(1 for r in grid if r[0]["t"].strip())
        if labelled >= 2:
            merged = []
            for r in grid:
                if merged and not r[0]["t"].strip():
                    merged[-1] = [_jcell(x, y) for x, y in zip(merged[-1], r)]
                else:
                    merged.append(list(r))
            grid = merged

        lines = _page_lines(page)
        grid = [[_reread(c, lines) for c in r] for r in grid]
        for r in grid:                     # the label column is bold anyway
            r[0] = r[0].replace(HEAD, "")
        header = [_reread(c, lines) for c in header] if header else None
        rows = [[_clean_cell(c) for c in r] for r in grid]
        header = [_clean_cell(c) for c in header] if header else None
        # Overflow can still land in a column of its own; drop columns left
        # empty, and flag tables find_tables could not grid cleanly.
        if header is None:
            keep = [j for j in range(len(rows[0])) if any(r[j] for r in rows)]
            rows = [[r[j] for j in keep] for r in rows]
        clean = _looks_clean(header, rows)
        found.append({"bbox": [round(v, 1) for v in t.bbox],
                      "header": header, "rows": rows, "clean": clean})
    found.sort(key=lambda x: x["bbox"][1])
    return found


if __name__ == "__main__":
    import pymupdf
    doc = pymupdf.open("/root/.claude/uploads/1e05ed93-1e78-5825-a7f6-fb7980293b89/"
                       "93ea7f77-2026-09-15_PCGs.pdf")
    for p in map(int, sys.argv[1:]):
        for t in data_tables(doc[p - 1]):
            print(f"--- p{p} clean={t['clean']} bbox={t['bbox']} header={t['header']}")
            for r in t["rows"]:
                print("   ", " || ".join(c.replace("\n", " ⏎ ") for c in r))

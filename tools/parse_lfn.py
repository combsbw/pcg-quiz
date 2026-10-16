#!/usr/bin/env python3
"""
parse_lfn.py — Parse Life Flight Network (LFN) Patient Care Guidelines PDF
into structured, version-aware documents for a quiz + reference interface.

USAGE
-----
    python parse_lfn.py /path/to/LFN_Guidelines_-_v2026-03-18.pdf
    python parse_lfn.py INPUT.pdf --outdir ./build --db lfn.sqlite

OUTPUTS (under --outdir, default ./lfn_build/<version>/)
    sections.json        Full hierarchical tree (sections -> subsections -> blocks)
    subsections.jsonl    One JSON object per subsection (easy to stream / chunk)
    subsections.csv      Flat table for quick inspection / spreadsheet use
    images/              Extracted figures & flowcharts (PNG), referenced by blocks
    manifest.json        Version metadata + counts + integrity hashes
    lfn.sqlite           (optional) SQLite DB with FTS5 search, if --db given

DESIGN
------
The PDF has NO embedded bookmarks, so structure is recovered two ways that
cross-check each other:

  1. The Table of Contents (pages 2-8) gives the canonical list of
     top-level sections (e.g. "5 Medical") and decimal subsections
     (e.g. "5.02 Anaphylaxis & Allergic Reactions") plus each start page.

  2. In-body detection assigns every page to its owning subsection by page
     range, then within each page detects the vertically-rotated care-level
     labels — BLS / ALS / CCT / PEARLS — which delimit sub-blocks, and
     extracts figures/flowcharts as images.

Re-running on an updated PDF re-derives everything from that file, so new
versions are processed automatically. Outputs are namespaced by the
document version string parsed from the cover page.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

try:
    import pymupdf
except ImportError:
    try:
        import fitz as pymupdf  # older PyMuPDF
    except ImportError:
        sys.exit("PyMuPDF is required:  pip install pymupdf")


# --------------------------------------------------------------------------
# Configuration / heuristics (tuned to the v2026.03.18 template)
# --------------------------------------------------------------------------

CARE_LEVELS = ("BLS", "ALS", "CCT", "PEARLS")

# A care-level label is a short bold token, rotated 90deg (dir y-component ~ -1),
# sitting in the left margin gutter.
LABEL_MAX_X = 90          # left-gutter cutoff (page width 612)
LABEL_ROT_TOL = 0.95      # |dir.y| above this == vertical text

# Section-divider heading: e.g. "4 Environmental"  (big Aptos Display, near top)
TOP_HEADING_MIN_SIZE = 19
# Subsection heading: e.g. "5.02 Anaphylaxis ..." (Calibri-Light ~18pt, near top)
SUB_HEADING_SIZE = 18
HEADING_MAX_Y = 100

# The recurring header logo appears on (almost) every page; auto-detected as
# the most frequently repeated image xref, but we also size-guard small images.
HEADER_LOGO_MAX_AREA = 212 * 100 + 10  # logo is 212x100
MIN_FIGURE_AREA = 60 * 60              # ignore tiny decorative glyphs/icons

# Minimum width (pt) of a vertical white gutter for it to count as a real
# column break rather than incidental spacing between words.
MIN_GUTTER_PT = 8

# A genuine column must be at least this wide (pt). This stops the narrow
# white band between a bullet glyph and its text from being mistaken for a
# column gutter, which would shear every list item in half.
MIN_COL_WIDTH_PT = 70

# Curved path segments needed before a page's vector drawing is treated as a
# figure rather than table chrome. Rounded callouts, arrows and diamonds
# produce curves; table rules and cell fills do not.
VECTOR_FIGURE_MIN_CURVES = 8

# Minimum height (pt) of a horizontal whitespace band for it to count as a
# region break in the XY-cut. Normal inter-line leading is ~2-5pt; separate
# boxes/sections are separated by noticeably more.
MIN_ROW_GAP_PT = 8

# Horizontal care-level headings, e.g. "BLS", "ALS & CCT", "PEARLS:"
RE_HLABEL = re.compile(
    r'^(BLS|ALS|CCT|PEARLS)(\s*[&/+,]\s*(BLS|ALS|CCT|PEARLS))*\s*:?\s*$', re.I)

# TOC parsing regexes (leader-dot lines: "Title ........ 123")
RE_TOP = re.compile(r'^(\d{1,2})\s+([A-Z][A-Za-z][^.]*?)\s*\.{3,}\s*(\d+)\s*$')
RE_SUB = re.compile(r'^(\d{1,2}\.\d{2})\s+(.*?)\s*\.{3,}\s*(\d+)\s*$')
RE_VER_LINE = re.compile(r'Version\s+(\d{4}[.\-]\d{2}[.\-]\d{2})', re.I)


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------

@dataclass
class Block:
    """A care-level sub-block or a 'BODY' block of text.

    care_level is the label as printed (e.g. "BLS", "ALS & CCT", "BODY");
    levels is the normalised list of care levels it applies to, so a combined
    "ALS & CCT" heading is filterable as both ALS and CCT.
    """
    care_level: str           # BLS | ALS | CCT | PEARLS | "ALS & CCT" | BODY
    text: str
    page: int
    levels: list = field(default_factory=list)
    images: list = field(default_factory=list)   # image filenames anchored here


@dataclass
class Subsection:
    number: str               # "5.02"
    title: str                # "Anaphylaxis & Allergic Reactions"
    section_number: str       # "5"
    section_title: str        # "Medical"
    start_page: int
    end_page: int
    blocks: list = field(default_factory=list)
    images: list = field(default_factory=list)    # all images in this subsection

    @property
    def slug(self) -> str:
        s = f"{self.number}_{self.title}".lower()
        s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
        return s

    def care_levels(self) -> list:
        """Normalised, de-duplicated care levels present in this subsection."""
        seen = set()
        for b in self.blocks:
            for lv in (b.levels or ([] if b.care_level == "BODY"
                                    else [b.care_level])):
                if lv in CARE_LEVELS:
                    seen.add(lv)
        return sorted(seen)

    def plain_text(self) -> str:
        parts = [f"{self.number} {self.title}"]
        for b in self.blocks:
            tag = "" if b.care_level == "BODY" else f"[{b.care_level}]\n"
            parts.append(tag + b.text)
        return "\n\n".join(p for p in parts if p.strip())


@dataclass
class Section:
    number: str
    title: str
    start_page: int
    subsections: list = field(default_factory=list)


# --------------------------------------------------------------------------
# Step 1 — version + TOC
# --------------------------------------------------------------------------

def detect_version(doc) -> str:
    # Try cover page text, then PDF metadata, then mod date.
    for pno in range(min(3, doc.page_count)):
        m = RE_VER_LINE.search(doc[pno].get_text())
        if m:
            return m.group(1).replace("-", ".")
    meta = doc.metadata or {}
    for key in ("title", "subject"):
        m = RE_VER_LINE.search(meta.get(key, "") or "")
        if m:
            return m.group(1).replace("-", ".")
    raw = (meta.get("modDate") or "")  # D:YYYYMMDD...
    m = re.search(r"D:(\d{4})(\d{2})(\d{2})", raw)
    if m:
        return ".".join(m.groups())
    return "unknown"


def parse_toc(doc):
    """Return (sections, subsection_list) from the printed Table of Contents.

    The TOC physical pages are those before the first content page; we scan a
    generous range and stop collecting once entries clearly restart in body.
    """
    sections: dict[str, Section] = {}
    subs: list[Subsection] = []

    # TOC reliably lives in the first ~8 pages. Scan them all.
    toc_scan_pages = range(0, min(9, doc.page_count))
    current_section = None

    for pno in toc_scan_pages:
        for line in doc[pno].get_text().splitlines():
            line = line.strip()
            if not line:
                continue
            m = RE_SUB.match(line)
            if m:
                num, title, page = m.group(1), m.group(2).strip(), int(m.group(3))
                sec_no = num.split(".")[0]
                subs.append(Subsection(
                    number=num, title=title,
                    section_number=sec_no,
                    section_title=sections.get(sec_no, Section(sec_no, "", page)).title,
                    start_page=page, end_page=page,
                ))
                continue
            m = RE_TOP.match(line)
            if m:
                num, title, page = m.group(1), m.group(2).strip(), int(m.group(3))
                # avoid catching stray body lines: top sections are 1..40
                if 1 <= int(num) <= 40:
                    sections[num] = Section(number=num, title=title, start_page=page)
                    current_section = num

    # Backfill section titles onto subsections now that all are known.
    for s in subs:
        if s.section_number in sections:
            s.section_title = sections[s.section_number].title

    # Some top-level sections (e.g. "11 PCG Update Summaries") use date-named
    # children instead of N.NN; capture those as pseudo-subsections so no pages
    # are orphaned.
    _capture_dated_children(doc, sections, subs)

    # Sort & compute end pages from the next start.
    subs.sort(key=lambda x: (x.start_page, x.number))
    for i, s in enumerate(subs):
        nxt = subs[i + 1].start_page - 1 if i + 1 < len(subs) else doc.page_count
        s.end_page = max(s.start_page, nxt)

    # Attach subsections to their sections.
    for s in subs:
        if s.section_number in sections:
            sections[s.section_number].subsections.append(s)

    ordered = [sections[k] for k in sorted(sections, key=lambda k: int(k))]
    return ordered, subs


RE_FOOTER = re.compile(r'(\d+)\s*\|\s*P\s*a\s*g\s*e')


def calibrate_page_offset(doc, subs):
    """The TOC lists *printed* page numbers, which differ from physical PDF
    indices by a fixed offset (cover/front pages). Detect it by reading the
    'N | Page' footer on a sample of physical pages and taking the modal
    (physical - printed) difference. Returns an int offset to ADD to every
    printed page number to get the physical (1-based) index."""
    from collections import Counter
    votes = Counter()
    sample = range(10, min(doc.page_count, 260), 7)
    for phys in sample:
        m = RE_FOOTER.search(doc[phys - 1].get_text())
        if m:
            printed = int(m.group(1))
            votes[phys - printed] += 1
    return votes.most_common(1)[0][0] if votes else 1


def apply_page_offset(sections, subs, offset):
    for s in subs:
        s.start_page += offset
        s.end_page += offset
    for sec in sections:
        sec.start_page += offset


def clamp_to_section_dividers(sections, subs):
    """Keep a subsection's page range from running into the next section.

    Each top-level section opens with its own divider page ("2 General
    Treatments"). Because a subsection's end page is derived from where the
    *next subsection* starts, the last subsection of a section would otherwise
    swallow that divider page — so 1.06 appeared to span pages 16-17 when page
    17 actually belongs to section 2. Divider pages belong to the section, not
    to any subsection.
    """
    starts = sorted(s.start_page for s in sections)
    for sub in subs:
        nxt = next((sp for sp in starts if sp > sub.start_page), None)
        if nxt is not None and sub.end_page >= nxt:
            sub.end_page = max(sub.start_page, nxt - 1)
    return subs


def _capture_dated_children(doc, sections, subs):
    """Section 11 lists date-stamped update summaries (YYYY.MM.DD ...... page)."""
    re_dated = re.compile(r'^(\d{4}\.\d{2}\.\d{2})\s*\.{3,}\s*(\d+)\s*$')
    for pno in range(0, min(9, doc.page_count)):
        for line in doc[pno].get_text().splitlines():
            m = re_dated.match(line.strip())
            if not m:
                continue
            date, page = m.group(1), int(m.group(2))
            # Find owning section by nearest preceding section start page.
            owner = max((s for s in sections.values() if s.start_page <= page),
                        key=lambda s: s.start_page, default=None)
            sec_no = owner.number if owner else "11"
            subs.append(Subsection(
                number=f"{sec_no}.{date}", title=f"Update {date}",
                section_number=sec_no,
                section_title=owner.title if owner else "",
                start_page=page, end_page=page,
            ))


# --------------------------------------------------------------------------
# Step 2 — per-page body parsing (care-level labels + text + images)
# --------------------------------------------------------------------------

def find_care_labels(page):
    """Return list of (care_level, y_center) for vertical labels in the gutter.
    Labels are vertically centered within their table row, so the center is the
    best anchor for assigning body text to bands."""
    labels = []
    d = page.get_text("dict")
    for b in d["blocks"]:
        if b["type"] != 0:
            continue
        for ln in b["lines"]:
            txt = "".join(s["text"] for s in ln["spans"]).strip()
            if txt not in CARE_LEVELS:
                continue
            dirv = ln.get("dir", (1, 0))
            x0 = ln["bbox"][0]
            if abs(dirv[1]) >= LABEL_ROT_TOL and x0 <= LABEL_MAX_X:
                y_center = (ln["bbox"][1] + ln["bbox"][3]) / 2.0
                labels.append((txt, y_center))
    labels.sort(key=lambda t: t[1])
    return labels


def find_care_bands(page, labels):
    """Resolve each vertical care-level label to the exact y-range of its band.

    In this template every care-level row is a table whose left gutter cell is
    filled with the level's colour (BLS green, ALS red, CCT black) or, for
    PEARLS, bounded by plain cell borders. That rectangle *is* the band, so
    reading it from the page's vector drawings gives exact boundaries — far
    more reliable than interpolating between the (vertically centred) labels,
    which misplaces text whenever adjacent bands differ in height.

    Returns [(level, y0, y1), ...]; levels with no matching rectangle are
    returned with y0/y1 = None so the caller can fall back to interpolation.
    """
    rects = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.x0 < LABEL_MAX_X and r.x1 <= 100 and r.height >= 15:
            rects.append(r)

    bands = []
    for lvl, yc in labels:
        hits = [r for r in rects if r.y0 - 3 <= yc <= r.y1 + 3]
        if hits:
            best = min(hits, key=lambda r: r.height)
            bands.append((lvl, best.y0, best.y1))
        else:
            bands.append((lvl, None, None))
    return bands


def _snap_to_gap(body, lo, hi, fallback):
    """Within body lines whose y is in [lo, hi], find the largest inter-line
    vertical gap (the visual break between two table rows / care-level bands)
    and return its midpoint. Fall back to `fallback` if no clear gap exists."""
    ys = sorted(y for (y, _x, _t) in body if lo <= y <= hi)
    if len(ys) < 2:
        return fallback
    best_gap, best_y = 0.0, fallback
    for a, b in zip(ys, ys[1:]):
        if b - a > best_gap:
            best_gap, best_y = b - a, (a + b) / 2.0
    return best_y if best_gap > 22 else fallback


def _band_half_height(labels, i):
    """Estimate how far the first band reaches above its label center, using
    the gap to the next label as a proxy for row height (fallback 120pt)."""
    if len(labels) >= 2:
        gap = abs(labels[1][1] - labels[0][1])
        return min(gap / 2.0, 130.0)
    return 120.0


def page_body_lines(page):
    """Return body text lines as dicts with geometry, in column-aware reading
    order. Skips headings, vertical gutter labels, and page-number footers.

    Each item: {"y", "x0", "x1", "text", "bold", "size"}.
    """
    raw = []
    d = page.get_text("dict")
    for b in d["blocks"]:
        if b["type"] != 0:
            continue
        for ln in b["lines"]:
            txt = "".join(s["text"] for s in ln["spans"]).strip()
            if not txt:
                continue
            dirv = ln.get("dir", (1, 0))
            if abs(dirv[1]) >= LABEL_ROT_TOL:      # vertical gutter label
                continue
            x0, y0, x1, y1 = ln["bbox"]
            s0 = ln["spans"][0]
            if y0 < HEADING_MAX_Y and s0["size"] >= SUB_HEADING_SIZE - 0.5:
                continue                            # page heading band
            if y0 > 745 and re.search(r"\d+\s*\|\s*P\s*a\s*g\s*e", txt, re.I):
                continue                            # footer
            raw.append({
                "y": round(y0, 1), "y1": round(y1, 1),
                "x0": round(x0, 1), "x1": round(x1, 1),
                "text": txt,
                "bold": "bold" in s0["font"].lower(),
                "size": round(s0["size"], 1),
            })
    # Merge bullet glyphs into their text *before* layout analysis, so a list
    # item is a single unit that cannot be split across regions or reordered.
    return _reading_order(_merge_bullet_glyphs(raw))


# ---- reading order: horizontal strips, then columns within each strip ----

BULLET_ONLY = re.compile(r'^[\u2022\u25aa\u25cb\u25e6o\-\u2013]$|^\d{1,2}[.)]$|^[a-z][.)]$|^[ivx]+[.)]$',
                         re.I)


def _reading_order(lines):
    """Order lines the way a human reads them using a recursive XY-cut.

    The page is repeatedly split at the widest band of whitespace: horizontal
    cuts first (top-to-bottom reading), then vertical cuts (left-to-right
    columns). This handles pages where stacked boxes each have *different*
    column boundaries — e.g. the ventilator reference pages, where a
    two-column troubleshooting box sits above two side-by-side boxes whose
    gutter is somewhere else entirely. A single global column split cannot
    cope with that; recursive region splitting can.
    """
    return _xy_cut(list(lines), 0)


def _xy_cut(lines, depth):
    if len(lines) <= 1 or depth >= 8:
        return sorted(lines, key=lambda l: (l["y"], l["x0"]))

    # --- try a horizontal cut (full-width whitespace band) ---
    ordered = sorted(lines, key=lambda l: (l["y"], l["x0"]))
    best_gap, best_i = 0.0, None
    running_bottom = ordered[0]["y1"]
    for i in range(1, len(ordered)):
        gap = ordered[i]["y"] - running_bottom
        if gap > best_gap:
            best_gap, best_i = gap, i
        running_bottom = max(running_bottom, ordered[i]["y1"])
    if best_gap >= MIN_ROW_GAP_PT and best_i is not None:
        top = ordered[:best_i]
        bottom = ordered[best_i:]
        if top and bottom:
            return _xy_cut(top, depth + 1) + _xy_cut(bottom, depth + 1)

    # --- else split around full-width lines ---
    # A line spanning the whole region (a banner, a note under a table) bridges
    # the column gutter, so the coverage test below would never find it. Emit
    # such lines in place and recurse on the segments between them.
    xr0 = min(l["x0"] for l in lines)
    xr1 = max(l["x1"] for l in lines)
    region_w = max(xr1 - xr0, 1.0)
    wide = [l for l in ordered if (l["x1"] - l["x0"]) > 0.70 * region_w]
    narrow_n = len(ordered) - len(wide)
    if wide and narrow_n >= 2:
        out, seg = [], []
        for ln in ordered:
            if (ln["x1"] - ln["x0"]) > 0.70 * region_w:
                if seg:
                    out.extend(_xy_cut(seg, depth + 1))
                    seg = []
                out.append(ln)
            else:
                seg.append(ln)
        if seg:
            out.extend(_xy_cut(seg, depth + 1))
        return out

    # --- else try a vertical cut (column gutter) ---
    xs0 = min(l["x0"] for l in lines)
    xs1 = max(l["x1"] for l in lines)
    width = xs1 - xs0
    if width >= 180:
        cov = [0] * (int(width) + 2)
        for l in lines:
            a = max(int(l["x0"] - xs0), 0)
            b = min(int(l["x1"] - xs0), int(width))
            for i in range(a, b + 1):
                cov[i] = 1
        best_len, best_mid, run, run_start = 0, None, 0, 0
        lo, hi = int(width * 0.12), int(width * 0.88)
        for i in range(lo, hi):
            if cov[i] == 0:
                if run == 0:
                    run_start = i
                run += 1
                if run > best_len:
                    best_len, best_mid = run, (run_start + i) / 2.0
            else:
                run = 0
        if best_len >= MIN_GUTTER_PT and best_mid is not None:
            split_x = xs0 + best_mid
            left = [l for l in lines if (l["x0"] + l["x1"]) / 2 <= split_x]
            right = [l for l in lines if (l["x0"] + l["x1"]) / 2 > split_x]
            if len(left) >= 2 and len(right) >= 2:
                lw = max(l["x1"] for l in left) - min(l["x0"] for l in left)
                rw = max(l["x1"] for l in right) - min(l["x0"] for l in right)
                if lw >= MIN_COL_WIDTH_PT and rw >= MIN_COL_WIDTH_PT:
                    return _xy_cut(left, depth + 1) + _xy_cut(right, depth + 1)

    return ordered


def _merge_bullet_glyphs(lines):
    """PyMuPDF often emits a list's bullet/number glyph as its own line.

    Attach each lone glyph to the nearest text line on the same visual row and
    to its right, so the item travels as one unit. Doing this before the XY-cut
    matters: a bare glyph is narrow while its text may span the region, so the
    two would otherwise land in different layout segments and be reordered.
    """
    out, used = [], set()
    by_y = sorted(range(len(lines)), key=lambda i: (lines[i]["y"], lines[i]["x0"]))
    for idx in by_y:
        if idx in used:
            continue
        ln = lines[idx]
        if not BULLET_ONLY.match(ln["text"]):
            continue
        cand = [j for j in by_y
                if j != idx and j not in used
                and abs(lines[j]["y"] - ln["y"]) <= 4
                and lines[j]["x0"] > ln["x0"]
                and not BULLET_ONLY.match(lines[j]["text"])]
        if not cand:
            continue
        j = min(cand, key=lambda k: lines[k]["x0"])
        tgt = lines[j]
        merged = dict(tgt)
        merged["text"] = f'{ln["text"]} {tgt["text"]}'
        merged["x0"] = ln["x0"]
        merged["y"] = min(ln["y"], tgt["y"])
        lines[j] = merged
        used.add(idx)
    for i, ln in enumerate(lines):
        if i not in used:
            out.append(ln)
    return out


# ---- horizontal (non-rotated) care-level headings ----

def find_horizontal_labels(lines):
    """Some guidelines label care levels with a centered bold heading
    ("BLS", "ALS & CCT", "PEARLS:") instead of the rotated gutter label.

    To avoid false positives from the legend table in 1.02 — where BLS/ALS/CCT
    appear as table cells beside a colour swatch and a description — a heading
    only counts when it stands alone on its line (no other text at the same y).
    Returns list of (index_in_lines, levels_tuple, display, y).
    """
    hits = []
    for i, ln in enumerate(lines):
        m = RE_HLABEL.match(ln["text"])
        if not m or not ln["bold"]:
            continue
        same_row = [o for j, o in enumerate(lines)
                    if j != i and abs(o["y"] - ln["y"]) <= 5]
        if same_row:                       # legend/table row -> not a heading
            continue
        levels = tuple(x.upper() for x in
                       re.findall(r"BLS|ALS|CCT|PEARLS", ln["text"], re.I))
        display = " & ".join(levels)
        hits.append((i, levels, display, ln["y"]))
    return hits


def extract_page_images(doc, page, header_xref, outdir: Path, page_no: int):
    """Extract real figures/flowcharts on a page; skip the header logo & tiny
    decorative images. Returns list of (filename, y_top)."""
    results = []
    seen = set()
    for info in page.get_images(full=True):
        xref = info[0]
        if xref == header_xref or xref in seen:
            continue
        seen.add(xref)
        try:
            pix = pymupdf.Pixmap(doc, xref)
        except Exception:
            continue
        if pix.width * pix.height < MIN_FIGURE_AREA:
            continue
        if pix.width * pix.height <= HEADER_LOGO_MAX_AREA and pix.width <= 215:
            continue  # logo-sized
        rects = page.get_image_rects(xref)
        y_top = min((r.y0 for r in rects), default=0.0)
        fname = f"p{page_no:03d}_x{xref}.png"

        # Images whose visible content is carried by a soft (alpha) mask render
        # as a solid black block if the raw XObject is saved on its own. For
        # those, rasterise the region of the page where the image is placed
        # instead: that composites base + mask exactly as the reader sees it.
        has_smask = False
        try:
            has_smask = bool(doc.extract_image(xref).get("smask"))
        except Exception:
            pass

        if has_smask and rects:
            page.get_pixmap(clip=rects[0], dpi=200).save(str(outdir / fname))
        else:
            if pix.n - pix.alpha >= 4:           # CMYK -> RGB
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            pix.save(str(outdir / fname))
        results.append((fname, y_top))
    return results


def extract_vector_figures(page, outdir: Path, page_no: int, dpi=170):
    """Capture figures drawn as native vector shapes rather than raster images.

    Some flowcharts in this document (e.g. the IO lidocaine flow chart, the
    ventilator mode decision diagram) are Word shapes, so they have no image
    XObject and `get_images()` returns nothing for them. Their *text* still
    extracts correctly, but the diagram itself would be lost, so the qualifying
    region is rendered to PNG and anchored like any other figure.

    Ordinary tables are also vector drawings, so the trigger is curved path
    segments (rounded callouts, arrows, diamonds), which table rules and cell
    fills do not produce.

    Returns list of (filename, y_top).
    """
    bbox = vector_figure_bbox(page)
    if bbox is None:
        return []
    pix = page.get_pixmap(clip=bbox, dpi=dpi)
    fname = f"p{page_no:03d}_vec.png"
    pix.save(str(outdir / fname))
    return [(fname, bbox.y0)]


def vector_figure_bbox(page):
    """The region of a vector-drawn diagram on this page, or None."""
    shapes = []
    curves = 0
    for d in page.get_drawings():
        r = d["rect"]
        if r.width < 3 or r.height < 3:
            continue
        if r.x0 < LABEL_MAX_X and r.width < 60:      # care-level gutter cell
            continue
        if r.width > 500 and r.height < 6:           # full-width rule
            continue
        has_curve = any(it[0] in ("c", "qu") for it in d["items"])
        if has_curve:
            curves += sum(1 for it in d["items"] if it[0] in ("c", "qu"))
        shapes.append((r, has_curve))

    if curves < VECTOR_FIGURE_MIN_CURVES:
        return None

    curved = [r for r, c in shapes if c]
    if not curved:
        return None
    bbox = curved[0]
    for r in curved[1:]:
        bbox = bbox | r
    # Include nearby shapes (arrows, plain boxes) that belong to the diagram.
    for r, _c in shapes:
        if r.intersects(bbox + (-15, -15, 15, 15)):
            bbox = bbox | r
    bbox = bbox + (-3, -2, 3, 3)
    bbox = bbox & page.rect
    if bbox.width < 120 or bbox.height < 90:
        return None
    return bbox


def build_blocks_for_subsection(doc, sub: Subsection, header_xref, img_dir: Path):
    """Walk every page of a subsection, splitting content into care-level
    blocks. Vertical gutter labels take priority; pages that use horizontal
    headings fall back to those; otherwise everything is a BODY block."""
    blocks: list[Block] = []
    for pno in range(sub.start_page, sub.end_page + 1):
        if pno - 1 >= doc.page_count:
            break
        page = doc[pno - 1]
        labels = find_care_labels(page)             # [(level, y_center), ...]
        lines = page_body_lines(page)               # reading-order dicts
        imgs = extract_page_images(doc, page, header_xref, img_dir, pno)
        imgs += extract_vector_figures(page, img_dir, pno)

        assign = {}          # index in `lines` -> band key
        band_levels = {}     # band key -> tuple of levels
        band_anchor = {}     # band key -> y used for image anchoring

        if labels:
            bands = find_care_bands(page, labels)
            exact = [(lvl, y0, y1) for lvl, y0, y1 in bands if y0 is not None]

            if len(exact) == len(labels) and exact:
                # Exact geometry available for every label on this page.
                def band_for_line(ln):
                    mid = (ln["y"] + ln["y1"]) / 2.0
                    for lvl, y0, y1 in exact:
                        if y0 - 2 <= mid <= y1 + 2:
                            return lvl
                    return "BODY"

                for i, ln in enumerate(lines):
                    assign[i] = band_for_line(ln)
                for lvl, y0, _y1 in exact:
                    band_levels[lvl] = (lvl,)
                    band_anchor[lvl] = y0

                def img_band(y):
                    for lvl, y0, y1 in exact:
                        if y0 - 2 <= y <= y1 + 2:
                            return lvl
                    return "BODY"
            else:
                # Fallback: interpolate boundaries, snapping to the largest
                # visual text gap near the midpoint between adjacent labels.
                body_ys = [(l["y"], l["x0"], l["text"]) for l in lines]
                boundaries = []
                for i, (lvl, yc) in enumerate(labels):
                    if i == 0:
                        raw = yc - _band_half_height(labels, i)
                        lo = raw - 40
                    else:
                        prev_yc = labels[i - 1][1]
                        raw = (prev_yc + yc) / 2.0
                        lo = prev_yc
                    boundaries.append((_snap_to_gap(body_ys, lo, yc, raw), lvl))

                def band_for_y(y):
                    chosen = "BODY"
                    for y_start, lvl in boundaries:
                        if y >= y_start:
                            chosen = lvl
                        else:
                            break
                    return chosen

                for i, ln in enumerate(lines):
                    assign[i] = band_for_y(ln["y"])
                for _y, lvl in boundaries:
                    band_levels[lvl] = (lvl,)
                    band_anchor[lvl] = _y
                img_band = band_for_y

            band_anchor["BODY"] = -1e9
            band_levels["BODY"] = ()
        else:
            hlabels = find_horizontal_labels(lines)
            cur = "BODY"
            band_levels["BODY"] = ()
            band_anchor["BODY"] = -1e9
            hmap = {i: (lv, disp, y) for i, lv, disp, y in hlabels}
            for i, ln in enumerate(lines):
                if i in hmap:
                    lv, disp, y = hmap[i]
                    cur = disp
                    band_levels[disp] = lv
                    band_anchor[disp] = y
                    continue            # heading itself isn't body text
                assign[i] = cur

            def img_band(y):
                chosen = "BODY"
                for _i, _lv, disp, ly in hlabels:
                    if y >= ly:
                        chosen = disp
                return chosen

        # group text in reading order
        grouped: dict[str, list] = {}
        for i, ln in enumerate(lines):
            key = assign.get(i)
            if key is None:
                continue
            grouped.setdefault(key, []).append(ln["text"])

        img_by_band: dict[str, list] = {}
        for fname, y in imgs:
            key = img_band(y)
            img_by_band.setdefault(key, []).append(fname)
            sub.images.append(fname)

        present = sorted(set(list(grouped) + list(img_by_band)),
                         key=lambda k: band_anchor.get(k, -1e9))
        for key in present:
            text = "\n".join(grouped.get(key, [])).strip()
            ims = img_by_band.get(key, [])
            if text or ims:
                blocks.append(Block(
                    care_level=key,
                    levels=list(band_levels.get(key, () if key == "BODY"
                                                else (key,))),
                    text=text, page=pno, images=ims))

    # Merge consecutive blocks of the same care level across page breaks.
    merged: list[Block] = []
    for blk in blocks:
        if merged and merged[-1].care_level == blk.care_level:
            if blk.text:
                merged[-1].text = (merged[-1].text + "\n" + blk.text).strip()
            merged[-1].images.extend(blk.images)
        else:
            merged.append(blk)
    sub.blocks = merged
    return sub


def most_common_image_xref(doc) -> int:
    from collections import Counter
    c = Counter()
    for pg in doc:
        for img in pg.get_images():
            c[img[0]] += 1
    return c.most_common(1)[0][0] if c else -1


# --------------------------------------------------------------------------
# Step 3 — outputs
# --------------------------------------------------------------------------

def write_outputs(version, sections, subs, outdir: Path, src_pdf: Path):
    outdir.mkdir(parents=True, exist_ok=True)

    # sections.json — full tree
    tree = {
        "version": version,
        "source_pdf": src_pdf.name,
        "sections": [
            {
                "number": s.number,
                "title": s.title,
                "start_page": s.start_page,
                "subsections": [
                    {
                        "number": ss.number, "title": ss.title,
                        "slug": ss.slug,
                        "section_number": ss.section_number,
                        "section_title": ss.section_title,
                        "start_page": ss.start_page, "end_page": ss.end_page,
                        "images": ss.images,
                        "blocks": [asdict(b) for b in ss.blocks],
                    } for ss in s.subsections
                ],
            } for s in sections
        ],
    }
    (outdir / "sections.json").write_text(json.dumps(tree, indent=2, ensure_ascii=False))

    # subsections.jsonl — one record per subsection (good for chunking/quiz gen)
    with (outdir / "subsections.jsonl").open("w", encoding="utf-8") as f:
        for ss in subs:
            rec = {
                "version": version,
                "id": f"{version}:{ss.number}",
                "number": ss.number, "title": ss.title, "slug": ss.slug,
                "section_number": ss.section_number,
                "section_title": ss.section_title,
                "start_page": ss.start_page, "end_page": ss.end_page,
                "care_levels": ss.care_levels(),
                "images": ss.images,
                "blocks": [asdict(b) for b in ss.blocks],
                "text": ss.plain_text(),
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # subsections.csv — flat overview
    with (outdir / "subsections.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["version", "number", "title", "section_number",
                    "section_title", "start_page", "end_page",
                    "care_levels", "n_images", "n_blocks", "char_count"])
        for ss in subs:
            w.writerow([version, ss.number, ss.title, ss.section_number,
                        ss.section_title, ss.start_page, ss.end_page,
                        "|".join(ss.care_levels()),
                        len(ss.images), len(ss.blocks),
                        len(ss.plain_text())])

    # manifest.json — integrity + counts
    manifest = {
        "version": version,
        "source_pdf": src_pdf.name,
        "source_sha256": _sha256(src_pdf),
        "n_sections": len(sections),
        "n_subsections": len(subs),
        "n_images": sum(len(ss.images) for ss in subs),
        "generated_files": ["sections.json", "subsections.jsonl",
                            "subsections.csv", "images/"],
    }
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------
# Optional: SQLite + FTS5 store
# --------------------------------------------------------------------------

def write_sqlite(db_path: Path, version, subs):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.executescript("""
    CREATE TABLE IF NOT EXISTS subsection(
        id TEXT PRIMARY KEY, version TEXT, number TEXT, title TEXT,
        section_number TEXT, section_title TEXT,
        start_page INT, end_page INT, care_levels TEXT, images TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS block(
        id INTEGER PRIMARY KEY AUTOINCREMENT, subsection_id TEXT, version TEXT,
        care_level TEXT, page INT, text TEXT, images TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS subsection_fts
        USING fts5(sub_id UNINDEXED, number, title, section_title, text);
    """)
    # Replace rows for this version (idempotent re-runs).
    cur.execute("DELETE FROM subsection WHERE version=?", (version,))
    cur.execute("DELETE FROM block WHERE version=?", (version,))
    cur.execute("DELETE FROM subsection_fts WHERE sub_id LIKE ?", (f"{version}:%",))
    # The source document can reuse a number for two different guidelines
    # (e.g. 5.05 is used for both "Atraumatic Hemorrhagic Stroke" and
    # "Cardiogenic Shock"). Keying on version+number alone would silently
    # overwrite one with the other, so the id is built from the slug (number +
    # title) and disambiguated by start page if even that repeats.
    used = set()
    for ss in subs:
        sid = f"{version}:{ss.slug}"
        if sid in used:
            sid = f"{sid}@p{ss.start_page}"
        used.add(sid)
        cur.execute("""INSERT OR REPLACE INTO subsection VALUES
                       (?,?,?,?,?,?,?,?,?,?,?)""",
                    (sid, version, ss.number, ss.title, ss.section_number,
                     ss.section_title, ss.start_page, ss.end_page,
                     "|".join(ss.care_levels()),
                     json.dumps(ss.images), ss.plain_text()))
        cur.execute("INSERT INTO subsection_fts(sub_id, number, title, section_title, text) "
                    "VALUES (?,?,?,?,?)",
                    (sid, ss.number, ss.title, ss.section_title, ss.plain_text()))
        for b in ss.blocks:
            cur.execute("INSERT INTO block(subsection_id,version,care_level,page,text,images) "
                        "VALUES (?,?,?,?,?,?)",
                        (sid, version, b.care_level, b.page, b.text,
                         json.dumps(b.images)))
    con.commit()
    con.close()


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Parse LFN Patient Care Guidelines PDF.")
    ap.add_argument("pdf", help="Path to the guidelines PDF")
    ap.add_argument("--outdir", default="lfn_build", help="Base output directory")
    ap.add_argument("--db", default=None, help="Optional SQLite DB path")
    args = ap.parse_args()

    src = Path(args.pdf)
    if not src.exists():
        sys.exit(f"Not found: {src}")

    doc = pymupdf.open(str(src))
    version = detect_version(doc)
    print(f"Detected version: {version}  ({doc.page_count} pages)")

    out = Path(args.outdir) / version
    img_dir = out / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    sections, subs = parse_toc(doc)
    offset = calibrate_page_offset(doc, subs)
    apply_page_offset(sections, subs, offset)
    clamp_to_section_dividers(sections, subs)
    print(f"TOC: {len(sections)} sections, {len(subs)} subsections "
          f"(page offset {offset:+d})")

    header_xref = most_common_image_xref(doc)
    for ss in subs:
        build_blocks_for_subsection(doc, ss, header_xref, img_dir)

    manifest = write_outputs(version, sections, subs, out, src)
    print(f"Wrote {manifest['n_subsections']} subsections, "
          f"{manifest['n_images']} images -> {out}")

    if args.db:
        write_sqlite(Path(args.db), version, subs)
        print(f"SQLite store updated: {args.db}")

    doc.close()


if __name__ == "__main__":
    main()

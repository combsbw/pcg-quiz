#!/usr/bin/env python3
"""
build_structure.py — re-extract guideline bodies as a *nested* outline.

The first pass flattened every care-level band into one list of sibling
bullets. That destroyed the information that carries the clinical meaning:

    For moderate symptoms (advancing hives, dyspnea)      <- the condition
      Diphenhydramine 1 mg/kg IV/IO/IM                    <- what to give
        Max 50 mg                                         <- the ceiling

flattened to three equal-rank lines, so a reader could not see which dose
belonged to which condition, and a question generator could not either.

Depth comes from the bullet marker rather than x-position. The document uses a
consistent marker ladder (• -> o -> ▪, and 1. -> a. -> i.), and markers survive
the multi-column history/assessment/differential tables, where x-position does
not: those three columns start at x≈60/240/420, so clustering on x would read
the Differential column as deeply nested under History.

Also strips the page furniture that was showing up as content: the repeated
title block and the "CONTINUES TO NEXT PAGE" banner that Word puts at the foot
of a guideline that spills over a page.

Writes `structure` onto each guideline in content.json. Run after
build_content.py.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import parse_lfn as P  # noqa: E402  (verified band/line extraction)
from extract_tables import data_tables  # noqa: E402

try:
    import pymupdf
except ImportError:
    raise SystemExit("pip install pymupdf --break-system-packages")

ROOT = Path(__file__).resolve().parent.parent
TABLE_DIR = ROOT / "docs" / "data" / "tables"
REGIONS = {k: v for k, v in json.loads(
    (ROOT / "tools" / "figure_regions.json").read_text()).items() if not k.startswith("_")}
RENDER = {k: v for k, v in json.loads(
    (ROOT / "tools" / "table_render.json").read_text()).items() if not k.startswith("_")}

# marker -> depth. Two parallel ladders; the document mixes them freely.
MARKERS = [
    (re.compile(r"^[•]\s+"), 1),
    (re.compile(r"^\d{1,2}[.)]\s+"), 1),
    (re.compile(r"^[o○◦]\s+"), 2),
    (re.compile(r"^[a-z][.)]\s+"), 2),
    (re.compile(r"^[▪§]\s+"), 3),
    (re.compile(r"^[ivx]{1,4}[.)]\s+", re.I), 3),
    (re.compile(r"^[–-]\s+"), 2),
]

FURNITURE = re.compile(
    r"^(contin(ue|ues|es|uing)\s+(to|on)\s+(the\s+)?next\s+page"
    r"|see\s+next\s+page\s+for\s+charts?"
    r"|dosing\s+chart\s+can\s+be\s+found\s+on\s+the\s+next\s+page"
    r"|\d+\s*\|\s*p\s*a\s*g\s*e)\s*$",
    re.I,
)

# A line that is purely a heading: bold with no marker, or anything ending ':'
HEADINGY = re.compile(r":\s*$")

# The same banner can also land *inside* an item once a wrapped line has been
# glued back on. Spelling varies in the source ("CONTINUES", "CONTINES",
# "CONTIUES"), so match the shape rather than the exact word. "See algorithm on
# next page" is real guidance and is deliberately not matched.
INLINE_BANNER = re.compile(
    r"\s*\bCONT[A-Z]*\s+(?:TO|ON)\s+(?:THE\s+)?NEXT\s+PAGE\b\s*", re.I)


def classify(line, title_words):
    """Return (depth, text, kind) or None to drop the line.

    depth 0 = heading, 1..3 = nested list item.
    """
    raw = line["text"].strip()
    if not raw:
        return None
    if FURNITURE.match(raw):
        return None

    depth, text = None, raw
    for rx, d in MARKERS:
        m = rx.match(raw)
        if m:
            depth, text = d, raw[m.end():].strip()
            break

    text = INLINE_BANNER.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None

    if depth is None:
        # No marker. Bold short text, or anything ending in a colon, is a
        # heading ("History", "ADULT:", "Croup:"). Everything else is a
        # continuation of the item above and gets merged by the caller.
        if line["bold"] or HEADINGY.search(text):
            # The page header repeats the guideline title on continuation
            # pages; drop it rather than showing it as a section of itself.
            w = set(re.findall(r"[a-z]+", text.lower()))
            if w and w <= title_words and len(text) < 60:
                return None
            return (0, text.rstrip(":").strip(), "heading")
        return (-1, text, "cont")

    return (depth, text, "item")


def table_item(page, g, pno, idx, t):
    """A data table as one outline item.

    Always carries a crop of the original table (the ground truth, legible with
    pinch-zoom) and the parsed grid. The grid is *shown* only for tables listed
    in table_render.json, i.e. ones whose rows and columns were checked against
    the page; the rest render as the image, because a mis-gridded table puts a
    value beside the wrong parameter, which is worse than no table. `text` is
    the grid flattened, so search still finds what is in the table.
    """
    TABLE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{g['id']}-p{pno}-{idx}.webp"
    x0, y0, x1, y1 = t["bbox"]
    clip = pymupdf.Rect(x0 - 3, y0 - 3, x1 + 3, y1 + 3) & page.rect
    pix = page.get_pixmap(matrix=pymupdf.Matrix(3, 3), clip=clip)
    from PIL import Image
    Image.frombytes("RGB", (pix.width, pix.height), pix.samples).save(
        TABLE_DIR / name, "WEBP", quality=72, method=6)

    mode = RENDER.get(f"{g['number']}:{pno}:{idx}", "image")
    header, rows = t["header"], t["rows"]
    if mode == "html-noheader" and header:
        rows, header = [header] + rows, None
    lines = ([" — ".join(header)] if header else []) + [
        " — ".join(c.replace("\n", "; ").replace("\u0001", "") for c in r if c) for r in rows]
    return {"depth": 1, "kind": "table", "render": "html" if mode.startswith("html") else "image",
            "header": header, "rows": rows, "image": f"tables/{name}",
            "aspect": round(pix.width / pix.height, 3), "text": "\n".join(lines)}


def region_item(page, g, pno, k, box, text, covers):
    TABLE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{g['id']}-p{pno}-fig{k}.webp"
    clip = pymupdf.Rect(*box) & page.rect
    pix = page.get_pixmap(matrix=pymupdf.Matrix(3, 3), clip=clip)
    from PIL import Image
    Image.frombytes("RGB", (pix.width, pix.height), pix.samples).save(
        TABLE_DIR / name, "WEBP", quality=72, method=6)
    return {"depth": 1, "kind": "figure", "image": f"tables/{name}",
            "covers": covers, "text": text}


def extract_structure(doc, g):
    """Nested outline per care-level band for one guideline."""
    out = []
    title_words = set(re.findall(r"[a-z]+", g["title"].lower()))

    for pno in range(g["page"], g.get("end_page", g["page"]) + 1):
        if pno - 1 >= doc.page_count:
            break
        page = doc[pno - 1]
        labels = P.find_care_labels(page)
        bands = P.find_care_bands(page, labels) if labels else []
        exact = [(l, a, b) for l, a, b in bands if a is not None]

        # The coloured gutter cell is painted behind only part of its table
        # row: on a page where BLS covers both an ADULT and a PEDIATRIC block,
        # the green cell stops after ADULT. Content landing in the gap before
        # the next band is still part of the band above it, so each band is
        # stretched to meet the next one (and the last to the page foot).
        # Without this, 45 of 377 bands came out as phantom "BODY" sections
        # holding the pediatric half of a care level.
        exact.sort(key=lambda t: t[1])
        stretched = []
        for i, (lvl, y0, y1) in enumerate(exact):
            end = exact[i + 1][1] - 1 if i + 1 < len(exact) else page.rect.y1
            stretched.append((lvl, y0, max(y1, end)))
        exact = stretched

        lines = P.page_body_lines(page)

        # Data tables come out as rows and columns; the loose lines inside them
        # would otherwise interleave every row with the next.
        def band_of(ln):
            mid = (ln["y"] + ln.get("y1", ln["y"])) / 2
            for lvl, y0, y1 in exact:
                if y0 - 2 <= mid <= y1 + 2:
                    return lvl
            return "BODY"

        tables = data_tables(page)
        for i, t in enumerate(tables):
            t["idx"] = i          # stable key into table_render.json

        def inside(box, outer, pad=2):
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            return (outer[0] - pad <= cx <= outer[2] + pad and
                    outer[1] - pad <= cy <= outer[3] + pad)

        # A table nested inside another (the FiO2/PEEP chart inside the
        # ventilator settings grid) is already part of the outer one.
        tables = [t for t in tables if not any(
            o is not t and inside(t["bbox"], o["bbox"]) and
            (o["bbox"][2] - o["bbox"][0]) * (o["bbox"][3] - o["bbox"][1]) >
            (t["bbox"][2] - t["bbox"][0]) * (t["bbox"][3] - t["bbox"][1])
            for o in tables)]

        # A vector-drawn diagram (shapes, arrows, tables inside it) is shown
        # where it sits on the page, as the picture; its loose text and any
        # tables inside it are not repeated as outline items.
        regions = [("table", t["idx"], t, t["bbox"]) for t in tables]
        vec = f"p{pno:03d}_vec.png"
        if vec in g.get("images", []):
            fb = P.vector_figure_bbox(page)
            if fb is not None:
                fb = [fb.x0, fb.y0, fb.x1, fb.y1]
                regions = [r for r in regions if not inside(r[3], fb)]
                regions.append(("figure", vec, None, fb))
        for k, box in enumerate(REGIONS.get(f"{g['number']}:{pno}", [])):
            regions = [r for r in regions if not inside(r[3], box)]
            regions.append(("region", k, None, box))
        regions.sort(key=lambda r: r[3][1])

        def in_region(ln):
            box = (ln["x0"], ln["y"], ln["x1"], ln.get("y1", ln["y"]))
            return any(inside(box, r[3]) for r in regions)
        region_text = {id(r): [] for r in regions}
        kept = []
        for ln in lines:
            hit = next((r for r in regions if inside(
                (ln["x0"], ln["y"], ln["x1"], ln.get("y1", ln["y"])), r[3])), None)
            if hit is None:
                kept.append(ln)
            else:
                region_text[id(hit)].append(ln["text"])
        lines = kept
        pending = list(regions)

        def covered(box):
            """Extracted raster figures that sit inside this region, so the
            page's Figures list does not show them a second time."""
            got = []
            for f in g.get("images", []):
                m = re.match(r"p(\d+)_x(\d+)\.png$", f)
                if not m or int(m.group(1)) != pno:
                    continue
                for rr in page.get_image_rects(int(m.group(2))):
                    if inside((rr.x0, rr.y0, rr.x1, rr.y1), box):
                        got.append(f)
                        break
            return got

        def emit_tables(before_y):
            while pending and pending[0][3][1] <= before_y:
                r = pending.pop(0)
                kind, key, t, box = r
                lvl = band_of({"y": box[1] + 4, "y1": box[1] + 4})
                if not out or out[-1]["care_level"] != lvl:
                    out.append({"care_level": lvl, "page": pno, "items": []})
                if kind == "table":
                    out[-1]["items"].append(table_item(page, g, pno, key, t))
                elif kind == "figure":
                    out[-1]["items"].append({
                        "depth": 1, "kind": "figure", "image": f"images/{key}",
                        "covers": covered(box), "text": " ".join(region_text[id(r)])})
                else:
                    out[-1]["items"].append(region_item(page, g, pno, key, box,
                                                        " ".join(region_text[id(r)]),
                                                        covered(box)))

        for ln in lines:
            emit_tables(ln["y"])
            lvl = band_of(ln)
            c = classify(ln, title_words)
            if c is None:
                continue
            depth, text, kind = c

            if not out or out[-1]["care_level"] != lvl:
                out.append({"care_level": lvl, "page": pno, "items": []})
            items = out[-1]["items"]

            if kind == "cont":
                if items and items[-1]["kind"] != "table":
                    # Wrapped line: glue it back onto the item it belongs to.
                    joined = (items[-1]["text"] + " " + text).strip()
                    items[-1]["text"] = re.sub(r"\s+", " ",
                                               INLINE_BANNER.sub(" ", joined)).strip()
                else:
                    items.append({"depth": 1, "text": text, "kind": "item"})
                continue
            items.append({"depth": depth, "text": text, "kind": kind})
        emit_tables(float("inf"))

    # Drop bands that ended up with nothing real in them (the phantom blocks
    # that produced "CONTINUES TO NEXT PAGE" tiles).
    cleaned = []
    for b in out:
        items = [i for i in b["items"] if len(i["text"]) > 1]
        if not items:
            continue
        if sum(len(i["text"]) for i in items) < 25:
            continue
        b["items"] = items
        cleaned.append(b)

    # Re-home orphaned BODY bands.
    #
    # Two ways one appears after a care level has started:
    #   * a guideline spills onto the next page and the content above that
    #     page's first gutter cell is the tail of the band from the page
    #     before (the PEDIATRIC half of CCT, say);
    #   * the three-column assessment table gets split by reading order.
    # Only the leading assessment table is genuinely unbanded, so anything
    # later is attached to its rightful neighbour rather than shown as a
    # section of its own.
    ASSESS = {"history", "assessment", "differential"}

    def is_assessment(band):
        return any(i["kind"] == "heading" and i["text"].strip().lower() in ASSESS
                   for i in band["items"])

    rehomed = []
    for b in cleaned:
        prev = rehomed[-1] if rehomed else None
        started = any(x["care_level"] != "BODY" for x in rehomed)
        if b["care_level"] == "BODY" and prev and started:
            if is_assessment(b):
                first = next((x for x in rehomed if x["care_level"] == "BODY"), None)
                if first is not None and first is not b:
                    first["items"].extend(b["items"])
                    continue
            else:
                prev["items"].extend(b["items"])
                continue
        rehomed.append(b)

    # Merge consecutive bands of the same care level across page breaks.
    merged = []
    for b in rehomed:
        if merged and merged[-1]["care_level"] == b["care_level"]:
            merged[-1]["items"].extend(b["items"])
        else:
            merged.append(b)
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default="/root/.claude/uploads/"
                    "1e05ed93-1e78-5825-a7f6-fb7980293b89/93ea7f77-2026-09-15_PCGs.pdf")
    ap.add_argument("--content", default=str(ROOT / "docs" / "data" / "content.json"))
    args = ap.parse_args()

    content = json.loads(Path(args.content).read_text(encoding="utf-8"))
    doc = pymupdf.open(args.pdf)

    import shutil
    shutil.rmtree(TABLE_DIR, ignore_errors=True)       # no stale crops
    n_items = 0
    for g in content["guidelines"]:
        g["structure"] = extract_structure(doc, g)
        n_items += sum(len(b["items"]) for b in g["structure"])

    doc.close()
    # The service worker precaches every table image from this list: reference
    # tables are exactly what a crew needs with no signal.
    imgs = sorted(f"data/tables/{f.name}" for f in TABLE_DIR.glob("*.webp"))
    (TABLE_DIR / "manifest.json").write_text(json.dumps(imgs, indent=0))
    Path(args.content).write_text(json.dumps(content, ensure_ascii=False),
                                 encoding="utf-8")
    bands = sum(len(g["structure"]) for g in content["guidelines"])
    print(f"structure: {len(content['guidelines'])} guidelines, "
          f"{bands} bands, {n_items} outline items")


if __name__ == "__main__":
    main()

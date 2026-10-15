#!/usr/bin/env python3
"""
build_ocr.py — OCR every page of the guidelines into authoring/ocr.json.

Why: the validator's strongest check is *grounding* — every number in a dose,
maximum or threshold answer must appear on the cited page. That check reads
the PDF text layer, and a large share of the highest-value reference material
has no text layer at all: the i-gel sizing table, the IO landmark figures, the
IBW charts, the RSI checklist, the termination-of-resuscitation and traumatic
arrest algorithms are all embedded images. Questions written from those pages
were previously verified only by an agent reading the image, with nothing
independent behind it.

OCR gives the validator a second, machine-read source for those pages, so an
image-derived number is held to the same standard as a typed one.

Usage:  python3 tools/build_ocr.py            (all pages, cached; ~a few min)
        python3 tools/build_ocr.py --pages 204 292
"""
from __future__ import annotations

import argparse
import io
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "authoring" / "ocr.json"
PDF = ("/root/.claude/uploads/1e05ed93-1e78-5825-a7f6-fb7980293b89/"
       "93ea7f77-2026-09-15_PCGs.pdf")
DPI = 300


def ocr_page(pno: int) -> tuple[int, str]:
    import pymupdf
    import pytesseract
    from PIL import Image
    doc = pymupdf.open(PDF)
    pix = doc[pno - 1].get_pixmap(dpi=DPI)
    img = Image.open(io.BytesIO(pix.tobytes("png")))
    # psm 6 treats the page as one block, which keeps table rows together.
    # Default segmentation splits a table into columns and loses which value
    # sits beside which label; both passes are kept so neither is lost.
    a = pytesseract.image_to_string(img)
    b = pytesseract.image_to_string(img, config="--psm 6")
    return pno, a + "\n" + b


def main():
    import pymupdf
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, nargs="*")
    args = ap.parse_args()

    n = pymupdf.open(PDF).page_count
    cache = json.loads(OUT.read_text()) if OUT.exists() else {}
    pages = args.pages or [p for p in range(1, n + 1) if str(p) not in cache]
    if not pages:
        print(f"ocr.json up to date ({len(cache)} pages)")
        return

    with ProcessPoolExecutor(max_workers=os.cpu_count() or 4) as ex:
        for i, (pno, text) in enumerate(ex.map(ocr_page, pages), 1):
            cache[str(pno)] = text
            if i % 25 == 0:
                OUT.write_text(json.dumps(cache))        # checkpoint
                print(f"  {i}/{len(pages)}")
    OUT.write_text(json.dumps(cache))
    print(f"ocr.json: {len(cache)} pages, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

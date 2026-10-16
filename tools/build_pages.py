#!/usr/bin/env python3
"""
build_pages.py — render every guideline page to docs/data/pages/pNNN.webp.

The "View page" button in Browse opens these. However good the parsing gets,
some pages are laid out in ways no extractor reads faithfully (arrow gauges
built from image fragments, nested charts). The original page is the ground
truth, and a crew member should never be one bad parse away from it.

~1224 px wide (2x), WebP q55, ~95 KB a page, ~28 MB in all. The service
worker caches them on demand, not at install.

Usage: python3 tools/build_pages.py [--pdf PATH]
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "pages"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default="/root/.claude/uploads/"
                    "1e05ed93-1e78-5825-a7f6-fb7980293b89/93ea7f77-2026-09-15_PCGs.pdf")
    args = ap.parse_args()
    content = json.loads((ROOT / "docs" / "data" / "content.json").read_text())
    pages = sorted({p for g in content["guidelines"]
                    for p in range(g["page"], g.get("end_page", g["page"]) + 1)})
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    doc = pymupdf.open(args.pdf)
    total = 0
    for p in pages:
        pix = doc[p - 1].get_pixmap(matrix=pymupdf.Matrix(2, 2))
        f = OUT / f"p{p:03d}.webp"
        Image.frombytes("RGB", (pix.width, pix.height), pix.samples).save(
            f, "WEBP", quality=55, method=6)
        total += f.stat().st_size
    print(f"pages: {len(pages)} rendered, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

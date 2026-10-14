#!/usr/bin/env python3
"""
build_icons.py — generate the app icon set.

Run:  python3 tools/build_icons.py

Why this is fussier than it looks:

* **iOS ignores the web manifest for "Add to Home Screen."** It reads
  `<link rel="apple-touch-icon">` only. Without one, iOS screenshots the page
  and uses that, which looks broken.
* **iOS has no alpha channel on home-screen icons.** Anything transparent is
  composited to black. An icon drawn with pre-rounded corners on a transparent
  canvas therefore shows *black* corners once iOS applies its own rounded mask.
  So the Apple icon is drawn full-bleed and fully opaque, with square corners —
  iOS does the rounding.
* **Android maskable icons get cropped** to whatever shape the launcher uses
  (circle, squircle, teardrop). The spec guarantees only the centre 80% circle,
  so the maskable variant draws the glyph smaller to survive the crop. The
  "any" variant keeps the glyph at full size for contexts that don't crop.

Everything is rendered at 4x and downsampled with LANCZOS, which gives cleaner
edges on the diagonal gradient and the glyph than drawing at final size.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "docs"
SS = 4  # supersample factor

# Matches the in-app brand mark: linear-gradient(135deg, var(--accent), var(--c2))
GRAD_FROM = (30, 99, 208)    # --accent  #1e63d0
GRAD_TO = (15, 155, 142)     # --c2      #0f9b8e
GLYPH = (255, 255, 255)


def gradient(size: int) -> Image.Image:
    """Opaque 135° linear gradient, top-left to bottom-right."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    denom = max(1, (size - 1) * 2)
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            px[x, y] = (
                round(GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t),
                round(GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t),
                round(GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t),
            )
    return img


def draw_cross(img: Image.Image, span: float, thick: float) -> None:
    """Centred medical cross with rounded ends.

    `span` and `thick` are fractions of the icon edge: the cross is
    `span` wide overall and each arm is `thick` across.
    """
    s = img.size[0]
    d = ImageDraw.Draw(img)
    c = s / 2
    hs, ht = span * s / 2, thick * s / 2
    r = ht * 0.42
    d.rounded_rectangle([c - ht, c - hs, c + ht, c + hs], radius=r, fill=GLYPH)
    d.rounded_rectangle([c - hs, c - ht, c + hs, c + ht], radius=r, fill=GLYPH)


def make(size: int, span: float, thick: float) -> Image.Image:
    big = size * SS
    img = gradient(big)
    draw_cross(img, span, thick)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    written = []

    # --- iOS home screen. 180px covers every modern iPhone; iOS downscales for
    # older/smaller targets. Opaque RGB, square corners, full bleed.
    for name, size in (("apple-touch-icon.png", 180),
                       ("apple-touch-icon-167.png", 167),   # iPad Pro
                       ("apple-touch-icon-152.png", 152)):  # older iPad
        img = make(size, span=0.60, thick=0.235).convert("RGB")
        img.save(OUT / name, optimize=True)
        written.append((name, size, "RGB"))

    # --- Web manifest "any": used by Android/Chrome/desktop installs.
    for size in (192, 512):
        img = make(size, span=0.60, thick=0.235).convert("RGB")
        img.save(OUT / f"icon-{size}.png", optimize=True)
        written.append((f"icon-{size}.png", size, "RGB"))

    # --- Web manifest "maskable": glyph pulled in so an aggressive launcher
    # crop (circle) cannot clip the arms of the cross.
    img = make(512, span=0.42, thick=0.165).convert("RGB")
    img.save(OUT / "icon-maskable-512.png", optimize=True)
    written.append(("icon-maskable-512.png", 512, "RGB"))

    for name, size, mode in written:
        p = OUT / name
        print(f"  {name:<28} {size}x{size} {mode} {p.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()

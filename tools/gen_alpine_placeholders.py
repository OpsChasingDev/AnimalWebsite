"""Deterministic ink-and-brush placeholder art for the illustrated alpine ground.

This script stands in for real Claude Design / hand-painted art until
that art lands. It reads ``static/images/alpine/manifest.json`` — the single
source of truth for file names, pixel sizes, atlas cell layouts and byte
caps — and for every entry draws a simple placeholder in the ink-brush style
described by ``docs/alpine-art-brief.md``: jittered-polyline brush strokes,
stipple grain, flat palette fills and ink outlines. Every asset's randomness
is seeded from its own file name (and, for atlas cells, the cell name too),
so re-running the generator produces byte-identical output (the "the
build never waits on real art" only holds if the art is reproducible).

Modes (see ``main()`` / the module docstring at the bottom for CLI usage):

- default: draw every asset, WebP-encode it under its category's per-file
  byte cap, write it to disk, and rewrite the manifest's ``hash``
  field for each file touched.
- ``--check``: verify every manifest file exists at the right pixel size,
  with the right hash, under every byte cap. Exits 1 and prints every
  offending file on failure.
- ``--rehash``: recompute each manifest ``hash`` from the file already on
  disk, without regenerating any art. This is the one step needed after a
  real WebP is dropped in over a placeholder of the same name and size
 .
- ``--only <file>``: restrict ``--rehash`` or the default (generate) mode to
  a single manifest entry, for fast iteration.

The manifest text is edited surgically (only the ``hash`` string for a
touched entry is replaced) rather than re-serialized from the parsed JSON,
so a run that only changes a hash produces a minimal diff: same key order,
same 2-space indentation, same one-line ``cells`` entries, same trailing
newline.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import random
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = REPO_ROOT / "static" / "images" / "alpine" / "manifest.json"
DEFAULT_OUT_DIR = REPO_ROOT / "static" / "images" / "alpine"

HASH_LEN = 16  # hex chars of sha256 kept in the manifest; plenty for a cache-busting query string

# ---------------------------------------------------------------------------
# Palette (docs/alpine-art-brief.md section 2) — the ink line color and the
# per-season ground/companion tones. Kept here instead of re-derived from
# journey.js so this script has no runtime dependency on the JS file.
# ---------------------------------------------------------------------------
INK = (0x24, 0x1F, 0x1A)
TEAL = (0x2E, 0x7A, 0x80)
TEAL_LIGHT = (0x6F, 0xC7, 0xC2)
SNOW_PALE = (0xEB, 0xEC, 0xE6)

SEASON = {
    "spring": {"ground": (0xA2, 0xB8, 0x7F), "evergreen": (0x5E, 0x82, 0x56),
               "snow": (0xD8, 0xD9, 0xC8), "rock": (0x8B, 0x8A, 0x7E)},
    "summer": {"ground": (0x8C, 0xA6, 0x68), "evergreen": (0x4F, 0x73, 0x48),
               "rock": (0x7C, 0x7A, 0x6C), "accent": (0xC9, 0xA2, 0x27)},
    "autumn": {"ground": (0xAC, 0x9A, 0x5C), "evergreen": (0x5E, 0x7A, 0x4C),
               "rust": (0xA8, 0x72, 0x2E), "rock": (0x8F, 0x8B, 0x7A)},
    "winter": {"ground": (0xD3, 0xD6, 0xCB), "shadow_snow": (0xA9, 0xB4, 0xB7),
               "bare": (0x5B, 0x6E, 0x58), "evergreen": (0x87, 0x94, 0x7A)},
}

# Season-independent averages, for the manifest's "*-neutral" palette roles.
def _avg(*rgbs):
    return tuple(round(sum(c[i] for c in rgbs) / len(rgbs)) for i in range(3))

ROCK_NEUTRAL = _avg(SEASON["spring"]["rock"], SEASON["summer"]["rock"], SEASON["autumn"]["rock"])
EVERGREEN_NEUTRAL = _avg(SEASON["spring"]["evergreen"], SEASON["summer"]["evergreen"], SEASON["autumn"]["evergreen"])

# ---------------------------------------------------------------------------
# WebP encoding: lossy with alpha, quality stepped down until the
# file fits its category's per-file cap; lossless is only attempted for the
# three flat-fill tiles, and only if lossy can't make the cap.
# ---------------------------------------------------------------------------
QUALITY_LADDER = (85, 78, 70, 62, 54, 46, 38, 30, 22, 15)
LOSSLESS_ELIGIBLE = {"dirt_tile", "water_tile", "bank_tile"}
OPAQUE_CATEGORIES = {"dirt_tile", "water_tile", "bank_tile"}


def encode_webp(img: Image.Image, cap_bytes: int, category: str):
    """Return (bytes, quality_or_None, lossless_bool) fitting cap_bytes if possible.

    Tries the quality ladder from highest to lowest; if even the lowest
    quality is still over cap and the category is eligible, tries lossless.
    Falls back to whichever attempt produced the smallest file otherwise
    (--check will then report the cap violation by name).
    """
    if category in OPAQUE_CATEGORIES and img.mode != "RGB":
        img = img.convert("RGB")
    best = None
    for q in QUALITY_LADDER:
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=q, method=6)
        data = buf.getvalue()
        if best is None or len(data) < len(best[0]):
            best = (data, q, False)
        if len(data) <= cap_bytes:
            return data, q, False
    if category in LOSSLESS_ELIGIBLE:
        buf = io.BytesIO()
        img.save(buf, format="WEBP", lossless=True, method=6)
        data = buf.getvalue()
        if len(data) <= cap_bytes:
            return data, None, True
        if len(data) < len(best[0]):
            best = (data, None, True)
    return best


# ---------------------------------------------------------------------------
# Torus-wrap drawing helpers for seamless tiles: draw every primitive at all
# nine (dx*w, dy*h) offsets for dx, dy in (-1, 0, 1). Pillow silently clips
# drawing to the canvas, so only the offsets that land on-canvas are ever
# visible — this guarantees left==right and top==bottom for any primitive.
# ---------------------------------------------------------------------------
def _torus_offsets(w, h):
    return [(dx * w, dy * h) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]


def wrapped_line(draw, pts, w, h, **kw):
    for ox, oy in _torus_offsets(w, h):
        draw.line([(x + ox, y + oy) for x, y in pts], **kw)


def wrapped_ellipse(draw, bbox, w, h, **kw):
    x0, y0, x1, y1 = bbox
    for ox, oy in _torus_offsets(w, h):
        draw.ellipse((x0 + ox, y0 + oy, x1 + ox, y1 + oy), **kw)


def wrapped_polygon(draw, pts, w, h, **kw):
    for ox, oy in _torus_offsets(w, h):
        draw.polygon([(x + ox, y + oy) for x, y in pts], **kw)


# ---------------------------------------------------------------------------
# Seamless categories: ground overlays, dirt/water/bank tiles, water highlight.
# ---------------------------------------------------------------------------
def draw_ground_overlay_neutral(w, h, rng):
    """Season-neutral brush grain: transparent body, ink strokes and stipple
    mostly under ~40% alpha, per the brief's "texture only, no fill color"
    rule for the a/b/c ground overlays."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    n_strokes = int(w * h / 4200)
    for _ in range(n_strokes):
        x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
        angle = rng.uniform(0, math.tau)
        length = rng.uniform(w * 0.012, w * 0.045)
        pts = []
        steps = 4
        for s in range(steps + 1):
            t = s / steps
            jx = rng.uniform(-length * 0.12, length * 0.12)
            jy = rng.uniform(-length * 0.12, length * 0.12)
            pts.append((x0 + math.cos(angle) * length * t + jx, y0 + math.sin(angle) * length * t + jy))
        alpha = rng.randint(16, 95)
        width = 1 if rng.random() < 0.7 else 2
        wrapped_line(d, pts, w, h, fill=INK + (alpha,), width=width, joint="curve")
    n_stipple = int(w * h / 1100)
    for _ in range(n_stipple):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(0.5, 1.5)
        alpha = rng.randint(10, 70)
        wrapped_ellipse(d, (x - r, y - r, x + r, y + r), w, h, fill=INK + (alpha,))
    return img


def draw_ground_overlay_winter(w, h, rng):
    """The one overlay that carries real color: pale drift blobs, a few bare
    grass tufts, and ink grain on top."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for _ in range(rng.randint(9, 13)):
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        rx = rng.uniform(w * 0.05, w * 0.14)
        ry = rx * rng.uniform(0.4, 0.7)
        n = 9
        pts = []
        for k in range(n):
            ang = 2 * math.pi * k / n
            rad = rng.uniform(0.75, 1.05)
            pts.append((cx + math.cos(ang) * rx * rad, cy + math.sin(ang) * ry * rad))
        alpha = rng.randint(150, 235)
        color = SNOW_PALE if rng.random() < 0.7 else SEASON["winter"]["shadow_snow"]
        wrapped_polygon(d, pts, w, h, fill=color + (alpha,))
    for _ in range(rng.randint(14, 22)):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        h2 = rng.uniform(4, 10)
        wrapped_line(d, [(x, y), (x + rng.uniform(-2, 2), y - h2)], w, h,
                     fill=SEASON["winter"]["bare"] + (190,), width=1)
    n_strokes = int(w * h / 6000)
    for _ in range(n_strokes):
        x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
        angle = rng.uniform(0, math.tau)
        length = rng.uniform(w * 0.01, w * 0.03)
        pts = [(x0, y0), (x0 + math.cos(angle) * length, y0 + math.sin(angle) * length)]
        alpha = rng.randint(30, 110)
        wrapped_line(d, pts, w, h, fill=INK + (alpha,), width=1)
    return img


def draw_flat_seamless_tile(w, h, rng, base_rgb, grain_density=1.0):
    """Flat opaque fill (a constant color trivially tiles) plus wrapped ink
    grain. Used as-is for the dirt trail; the water and bank tiles layer
    more on top of this."""
    img = Image.new("RGBA", (w, h), base_rgb + (255,))
    d = ImageDraw.Draw(img)
    n_strokes = int(w * h / 1800 * grain_density)
    for _ in range(n_strokes):
        x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
        angle = rng.uniform(0, math.tau)
        length = rng.uniform(w * 0.01, w * 0.04)
        pts = [(x0 + math.cos(angle) * length * (s / 2) + rng.uniform(-2, 2),
                y0 + math.sin(angle) * length * (s / 2) + rng.uniform(-2, 2)) for s in range(3)]
        alpha = rng.randint(20, 90)
        wrapped_line(d, pts, w, h, fill=INK + (alpha,), width=1)
    n_stipple = int(w * h / 700 * grain_density)
    for _ in range(n_stipple):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(0.5, 1.3)
        alpha = rng.randint(15, 70)
        wrapped_ellipse(d, (x - r, y - r, x + r, y + r), w, h, fill=INK + (alpha,))
    return img


def draw_water_tile(w, h, rng):
    """Flat glacial teal fill, a few hard-edged lighter ripple shapes, ink grain."""
    img = draw_flat_seamless_tile(w, h, rng, TEAL, grain_density=0.5)
    d = ImageDraw.Draw(img)
    for _ in range(rng.randint(6, 10)):
        cx, cy = rng.uniform(0, w), rng.uniform(0, h)
        rx = rng.uniform(w * 0.06, w * 0.16)
        ry = rx * rng.uniform(0.18, 0.32)
        n = 8
        pts = []
        for k in range(n):
            ang = 2 * math.pi * k / n
            rad = rng.uniform(0.8, 1.0)
            pts.append((cx + math.cos(ang) * rx * rad, cy + math.sin(ang) * ry * rad))
        wrapped_polygon(d, pts, w, h, fill=TEAL_LIGHT + (255,))
    return img


def draw_bank_tile(w, h, rng):
    """Rock-neutral fill with a horizontal wet-edge band in glacial teal
    through the middle (kept away from the top/bottom seam on purpose, so
    both edges stay plain rock and the vertical wrap is trivially exact)."""
    img = draw_flat_seamless_tile(w, h, rng, ROCK_NEUTRAL, grain_density=0.6)
    d = ImageDraw.Draw(img)
    band_top = h * rng.uniform(0.38, 0.46)
    band_h = h * rng.uniform(0.14, 0.22)
    jitter = h * 0.03
    step = max(1, w // 24)
    xs = list(range(0, w, step))
    # The x=0 and x=w jitter values must match exactly (they land on the
    # same seam when the tile repeats horizontally), so sample jitter only
    # at xs and reuse xs[0]'s value for the closing point at x=w.
    top_j = [rng.uniform(-jitter, jitter) for _ in xs]
    bot_j = [rng.uniform(-jitter, jitter) for _ in xs]
    top_pts = [(x, band_top + j) for x, j in zip(xs, top_j)] + [(w, band_top + top_j[0])]
    bot_pts = [(x, band_top + band_h + j) for x, j in zip(xs, bot_j)] + [(w, band_top + band_h + bot_j[0])]
    poly = top_pts + list(reversed(bot_pts))
    # The band shape now closes exactly at x=0/x=w, so it tiles horizontally
    # without needing the torus-wrap helper — only the grain drawn over it does.
    d.polygon(poly, fill=TEAL_LIGHT + (255,))
    n_grain = int(w * h / 2600)
    for _ in range(n_grain):
        x, y = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(0.5, 1.2)
        alpha = rng.randint(15, 60)
        wrapped_ellipse(d, (x - r, y - r, x + r, y + r), w, h, fill=INK + (alpha,))
    return img


def draw_water_highlight(w, h, rng):
    """Pale glacial-teal streaks on transparent, for the creek's flowing highlight."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for _ in range(rng.randint(10, 16)):
        y = rng.uniform(0, h)
        cx = rng.uniform(0, w)
        length = rng.uniform(w * 0.06, w * 0.16)
        thick = rng.uniform(2, 5)
        alpha = rng.randint(120, 220)
        pts = [(cx - length / 2, y), (cx + length / 2, y)]
        wrapped_line(d, pts, w, h, fill=TEAL_LIGHT + (alpha,), width=int(thick))
    return img


# ---------------------------------------------------------------------------
# Atlas subjects (tree/rock sheet and grass sheet). Each function draws onto
# a small transparent canvas sized to the cell's *inner* box (already
# shrunk by cell_padding_px on every side), so it is physically impossible
# for a drawing bug to put opaque paint outside the cell.
# ---------------------------------------------------------------------------
def _tier(d, cx, ty, hw, th, rng, fill_rgb, snow):
    """One drooping spruce tier: a jittered hexagon, narrower and drooping at
    the tips rather than a symmetric triangle (brief: no Christmas-tree
    clipart)."""
    j = lambda v, amt: v + rng.uniform(-amt, amt)
    jitter = hw * 0.08 + 0.6
    pts = [
        (j(cx, jitter * 0.4), ty),
        (j(cx + hw, jitter), ty + th * 0.55),
        (j(cx + hw * 0.55, jitter * 0.6), ty + th),
        (j(cx, jitter * 0.4), ty + th * 0.72),
        (j(cx - hw * 0.55, jitter * 0.6), ty + th),
        (j(cx - hw, jitter), ty + th * 0.55),
    ]
    d.polygon(pts, fill=fill_rgb + (255,), outline=INK + (255,))
    if snow:
        sw = hw * 0.68
        spts = [
            (cx, ty - th * 0.02),
            (cx + sw * 0.5, ty + th * 0.2),
            (cx, ty + th * 0.34),
            (cx - sw * 0.5, ty + th * 0.2),
        ]
        d.polygon(spts, fill=SNOW_PALE + (255,), outline=INK + (255,))


def draw_spruce(iw, ih, rng, snow=False, bare=False):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = iw / 2
    margin = max(1.5, min(iw, ih) * 0.07)
    top, bottom = margin, ih - margin
    trunk_w = max(1, iw * 0.045)
    fg = EVERGREEN_NEUTRAL
    if bare:
        d.line([(cx, bottom), (cx, top + (bottom - top) * 0.2)], fill=INK + (255,), width=max(1, int(trunk_w)))
        n_tiers = 2
        tier_h = (bottom - top) * 0.26
        for i in range(n_tiers):
            frac = i / max(1, n_tiers - 1)
            hw = iw * (0.11 + 0.07 * (1 - frac))
            ty = top + (bottom - top) * 0.18 * frac
            _tier(d, cx, ty, hw, tier_h * 0.75, rng, fg, snow=False)
        for _ in range(3):
            sy = rng.uniform(top, bottom * 0.55)
            sx = cx + rng.choice((-1, 1)) * rng.uniform(iw * 0.05, iw * 0.22)
            d.line([(cx, sy), (sx, sy - rng.uniform(2, 6))], fill=INK + (220,), width=1)
        return img
    n_tiers = rng.randint(5, 7)
    tier_h = (bottom - top) / n_tiers
    max_hw = iw * 0.46
    for i in range(n_tiers):
        frac = i / (n_tiers - 1) if n_tiers > 1 else 0
        hw = max_hw * (1 - frac * 0.78)
        ty = bottom - (i + 1) * tier_h
        th = tier_h * 1.35
        _tier(d, cx, ty, hw, th, rng, fg, snow=snow)
    d.line([(cx, bottom), (cx, bottom - tier_h * 0.5)], fill=INK + (255,), width=max(1, int(trunk_w)))
    return img


def draw_broadleaf(iw, ih, rng):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = iw / 2
    trunk_h = ih * 0.22
    trunk_w = max(2, iw * 0.06)
    base = ih - ih * 0.05
    d.rectangle([cx - trunk_w / 2, base - trunk_h, cx + trunk_w / 2, base], fill=INK + (255,))
    canopy_r = min(iw, ih * 0.7) / 2 * 0.85
    ccy = base - trunk_h - canopy_r * 0.75
    n = 10
    pts = []
    for k in range(n):
        ang = 2 * math.pi * k / n
        rad = canopy_r * (0.8 + rng.uniform(-0.15, 0.18))
        pts.append((cx + math.cos(ang) * rad, ccy + math.sin(ang) * rad * 0.85))
    d.polygon(pts, fill=EVERGREEN_NEUTRAL + (255,), outline=INK + (255,))
    return img


def draw_boulder(iw, ih, rng):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = iw / 2, ih * 0.56
    rx, ry = iw * 0.44, ih * 0.4
    n = rng.randint(7, 9)
    pts = []
    for k in range(n):
        ang = 2 * math.pi * k / n
        rad = rng.uniform(0.78, 1.0)
        pts.append((cx + math.cos(ang) * rx * rad, cy + math.sin(ang) * ry * rad))
    d.polygon(pts, fill=ROCK_NEUTRAL + (255,), outline=INK + (255,))
    mid = n // 2
    d.line([pts[mid], pts[(mid + 1) % n]], fill=INK + (200,), width=2)
    return img


def draw_scree(iw, ih, rng):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for _ in range(rng.randint(22, 30)):
        x, y = rng.uniform(iw * 0.06, iw * 0.94), rng.uniform(ih * 0.15, ih * 0.9)
        r = rng.uniform(2, 6)
        d.ellipse([x - r, y - r, x + r, y + r], fill=ROCK_NEUTRAL + (255,), outline=INK + (255,))
    return img


def draw_log(iw, ih, rng):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y0, y1 = ih * 0.36, ih * 0.64
    x0, x1 = iw * 0.08, iw * 0.9
    r = (y1 - y0) / 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=ROCK_NEUTRAL + (255,), outline=INK + (255,))
    cap = tuple(min(255, c + 18) for c in ROCK_NEUTRAL)
    d.ellipse([x1 - r * 1.2, y0, x1 + r * 0.05, y1], fill=cap + (255,), outline=INK + (255,))
    return img


def draw_flowers(iw, ih, rng):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    base_y = ih * 0.9
    for _ in range(rng.randint(4, 6)):
        x = rng.uniform(iw * 0.16, iw * 0.84)
        stem_h = rng.uniform(ih * 0.32, ih * 0.58)
        d.line([(x, base_y), (x, base_y - stem_h)], fill=EVERGREEN_NEUTRAL + (255,), width=1)
        r = rng.uniform(2.5, 4.5)
        d.ellipse([x - r, base_y - stem_h - r, x + r, base_y - stem_h + r],
                  fill=SEASON["summer"]["accent"] + (255,), outline=INK + (200,))
    return img


def draw_grass(iw, ih, rng):
    img = Image.new("RGBA", (iw, ih), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    base_y = ih - 1
    for _ in range(rng.randint(5, 8)):
        bend = rng.uniform(-1, 1)
        h = rng.uniform(ih * 0.5, ih * 0.85)
        w = max(1, int(rng.uniform(1.2, 2.2)))
        x0 = iw / 2 + rng.uniform(-iw * 0.14, iw * 0.14)
        pts = []
        steps = 5
        for s in range(steps + 1):
            t = s / steps
            pts.append((x0 + bend * h * 0.35 * (t ** 1.6), base_y - h * t))
        d.line(pts, fill=EVERGREEN_NEUTRAL + (255,), width=w, joint="curve")
    return img


_ATLAS_SUBJECTS = None  # populated below, after the draw_* functions exist


def _tree_rock_cell(name, iw, ih, rng):
    if name.startswith("spruce-tall") or name.startswith("spruce-short"):
        return draw_spruce(iw, ih, rng, bare=name.endswith("-d"))
    if name.startswith("spruce-snow"):
        return draw_spruce(iw, ih, rng, snow=True)
    if name.startswith("broadleaf"):
        return draw_broadleaf(iw, ih, rng)
    if name.startswith("boulder"):
        return draw_boulder(iw, ih, rng)
    if name == "scree-patch":
        return draw_scree(iw, ih, rng)
    if name == "fallen-log":
        return draw_log(iw, ih, rng)
    if name.startswith("flower-clump"):
        return draw_flowers(iw, ih, rng)
    raise ValueError(f"no drawing routine for atlas cell {name!r}")


def _grass_cell(name, iw, ih, rng):
    return draw_grass(iw, ih, rng)


def draw_atlas_sheet(size, cells, asset_file, pad, subject_fn):
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for cell in cells:
        cx, cy, cw, ch = cell["x"], cell["y"], cell["w"], cell["h"]
        iw, ih = cw - 2 * pad, ch - 2 * pad
        rng = random.Random(f"{asset_file}::{cell['name']}")
        sub = subject_fn(cell["name"], iw, ih, rng)
        img.alpha_composite(sub, (cx + pad, cy + pad))
    return img


# ---------------------------------------------------------------------------
# Backdrop (painted mountain flanks/centre range) and set-dressing vignettes.
# ---------------------------------------------------------------------------
def draw_mountain_backdrop(w, h, rng, wide=False):
    """Transparent sky, opaque painted rock from the ridge line down to the
    bottom edge: a jagged silhouette, a few striation bands clipped to it,
    and pale snow patches near the saddles."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    n_peaks = rng.randint(6, 9) if wide else rng.randint(3, 5)
    xs = [w * i / n_peaks for i in range(n_peaks + 1)]
    ridge_top_frac = 0.18
    pts_top = [(x, rng.uniform(h * ridge_top_frac, h * 0.55)) for x in xs]
    poly = list(pts_top) + [(w, h), (0, h)]
    rock_a, rock_b = ROCK_NEUTRAL, SEASON["summer"]["rock"]
    d.polygon(poly, fill=rock_a + (255,), outline=INK + (255,))

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    band_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band_layer)
    n_bands = rng.randint(4, 6)
    tilt = rng.uniform(-0.12, 0.12)
    band_span = h * 0.6
    for i in range(n_bands):
        by0 = h * ridge_top_frac + i * (band_span / n_bands)
        by1 = by0 + band_span / n_bands * 1.15
        shade = rock_a if i % 2 == 0 else rock_b
        band_pts = [(0, by0), (w, by0 + tilt * w), (w, by1 + tilt * w), (0, by1)]
        bd.polygon(band_pts, fill=shade + (255,))
        bd.line([(0, by0), (w, by0 + tilt * w)], fill=INK + (150,), width=2)
    transparent = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    clipped_bands = Image.composite(band_layer, transparent, mask)
    img = Image.alpha_composite(img, clipped_bands)

    snow_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(snow_layer)
    for (x, y) in pts_top:
        if rng.random() < 0.65:
            r = rng.uniform(w * 0.018, w * 0.045)
            sd.ellipse([x - r, y - r * 0.35, x + r, y + r * 1.3], fill=SNOW_PALE + (255,), outline=INK + (255,))
    clipped_snow = Image.composite(snow_layer, transparent, mask)
    img = Image.alpha_composite(img, clipped_snow)

    d = ImageDraw.Draw(img)
    d.line(pts_top, fill=INK + (255,), width=2, joint="curve")
    return img


def draw_set_dressing(w, h, rng, role):
    """Simple placeholder vignette: a ground patch plus a small tree, a
    boulder and a few flowers, composited from the same subject drawers as
    the atlas — enough to read as "more painted detail here" without
    inventing a new subject."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    gx, gy = w / 2, h * 0.82
    grx, gry = w * 0.42, h * 0.15
    n = 10
    pts = []
    for k in range(n):
        ang = 2 * math.pi * k / n
        rad = rng.uniform(0.85, 1.05)
        pts.append((gx + math.cos(ang) * grx * rad, gy + math.sin(ang) * gry * rad))
    d.polygon(pts, fill=ROCK_NEUTRAL + (255,), outline=INK + (180,))

    tree_w, tree_h = max(8, int(w * 0.22)), max(8, int(h * 0.55))
    tree = draw_spruce(tree_w, tree_h, rng, snow=(role == "set_dressing_belles_lantern" and False))
    img.alpha_composite(tree, (int(w * 0.1), int(h * 0.14)))

    b_w, b_h = max(8, int(w * 0.24)), max(8, int(h * 0.2))
    boulder = draw_boulder(b_w, b_h, rng)
    img.alpha_composite(boulder, (int(w * 0.56), int(h * 0.56)))

    f_w, f_h = max(8, int(w * 0.22)), max(8, int(h * 0.3))
    flowers = draw_flowers(f_w, f_h, rng)
    img.alpha_composite(flowers, (int(w * 0.66), int(h * 0.5)))
    return img


# ---------------------------------------------------------------------------
# Dispatch and manifest I/O
# ---------------------------------------------------------------------------
def load_manifest(manifest_path: Path) -> dict:
    return json.loads(Path(manifest_path).read_text())


def draw_asset(asset: dict, cell_padding_px: int) -> Image.Image:
    w, h = asset["size"]
    role = asset["role"]
    cat = asset["category"]
    if asset.get("cells"):
        subject_fn = _grass_cell if cat == "grass_sheet" else _tree_rock_cell
        return draw_atlas_sheet((w, h), asset["cells"], asset["file"], cell_padding_px, subject_fn)
    rng = random.Random(asset["file"])
    if role == "ground_overlay_neutral":
        return draw_ground_overlay_neutral(w, h, rng)
    if role == "ground_overlay_winter":
        return draw_ground_overlay_winter(w, h, rng)
    if role == "trail_surface":
        return draw_flat_seamless_tile(w, h, rng, ROCK_NEUTRAL)
    if role == "water_surface":
        return draw_water_tile(w, h, rng)
    if role == "water_bank":
        return draw_bank_tile(w, h, rng)
    if role == "water_highlight_strip":
        return draw_water_highlight(w, h, rng)
    if role.startswith("backdrop_"):
        return draw_mountain_backdrop(w, h, rng, wide=(role == "backdrop_centre"))
    if role.startswith("set_dressing_"):
        return draw_set_dressing(w, h, rng, role)
    raise ValueError(f"no drawing routine for role {role!r}")


def _apply_hashes(manifest_path: Path, file_hashes: dict) -> list:
    """Rewrite only the `"hash": "..."` value for each file in file_hashes,
    leaving every other byte of the manifest untouched (key order, 2-space
    indent, one-line cell entries, trailing newline all survive as-is)."""
    manifest_path = Path(manifest_path)
    text = manifest_path.read_text()
    changed = []
    for file_name, new_hash in file_hashes.items():
        file_pat = re.compile(r'"file"\s*:\s*"' + re.escape(file_name) + r'"')
        m = file_pat.search(text)
        if not m:
            raise ValueError(f"manifest has no entry for {file_name!r}")
        hash_pat = re.compile(r'("hash"\s*:\s*")([0-9a-f]*)(")')
        hm = hash_pat.search(text, m.end())
        if not hm:
            raise ValueError(f"could not find a hash field for {file_name!r}")
        old_hash = hm.group(2)
        if old_hash != new_hash:
            changed.append(file_name)
        text = text[:hm.start()] + hm.group(1) + new_hash + hm.group(3) + text[hm.end():]
    manifest_path.write_text(text)
    return changed


def generate(manifest_path: Path, out_dir: Path, only: str = None, quiet: bool = True):
    """Draw every manifest asset (or just `only`), WebP-encode it under its
    category cap, write it to out_dir, and rewrite the manifest hash for
    each file written. Returns the list of file names written."""
    manifest_path, out_dir = Path(manifest_path), Path(out_dir)
    manifest = load_manifest(manifest_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    pad = manifest["cell_padding_px"]
    targets = [a for a in manifest["assets"] if only is None or a["file"] == only]
    if only is not None and not targets:
        raise ValueError(f"no such asset in manifest: {only!r}")
    written, file_hashes, report = [], {}, []
    for asset in targets:
        img = draw_asset(asset, pad)
        cap = manifest["caps"][asset["category"]]["per_file"]
        data, quality, lossless = encode_webp(img, cap, asset["category"])
        out_path = out_dir / asset["file"]
        out_path.write_bytes(data)
        file_hashes[asset["file"]] = hashlib.sha256(data).hexdigest()[:HASH_LEN]
        written.append(asset["file"])
        report.append((asset["file"], len(data), cap, quality, lossless))
    changed = _apply_hashes(manifest_path, file_hashes)
    if not quiet:
        for file_name, size_bytes, cap, quality, lossless in report:
            mode = "lossless" if lossless else f"q{quality}"
            flag = "" if size_bytes <= cap else "  ** OVER CAP **"
            print(f"  {file_name:36s} {size_bytes:7d}B  cap {cap:7d}B  {mode}{flag}")
        print(f"generated {len(written)} file(s); manifest hash changed for: {', '.join(changed) or '(none)'}")
    return written


def rehash(manifest_path: Path, out_dir: Path, only: str = None, quiet: bool = True):
    """Recompute manifest hashes from whatever is already on disk, without
    drawing anything. Returns the list of file names whose hash changed."""
    manifest_path, out_dir = Path(manifest_path), Path(out_dir)
    manifest = load_manifest(manifest_path)
    targets = [a for a in manifest["assets"] if only is None or a["file"] == only]
    if only is not None and not targets:
        raise ValueError(f"no such asset in manifest: {only!r}")
    file_hashes, missing = {}, []
    for asset in targets:
        try:
            data = (out_dir / asset["file"]).read_bytes()
        except FileNotFoundError:
            missing.append(asset["file"])
            continue
        file_hashes[asset["file"]] = hashlib.sha256(data).hexdigest()[:HASH_LEN]
    changed = _apply_hashes(manifest_path, file_hashes)
    if not quiet:
        if missing:
            print("rehash: missing on disk, skipped: " + ", ".join(missing))
        print("rehash: hash changed for: " + (", ".join(changed) if changed else "(none)"))
    return changed


def check(manifest_path: Path, out_dir: Path, quiet: bool = False):
    """Verify every manifest file exists at the right size with the right
    hash, under every per-file and per-category byte cap, and under the
    manifest's total_cap. Returns (ok, problems)."""
    manifest_path, out_dir = Path(manifest_path), Path(out_dir)
    manifest = load_manifest(manifest_path)
    problems = []
    category_bytes: dict = {}
    category_files: dict = {}
    total_bytes = 0
    for asset in manifest["assets"]:
        file_name, cat = asset["file"], asset["category"]
        try:
            data = (out_dir / file_name).read_bytes()
        except FileNotFoundError:
            problems.append(f"MISSING {file_name} (category {cat})")
            continue
        size_bytes = len(data)
        try:
            with Image.open(io.BytesIO(data)) as im:
                actual_size = [im.width, im.height]
        except Exception as exc:  # noqa: BLE001 - report and keep checking
            problems.append(f"UNREADABLE {file_name}: {exc}")
            continue
        if actual_size != asset["size"]:
            problems.append(f"SIZE MISMATCH {file_name}: manifest says {asset['size']}, file is {actual_size}")
        expected_hash = asset.get("hash") or ""
        if not expected_hash:
            problems.append(f"HASH MISSING {file_name}: run the generator or --rehash")
        else:
            actual_hash = hashlib.sha256(data).hexdigest()[:len(expected_hash)]
            if actual_hash != expected_hash:
                problems.append(f"HASH MISMATCH {file_name}: manifest has {expected_hash}, file hashes to {actual_hash}")
        cap = manifest["caps"][cat]
        if size_bytes > cap["per_file"]:
            problems.append(f"OVER PER-FILE CAP {file_name} ({size_bytes}B > {cap['per_file']}B), category {cat}")
        category_bytes[cat] = category_bytes.get(cat, 0) + size_bytes
        category_files[cat] = category_files.get(cat, 0) + 1
        total_bytes += size_bytes
    for cat, cap in manifest["caps"].items():
        used = category_bytes.get(cat, 0)
        if used > cap["total"]:
            problems.append(f"OVER CATEGORY TOTAL {cat} ({used}B > {cap['total']}B)")
    if total_bytes > manifest["total_cap"]:
        problems.append(f"OVER TOTAL CAP ({total_bytes}B > {manifest['total_cap']}B)")

    ok = not problems
    if not quiet:
        if problems:
            for p in problems:
                print(p)
        else:
            print(f"{'category':<18}{'files':>7}{'bytes':>10}{'cap':>10}")
            for cat, cap in manifest["caps"].items():
                print(f"{cat:<18}{category_files.get(cat, 0):>7}{category_bytes.get(cat, 0):>10}{cap['total']:>10}")
            print(f"{'TOTAL':<18}{len(manifest['assets']):>7}{total_bytes:>10}{manifest['total_cap']:>10}")
    return ok, problems


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="verify files/hashes/caps against the manifest")
    parser.add_argument("--rehash", action="store_true", help="rewrite hashes from files on disk, don't redraw")
    parser.add_argument("--only", metavar="FILE", help="restrict generate/rehash to one manifest file")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="path to manifest.json")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="directory to write/read art")
    args = parser.parse_args(argv)

    manifest_path, out_dir = Path(args.manifest), Path(args.out_dir)

    if args.check:
        ok, _ = check(manifest_path, out_dir, quiet=False)
        return 0 if ok else 1

    if args.rehash:
        rehash(manifest_path, out_dir, only=args.only, quiet=False)
        return 0

    generate(manifest_path, out_dir, only=args.only, quiet=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

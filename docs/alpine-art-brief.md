# Alpine art brief

This is the brief for the illustrated Glacier-country look on the trail: an
ink-and-brush style covering the ground, the trees and rocks, the water and
the mountain backdrop behind everything. You don't need to read any code to
work from this document. Everything below is derived from
`static/images/alpine/manifest.json`, which is the single source of truth
for file names, pixel sizes and byte budgets — if this document and the
manifest ever disagree, the manifest wins, and whoever notices should fix
this file to match it.

Two references anchor the look:

- **Subject matter:** a photo of Hidden Lake in Glacier National Park — tall,
  narrow subalpine spruce dotting green slopes; striated grey cliffs holding
  snow in their gullies and shaded pockets; a glacial teal-blue lake; open
  alpine meadow in the foreground with scattered boulders; a blue sky with
  cumulus cloud.
- **Rendering style:** the ink-brush wash look of Matt Huynh's *The Boat*
  (sbs.com.au/theboat) — visible brush-grain linework over flat color
  washes, shapes simplified almost to comic-book silhouettes. Nothing
  photoreal, nothing airbrushed.

Right now every asset in the manifest is a script-generated placeholder
(`tools/gen_alpine_placeholders.py`) so the site can be built and tested
before real art exists. This brief is what a designer — Claude Design or a
person — replaces those placeholders from.

---

## 1. Style sheet

**The look:** brush-grain ink linework laid over flat color washes. Each
shape is a single flat color (or, where noted below, two flat tones split by
a hard edge) outlined in ink. The "brush grain" is visible stroke texture —
short, slightly irregular strokes and light stippling — not a smooth vector
fill and not a photographic texture. Think a printed illustration, not a
render.

**Spruce (the tallest, most-repeated shape on the trail):**
- Narrow spire silhouette — tall and slender, never a rounded or bushy
  outline.
- Drooping tiers: the branch layers sag slightly at their outer edge rather
  than reading as a stack of flat triangles.
- A few trees in every set should be bare snags here and there — a trunk
  with sparse or no foliage — so a grove doesn't read as identical trees
  repeated.
- Two heights per silhouette (see the asset list): a tall form and a
  noticeably shorter one, so groves read as varied in the distance the way
  R6 asks for.

**Cliffs and rock (backdrop, boulders):**
- Striations: rock faces are built from a few long, mostly-parallel bands of
  slightly different grey, following the rock's tilt — not cross-hatching,
  not a gradient.
- Snow patches sit in the gullies and shaded pockets between striation
  bands, as flat white-grey shapes with an ink edge, not a soft blend into
  the rock.
- Boulders are simple rounded or angular flat-color shapes with a single
  ink-line shadow edge, not modeled with multiple tones.

**Water:**
- Flat glacial teal fill. Any lighter tone (for shallows, ripples, the
  highlight strip) is a hard-edged flat shape laid over the teal, not a
  gradient.
- Banks and shallows are painted as part of the ground/water boundary — a
  visible transition shape — not a stroke or drop-shadow laid on top of a
  finished edge.

**Ground:**
- Brush-grain and ink texture only; the ground's actual color comes from
  the site's existing season gradient underneath (see Palettes below). Most
  ground overlay art should read as neutral grain and linework you could
  place over any of the three warm-season colors and have it look correct —
  winter is the one exception, and it is described on its own below.

**What is OUT:**
- Photoreal rendering of any kind — no photo-derived textures, no
  soft-shaded lighting, no depth-of-field blur.
- Gradients *inside* a single shape (a leaf, a rock face, a water tile). A
  shape is flat color, or a flat color split by a hard edge into two flat
  colors. The only smooth transition allowed anywhere is the site's
  existing season gradient behind the art, which this art sits on top of —
  never inside a painted shape itself.
- More than four colors per season (three to four, plus the ink line color
  — see Palettes).
- Anything that looks like a stock "pine tree clipart" silhouette — no
  perfectly symmetric Christmas-tree triangles.

---

## 2. Palettes

The base color for each season is already fixed by the site's code
(`SEASON_GROUND` in `static/js/journey.js`) — don't change these four hex
values, they're the anchor the rest of the palette is built around.

| Season | Ground base (fixed) | Companion tones | Use |
|---|---|---|---|
| Spring | `#A2B87F` | `#5E8256` (evergreen), `#D8D9C8` (pale lingering snow / cloud), `#8B8A7E` (rock grey) | New meadow green, spruce, a last patch of snow, rock |
| Summer | `#8CA668` | `#4F7348` (evergreen), `#7C7A6C` (scree/rock grey), `#C9A227` (small wildflower accent) | Deep meadow green, spruce, scree, a touch of gold on flower cells |
| Autumn | `#AC9A5C` | `#5E7A4C` (evergreen), `#A8722E` (turning-leaf rust), `#8F8B7A` (rock grey) | Gold meadow, spruce, broadleaf color, rock |
| Winter | `#D3D6CB` | `#A9B4B7` (shadow-on-snow), `#5B6E58` (bare branch/rock), `#87947A` (evergreen under snow) | Snowfield, shaded snow, bare wood/rock, muted evergreen |

That's the ground base plus three companions per season — four colors, the
plan's ceiling — and every one of them already exists in the site's code
(`SEASON_PINE` and the autumn/winter leaf tones in `static/js/journey.js`),
so spruce and ground will read as one family of color, not a new palette
bolted on.

Two more colors sit outside the season rotation because they don't change
with season:

- **Ink line color:** `#241F1A` — a near-black warm brown-black. Use it for
  every outline and every brush-stroke mark, in every season.
- **Glacial teal (water):** `#2E7A80` base, `#6FC7C2` for the shallow/
  highlight tone. Used for the water tile, the bank tile's wet edge, and the
  water highlight strip, in every season. Water does not re-season; it's
  glacial teal year-round the way it is in the reference photo.

**Why the ground overlays carry no color of their own:** the site already
paints each trail band with a season gradient (spring/summer/autumn/
winter) as a colored background. The ground overlay art you're producing
for `ground-overlay-a/b/c.webp` sits on top of that gradient as pure
ink-and-grain texture with a transparent (or near-transparent) body — no
season color baked into the art itself. That's what makes one overlay set
work for three different seasons instead of needing three separate painted
grounds. **Winter is the one exception:** `ground-overlay-winter.webp`
*does* carry its own color — actual white/pale snow-drift shapes and bits of
bare grass poking through — because a transparent grain overlay isn't
enough to read as snow. This is the only overlay file allowed to have paint
color in it; the other three are texture-only.

---

## 3. Asset list

Every file below is a required entry in `static/images/alpine/manifest.json`.
Names and pixel sizes are exact — deliver files with these same names at
these same sizes. "Seamless" means the art must tile edge-to-edge with no
visible seam when repeated (the left edge must match the right edge, and
for ground/water/bank tiles the top edge must match the bottom edge too).

### Ground overlays

| File | Size | Seamless | Palette | Echoes | Where it shows up |
|---|---|---|---|---|---|
| `ground-overlay-a.webp` | 1024×1024 | yes | season-neutral (ink + grain, no fill color) | The Boat's brush grain | Tiled over the spring/summer/autumn ground gradient |
| `ground-overlay-b.webp` | 1024×1024 | yes | season-neutral | The Boat's brush grain | Same use as -a; a different brush pass so neighboring bands don't look identical |
| `ground-overlay-c.webp` | 1024×1024 | yes | season-neutral | The Boat's brush grain | Same use as -a/-b; completes the three-way rotation that hides the tile repeat |
| `ground-overlay-winter.webp` | 1024×1024 | yes | winter (has real color — see Palettes) | Hidden Lake's snow patches | Replaces the a/b/c rotation on any winter-season stretch |

Draw all three neutral overlays as genuinely different brush passes (vary
stroke direction and stipple placement) — they get shown in rotation
specifically so the eye never catches a repeating tile at normal zoom.

### Trail, water and bank tiles

| File | Size | Seamless | Palette | Echoes | Where it shows up |
|---|---|---|---|---|---|
| `dirt-trail-tile.webp` | 512×512 | yes | rock-neutral | Worn ground between meadow and cliff in the reference photo | Tiled along the dirt trail path |
| `water-tile.webp` | 512×512 | yes | glacial teal | The lake's teal water | Tiled inside the creek and pond shapes |
| `bank-tile.webp` | 512×512 | yes | rock-neutral, wet edge in glacial teal | Where meadow meets the lake in the reference photo | Tiled along the shallow edge between water and ground |

### Tree-and-rock atlas

One sheet, `tree-rock-atlas.webp`, size **530×980**, not seamless (it's a
sprite sheet, not a tiling texture). It replaces the site's current
procedurally-drawn pine, broadleaf and boulder shapes. Every cell listed
below is a fixed rectangle inside that sheet — draw each cell's subject
centered in its rectangle with **at least 2 px of transparent padding on
every edge** (`cell_padding_px` in the manifest) so nothing bleeds into the
neighboring cell when the sheet is sampled at runtime. No cell's opaque
paint may touch its own edge.

| Cell | Position (x, y) | Size (w×h) | Subject | Palette |
|---|---|---|---|---|
| `spruce-tall-a` | 0, 0 | 110×230 | Tall spruce, silhouette A | evergreen-neutral |
| `spruce-tall-b` | 110, 0 | 110×230 | Tall spruce, silhouette B | evergreen-neutral |
| `spruce-tall-c` | 220, 0 | 110×230 | Tall spruce, silhouette C | evergreen-neutral |
| `spruce-tall-d` | 330, 0 | 110×230 | Tall spruce, silhouette D | evergreen-neutral |
| `spruce-short-a` | 0, 230 | 80×150 | Short spruce, silhouette A | evergreen-neutral |
| `spruce-short-b` | 80, 230 | 80×150 | Short spruce, silhouette B | evergreen-neutral |
| `spruce-short-c` | 160, 230 | 80×150 | Short spruce, silhouette C | evergreen-neutral |
| `spruce-short-d` | 240, 230 | 80×150 | Short spruce, silhouette D | evergreen-neutral |
| `spruce-snow-a` | 0, 380 | 100×210 | Snow-capped spruce, variant A | winter |
| `spruce-snow-b` | 100, 380 | 100×210 | Snow-capped spruce, variant B | winter |
| `spruce-snow-c` | 200, 380 | 100×210 | Snow-capped spruce, variant C | winter |
| `broadleaf-a` | 0, 590 | 150×190 | Broadleaf tree, variant A | evergreen-neutral, autumn rust allowed |
| `broadleaf-b` | 150, 590 | 150×190 | Broadleaf tree, variant B | evergreen-neutral, autumn rust allowed |
| `boulder-a` | 0, 780 | 120×90 | Boulder, small-round | rock-neutral |
| `boulder-b` | 120, 780 | 140×110 | Boulder, large-round | rock-neutral |
| `boulder-c` | 260, 780 | 110×85 | Boulder, angular | rock-neutral |
| `boulder-d` | 370, 780 | 160×120 | Boulder, large-angular | rock-neutral |
| `scree-patch` | 0, 900 | 200×80 | Loose scree/gravel cluster | rock-neutral |
| `fallen-log` | 200, 900 | 160×50 | Fallen log | rock-neutral |
| `flower-clump-a` | 360, 900 | 60×50 | Small wildflower clump, variant A | season base + small accent |
| `flower-clump-b` | 420, 900 | 60×50 | Small wildflower clump, variant B | season base + small accent |

Notes on this sheet:
- The four spruce silhouettes (A–D) each need a tall and a short version —
  that's the "at least four silhouettes, two heights" rule (R6). Make the
  short version read as a younger/smaller tree of the same silhouette
  family, not just a shrunk copy — vary the tier spacing a little.
- Give at least one or two of the eight regular spruce cells a bare snag
  (sparse or leafless upper trunk) instead of full foliage, per the style
  sheet's "a few bare snags" rule.
- The three `spruce-snow-*` cells are the winter substitutes for spruce —
  same spire-and-tiers language, but with flat white snow-load shapes
  sitting on the drooping tiers.
- Boulders vary in size and roundness-vs-angularity on purpose so a
  cluster of two or three doesn't read as one rock copy-pasted.
- `scree-patch`, `fallen-log`, and the two `flower-clump` cells are the
  repainted versions of the ground details the site draws today (loose
  rock speckle, logs, flowers) — draw them in this style rather than
  leaving anything in the old flat-vector look (R7).

### Grass clump sheet

One sheet, `grass-clumps.webp`, size **256×64**, not seamless (a sprite
sheet). Four cells, each 64×64 with the same 2 px padding rule as the
tree-and-rock atlas:

| Cell | Position (x, y) | Size |
|---|---|---|
| `grass-clump-a` | 0, 0 | 64×64 |
| `grass-clump-b` | 64, 0 | 64×64 |
| `grass-clump-c` | 128, 0 | 64×64 |
| `grass-clump-d` | 192, 0 | 64×64 |

A few short, loose grass blades gathered into a small clump, season-neutral
so it can sit on any ground gradient. These are the clumps that sway gently
near the trail on desktop (R16) — draw a clear base point at the bottom
center of the cell, since that's what the sway animation pivots around.

### Water highlight strip

`water-highlight.webp`, size **512×64**, seamless (must tile left-to-right,
since it's moved with a transform to suggest flow). A flat glacial-teal
highlight/ripple pattern in the lighter teal tone (`#6FC7C2`), hard-edged
shapes over transparency — no glow, no gradient.

### Backdrop (painted mountain background)

Three files that together replace the site's current ridge image. They sit
behind the world, so nothing in them ever needs to avoid the trail, camps
or photos — just paint the mountains.

| File | Size | Subject |
|---|---|---|
| `backdrop-left-flank.webp` | 960×1400 | Left valley wall — striated cliff face, snow patches in the gullies, a peak or ridge line near the top |
| `backdrop-right-flank.webp` | 960×1400 | Right valley wall, mirroring the left flank's language (need not be a literal mirror image) |
| `backdrop-centre-range.webp` | 2400×900 | The centre range behind the trail — wider and shorter than the flanks, reading as the far side of the valley the way the reference photo's central cliff-and-peak wall does |

These three are the single biggest style anchor for the "Glacier-country"
read (Goal Capsule), so lean hard on the reference photo here: long
grey-and-tan striation bands, snow sitting in shaded pockets and gullies
rather than as an even cap, and at least one clear peak silhouette against
the sky per file. Backdrop art does not re-paint per season (it's tinted
day/dusk/night the same way the rest of the world is) — paint it in the
season-neutral rock/cliff tones from the Palettes section, not a specific
season's ground color.

### Set dressing (push-in spots)

Five separate files, one per push-in spot chosen for extra richness (R21).
None of these change how the camera behaves (R22) — they're just more
painted detail sitting at that spot on the ground.

| File | Size | Spot |
|---|---|---|
| `set-dress-trailhead-home.webp` | 320×260 | Trailhead home |
| `set-dress-creek-bridge.webp` | 320×220 | Creek bridge |
| `set-dress-spruce-grove-dense.webp` | 300×260 | The one dense spruce grove |
| `set-dress-belles-lantern.webp` | 220×260 | Belle's lantern |
| `set-dress-trail-end.webp` | 340×260 | Trail's end |

Paint these as small richer vignettes in the same style and palette family
as the rest of the ground and atlas art — extra flowers, a denser huddle of
spruce, a bit more scree, whatever makes that specific spot feel like the
most cared-for stretch of the trail without introducing a new subject or a
new color outside the season's palette.

---

## 4. How to deliver

You don't need code access to do this — just an image editor that exports
WebP (or a converter, if you paint in another format first).

1. **Keep the file names identical.** Every name above and in
   `static/images/alpine/manifest.json` is exact — same spelling, same
   `.webp` extension, replacing the placeholder file of the same name in
   `static/images/alpine/`.
2. **Keep the pixel sizes identical.** Match the "Size" column above (and
   the manifest) exactly, including atlas sheets — the cell positions in
   this brief and in the manifest assume the sheet is exactly that size.
3. **Export as WebP.**
   - Use lossy WebP with an alpha channel for everything except the dirt
     trail, water and bank tiles.
   - The dirt trail, water and bank tiles may use lossless WebP instead if
     lossy compression shows visible color banding in their flat washes —
     they're small files so the byte cost of lossless is affordable there.
4. **Stay under the byte cap for your file's category.** Caps are listed in
   `static/images/alpine/manifest.json` under `caps` (in bytes; 1 KB =
   1024 bytes here):

   | Category | Per-file cap | Category total |
   |---|---|---|
   | Ground overlays | 120 KB | 450 KB |
   | Dirt trail tile | 40 KB | 40 KB |
   | Water tile | 40 KB | 40 KB |
   | Bank tile | 40 KB | 40 KB |
   | Tree-and-rock atlas | 350 KB | 350 KB |
   | Grass clump sheet | 60 KB | 60 KB |
   | Water highlight strip | 20 KB | 20 KB |
   | Backdrop (each of the 3 files) | 120 KB | 368 KB combined |
   | Set dressing (each of the 5 files) | 30 KB | 150 KB combined |

   All categories together must stay under 1.5 MB. If your four ground
   overlays each land near the 120 KB per-file cap, their combined total
   will run over the 450 KB category cap — if that happens, bring one or
   two of them down rather than all four up to the edge.
5. **Drop the finished files into `static/images/alpine/`,** overwriting
   the placeholder of the same name.
6. **Run the rehash step:** `python3 tools/gen_alpine_placeholders.py --rehash`.
   This rewrites the manifest's content hash for any file whose bytes
   changed, without touching the art itself. It's the one command that
   needs to run after art lands — nothing else in the code needs to change
   for the new art to show up on the site's next load.
7. If you want to double-check your work before rehashing, running
   `python3 tools/gen_alpine_placeholders.py --check` reports any file
   that's missing, the wrong pixel size, or over its byte cap, and names
   the offending file.

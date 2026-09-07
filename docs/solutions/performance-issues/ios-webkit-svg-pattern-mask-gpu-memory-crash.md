---
title: iOS WebKit crash-reload from SVG pattern fills, masks and opacity inside ground bands
date: 2026-09-06
category: performance-issues
module: journey ground bands
problem_type: performance_issue
component: frontend
symptoms:
  - "iPhone Safari and Chrome (both WebKit) crash-reload the tab within seconds of opening the staging site, before any scrolling"
  - "Desktop browsers and the Chromium Playwright smoke show nothing wrong"
  - "Playwright WebKit GPU-process memory peaks at 2.5 GB for the painted build versus 116 MB for the pre-art build at iPhone 13 scale"
  - "The ?ground=flat rollback costs the same as the painted build"
root_cause: gpu_memory_budget
resolution_type: code_fix
severity: critical
framework_version: "webkit 26.6 (playwright); ios safari"
related_components:
  - testing_framework
tags: [ios, webkit, gpu-memory, svg-pattern, svg-mask, crash-reload, journey, band-svg]
---

# iOS WebKit crash-reload from SVG pattern fills, masks and opacity inside ground bands

## Problem

The trail (`static/js/journey.js`) is a scroll-driven 3D pet "trail" rendered as a series of `<svg>` ground bands inside a 3D-transformed `#map`. The ground is deliberately sliced into per-band SVGs — `W = 2200` (`static/js/journey.js:30`), `BANDH = 1600` and `BAND0 = -500` (`static/js/journey.js:162`), each band viewBox is `W + 2200 = 4400` px wide by `BANDH + over` tall (`static/js/journey.js:202`) — so that no single giant raster ground surface exists; every 3D-transformed element is its own GPU surface on iOS, which is the binding memory constraint on the phone (this slicing predates the session and is the reason bands exist at all, not something this session changed). The July 2026 lessons that produced the bands were: every 3D-transformed element is its own GPU surface, WebKit gives 3D-transformed content full untiled backing stores at 3x DPR so a single giant ground SVG is an out-of-memory crash, and the levers left for the phone were smaller bands, a lower zoom floor and fewer particles (auto memory [claude]). None of those lessons covered what happens *inside* a band, which is where this bug lived.

Unit U4 of the illustrated-alpine-ground plan (merged to staging in PR #2 as "feat(journey): painted ground overlays, dirt trail and atlas details with lookahead attach (U4)") added painted art inside those band SVGs: a brush-grain ink overlay over the season gradient, a dirt-tile texture on the trail stroke, a winter snow overlay, and atlas detail sprites, all attached one band ahead of the visible/cull window and detached on exit. This shipped to staging as part of the U1-U4 merge (PR #2).

## Symptoms

On Robert's iPhone, both Safari and Chrome (both WebKit on iOS) crash-reloaded the tab within seconds of opening the staging site — before any scrolling happened. Desktop browsers were unaffected. The existing Chromium-based Playwright smoke (`tests/smoke/journey-smoke.mjs`, which measures `update()` wall-clock time, alive band/surface counts, and long tasks read from a `PerformanceObserver` — see its header at `tests/smoke/journey-smoke.mjs:1-40`) passed every check, because it drives Chromium, and Chromium's process model does not reproduce Apple's separate GPU-memory accounting.

## What Didn't Work

1. **Suspected the SVG `<mask>` used for the winter snow fade.** The original U4 code (PR #2) built a band-sized `<mask>` per winter stretch and a masked `<rect>` filled via `url(#snow{bi})` to fade the snow overlay in/out with the season gradient. The first follow-up fix (commit `95f1800`, "drop the SVG mask on winter snow and add phone-budget URL levers") replaced the mask with a handful of `fill-opacity` strips and switched the new trail-related strokes from element `opacity` to `stroke-opacity` (e.g. `fallbackPath.setAttribute('stroke-opacity', '0.12')` vs. the old `opacity` at that call site — see the surviving comment at `static/js/journey.js:490-492` explaining why `stroke-opacity` is required). The tab still crashed.
2. **Suspected pattern tile size and the one-band lookahead.** URL levers were added to isolate variables without a rebuild: `?tile=` (dirt/ink/snow pattern tile size), `?look=` (lookahead band count), `?snow=off` (skip snow entirely) — see `GROUND_SNOW` at `static/js/journey.js:126` and `TILE` at `static/js/journey.js:131`, with the lever comment block just above them.
3. **Measured web-content process RSS on desktop WebKit** across variants and found almost no difference between them — the cost wasn't showing up in the process being measured. This is explicit in the probe's own header comment: "pattern tiles, masks and layer backing stores live in the separate GPU process, not in the web-content process" (`tests/smoke/webkit-gpu-memory.mjs:5-9`).

A further wrong assumption surfaced along the way: `?ground=flat` was believed to be a safe rollback, but the original flat-mode gate only skipped the trail-stroke rendering path, not the per-band `<pattern>` and snow-strip construction — so the "rollback" still built and cost the same GPU memory as the painted build (2348 MB measured). This is fixed at `static/js/journey.js:238` (`if (!GROUND_FLAT){ ... }` now wraps all overlay/pattern/snow construction) and `static/js/journey.js:327` (paint-state listeners also gated on `!GROUND_FLAT`); the second fix commit (`3168af5`) records "flat mode still built them" as the bug being fixed.

## Solution

The real measurement tool was a WebKit-specific probe, not the existing Chromium smoke: `tests/smoke/webkit-gpu-memory.mjs`. It launches Playwright WebKit (which "shares Safari's SVG rendering code") with the `iPhone 13` device descriptor (3x DPR), loads each URL variant, flings the trail through several scroll positions, and samples the peak RSS of every spawned WebKit process, splitting it into `gpu` / `web` / `other` by matching process command lines (`tests/smoke/webkit-gpu-memory.mjs:22-30`, header comment at lines 1-18).

**Root cause:** on WebKit, every SVG element filled or stroked with a `<pattern>` owns its own GPU tile buffer, sized `tile × device-scale (3x)`, allocated per client element per band — even before the pattern's `<image>` has an `href`. The original build put a `<pattern>` on the ink overlay rect, the dirt-trail stroke, and up to nine snow strips per winter band, multiplying the cost. `<mask>` and element `opacity` on band-sized shapes also allocate their own offscreen buffers.

Before (PR #2, ink overlay as a pattern-filled rect covering the whole band):
```js
const inkPattern = document.createElementNS(NS, 'pattern');
inkPattern.id = 'ink' + bi;
inkPattern.setAttribute('patternUnits', 'userSpaceOnUse');
inkPattern.setAttribute('width', '1024'); inkPattern.setAttribute('height', '1024');
const overlayImg = document.createElementNS(NS, 'image');
overlayImg.setAttribute('width', '1024'); overlayImg.setAttribute('height', '1024');
inkPattern.appendChild(overlayImg);
bdefs.appendChild(inkPattern);
...
const inkRect = document.createElementNS(NS, 'rect');
inkRect.setAttribute('width', W + 2200); inkRect.setAttribute('height', BANDH + over);
inkRect.setAttribute('fill', `url(#ink${bi})`);   // one pattern-filled rect per band
bsvg.appendChild(inkRect);
```
(and the winter snow used a same-shaped `<pattern>`-filled rect wrapped in a band-sized `<mask>`.)

After (current tree, `static/js/journey.js:245-259`, plain `<image>` tiles drawn straight from the decoded bitmap, no per-element buffer):
```js
const tileImages = (parent, yTop, yBot) => {
  const imgs = [];
  const x0 = Math.floor(-1100 / ART_TILE) * ART_TILE, x1 = W + 1100;
  const ya = Math.floor(yTop / ART_TILE) * ART_TILE;
  for (let ty = ya; ty < yBot; ty += ART_TILE){
    for (let tx = x0; tx < x1; tx += ART_TILE){
      const im = document.createElementNS(NS, 'image');
      im.setAttribute('x', tx); im.setAttribute('y', ty);
      im.setAttribute('width', ART_TILE); im.setAttribute('height', ART_TILE);
      parent.appendChild(im); imgs.push(im);
    }
  }
  return imgs;
};
if (GROUND_INK) inkImgs = tileImages(bsvg, y0 - over, y0 + BANDH + over);
```
Snow tiles use the same `tileImages()` call, but the elements sit in a `<g clip-path="url(#snowclip...)">` where the clip rect is a plain scissor, not a buffer (`static/js/journey.js:281-289`); the season-color fade at each winter stretch's edges is a `<rect>` filled by a `linearGradient` of the neighbouring season's flat ground color — a shading, not a buffer (`static/js/journey.js:291-317`). The dirt trail keeps the one remaining `<pattern>` because a stroke needs a paint server, now at a 256 px tile by default (`TILE` at `static/js/journey.js:131`, applied at `static/js/journey.js:265`). All of the above is skipped entirely in `GROUND_FLAT` mode (`static/js/journey.js:238`), so `?ground=flat` now builds none of the painted elements — a real rollback. Element `opacity` on painted-mode strokes was replaced with `stroke-opacity` (`static/js/journey.js:460`, `static/js/journey.js:468`, `static/js/journey.js:492`).

**Measurement table** (peak GPU-process MB from `webkit-gpu-memory.mjs`, iPhone 13 @ 3x DPR):

| Variant | Peak GPU MB |
|---|---|
| pre-art flat build | 116 |
| first painted build (patterns + fill-opacity strips, after commit `95f1800`) | 2456 |
| `?snow=off` | 498 |
| `?tile=256` | 362 |
| `?ground=flat` "rollback" that still built patterns/snow (bug) | 2348 |
| after restructure, base | 332 |
| — breakdown: ink overlay | +76 |
| — breakdown: dirt trail | +62 |
| — breakdown: snow | +51 |
| — breakdown: atlas sprites | +4 |
| final build, base | 170 |
| final build, `?look=0` | 172 |
| final build, `?tile=512` | 225 |
| final build, `?snow=off` | 164 |

(Breakdown figures are from the session's measurement pass with `?ink=off`, `?dirt=off`, `?sprites=off` and `?snow=off`; the `3168af5` commit message records the ink, dirt and snow deltas, and the sprite delta was reproduced by the grounding check for this doc. The rows above the restructure were measured once during the session on the intermediate build and have not been reproduced since.) On-device confirmation of the final build on Robert's iPhone is pending as of this writing — the WebKit-probe numbers are the best available signal, but they have not yet been checked against the real phone.

Both fix commits (`95f1800` — drops the mask, adds URL levers; `3168af5` — tiles the overlays as plain images, adds the probe, makes `?ground=flat` a true rollback) sit on the `feat/illustrated-alpine-ground` branch and were merged to `staging` on 2026-09-06 through the deploy-staging flow, without a pull request. As of this writing neither is on `main`, so these SHAs are branch-local and may change if the branch is ever squashed; the PR that eventually promotes staging to production is the durable reference.

## Why This Works

WebKit's SVG renderer backs every `<pattern>`-referencing paint server with a dedicated tile buffer per element that references it, sized to the pattern tile times the device pixel ratio, and allocates it as soon as the element exists — regardless of whether the pattern's `<image>` child has a loaded `href` (`static/js/journey.js:229-237` documents this as the rule learned on 2026-09-06). A `<mask>` or element `opacity` on a large shape gets the same offscreen-buffer treatment sized to the masked/composited rect. None of this shows up in the WebKit *web-content* process's memory, which is what the Chromium smoke's model (and even a same-engine desktop-RSS check) would lead you to expect to measure — it is charged to the separate GPU process that only exists on Apple's WebKit stack. Replacing per-band pattern fills with plain `<image>` tiles removes the per-element buffer entirely: every tile draws from the one already-decoded bitmap. Replacing the mask with a clip-path scissor plus gradient-rect shading removes the offscreen composite buffer the same way — a `clipPath` is a geometric cut, not a rendered layer, and a `linearGradient` fill is evaluated per-pixel like any other paint, not composited from a side buffer. The dirt trail is the one place a `<pattern>` remains, because an SVG stroke can only be painted by a paint server (solid color or one of the server types), not by transform-positioned tiles the way a fill area can — so its cost is contained to one small (256 px) buffer per band rather than removed.

The neighbour-color sampling for the snow-fade gradients is deliberately drawn from the same 420 px season sample grid used to build the season gradient stops (`static/js/journey.js:313-317`); sampling even 1 px outside that grid landed on a winter sample and produced a hard color edge instead of a fade, which is why the code takes `r.a - SEASON_FADE - 420` and `r.b` — points already on the grid — rather than arbitrary offsets.

## Prevention

- **Run the WebKit GPU probe before every staging round that touches band content.** Per the README's Development section: "`tests/smoke/webkit-gpu-memory.mjs` measures the GPU-process memory of Playwright's WebKit (Safari's engine) for URL variants at iPhone size, the best desktop proxy for the phone's crash ceiling. Run it against a running fixture server; compare every variant with `?ground=flat`." (README.md:104-107). Command, from the probe's own header (`tests/smoke/webkit-gpu-memory.mjs:14-17`):
  ```
  JOURNEY_FIXTURE=tests/fixtures/journey-sample.json python app.py &
  cd tests/smoke && node webkit-gpu-memory.mjs ground=flat base tile=512 snow=off
  ```
  (requires `npx playwright install webkit` once). Always include `ground=flat` in the variant list as the baseline every other variant is judged against.

- **Band-content checklist for anything drawn inside a per-band `<svg>` (`static/js/journey.js`'s band-build loop, roughly lines 198-350):**
  - No `<pattern>` fill on a large (band-sized) shape — only on a stroke that has no other option (the dirt trail is the sanctioned exception, kept at a small 256 px tile: `static/js/journey.js:265`).
  - No `<mask>` on a band-sized shape — use a `clipPath` with a plain rect (a scissor, no buffer: `static/js/journey.js:281-289`) instead.
  - No `filter` anywhere under `.zoom`/`.tilt`/`.map` or any 3D-transformed ancestor — this predates U4 and is called out at `static/css/journey.css:24-25` ("never put `filter` on `.zoom`/`.tilt`/`.map` or any 3D ancestor — filters force `transform-style:flat`..."); it's also a GPU-buffer source and doubles as a layout hazard.
  - No element `opacity` on a band-sized or stroke shape — use `stroke-opacity`/`fill-opacity` instead (`static/js/journey.js:460` and the comment at `static/js/journey.js:490`).
  - Prefer plain `<image>` tiles positioned at multiples of a fixed world-px grid over a pattern fill; anchor tile phase to world coordinates (not per-band-local coordinates) so it stays continuous across the ~2 px band overlap (`static/js/journey.js:239-241`).
  - Fades/vignettes at shape edges: use a `<rect>` filled by a `linearGradient`, not a masked or filtered composite.
  - Keep the flat rollback (`?ground=flat` / empty manifest, `GROUND_FLAT` at `static/js/journey.js:119`) truly flat: gate *all* painted-element construction behind `if (!GROUND_FLAT)` (`static/js/journey.js:238` and `static/js/journey.js:327`), not just the final stroke/paint step — a rollback that still constructs the expensive DOM defeats the point of having one.
- **The Chromium-based smoke (`tests/smoke/journey-smoke.mjs`) is not a proxy for this class of bug.** It measures `update()` frame time, alive band/surface counts, and long tasks in Chromium's process model (`tests/smoke/journey-smoke.mjs:6-23`), and passed throughout this incident. Apple's WebKit GPU-process memory accounting has no Chromium analogue that this smoke — or a same-engine desktop RSS check — can see; only `tests/smoke/webkit-gpu-memory.mjs` measures it.

## Related Issues

- `docs/plans/2026-09-06-1314-feat-illustrated-alpine-ground-plan.md` — the plan whose KTD3 and band sketch still describe the overlays as SVG pattern fills, and whose U4 execution note calls overlay tile size "the last lever"; both are superseded by this fix (see Prevention).
- `static/css/journey.css` — the earlier rule that no CSS `filter` may sit on `.zoom`, `.tilt` or `.map`, the first member of this family of GPU rules.
- `tests/smoke/webkit-gpu-memory.mjs` — the probe; `tests/smoke/journey-smoke.mjs` — the Chromium smoke that cannot see this class of bug.
- `README.md` Development section — how to run both.
- No GitHub issue was filed; the incident was found on the staging phone check that the plan required before U5.

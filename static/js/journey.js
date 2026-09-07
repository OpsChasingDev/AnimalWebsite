/* The Stapleton Pack — alpine journey engine.
   World: a 45°-tilted map the camera flies over, following the trail.
   Data arrives via window.JOURNEY (see app.py build_model). */
(() => {
  const J = window.JOURNEY;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const SEASON_GROUND = {spring:'#A2B87F', summer:'#8CA668', autumn:'#AC9A5C', winter:'#D3D6CB'};
  const SEASON_OF = m => { const mm = ((m % 12) + 12) % 12 + 1;
    return (mm === 12 || mm <= 2) ? 'winter' : (mm <= 5) ? 'spring' : (mm <= 8) ? 'summer' : 'autumn'; };
  const ymKey = s => { if (!s) return null; const y = +s.slice(0,4), m = +s.slice(5,7);
    return (y && m) ? y*12 + m - 1 : null; };
  const monthLabel = mk => MONTHS[mk % 12] + ' ' + Math.floor(mk / 12);
  const yearOf = s => s ? s.slice(0, 4) : '';
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const petBy = {}; J.pets.forEach(p => petBy[p.slug] = p);

  function ageStr(bornYM, atMk){
    const b = ymKey(bornYM); if (b == null || atMk == null) return '';
    const d = atMk - b; if (d < 0) return '';
    if (d < 12) return d + (d === 1 ? ' month old' : ' months old');
    const y = Math.floor(d / 12); return y + (y === 1 ? ' year old' : ' years old');
  }

  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  /* ---------- layout ---------- */
  const W = 2200, CX = W / 2, AMP = 470;
  const evs = J.events;
  const pts = [];
  const gaps = [];
  for (let i = 1; i < evs.length; i++){
    const dm = Math.max(0, evs[i].month - evs[i-1].month);
    let g = clamp(dm * 26, 260, 820);
    if (evs[i].type === 'camp') g += 140;
    if (evs[i].type === 'passing' || evs[i].type === 'arrival') g += 90;
    gaps.push(g);
  }
  const PAD_TOP = 900, PAD_BOT = 1000;
  const LEN = PAD_TOP + gaps.reduce((a, b) => a + b, 0) + PAD_BOT;
  let layoutY = LEN - PAD_BOT;
  let side = rnd() > 0.5 ? 1 : -1;
  let prevX = CX;
  evs.forEach((e, i) => {
    if (i > 0) layoutY -= gaps[i-1];
    let x = CX;
    if (e.type !== 'union' && e.type !== 'today'){
      if (rnd() < 0.62) side = -side;           // sometimes linger on a side
      const amp = AMP * (0.25 + 0.75 * rnd());  // shallow drifts to wide bends
      x = CX + side * amp;
      if (Math.abs(x - prevX) < 150) x = clamp(x + side * 200, CX - AMP, CX + AMP);
    }
    pts.push({x, y: layoutY, e});
    prevX = x;
  });

  const anchors = pts.map(p => ({m: p.e.month, y: p.y}));
  function monthAtY(yy){
    if (yy >= anchors[0].y) return anchors[0].m;
    for (let i = 1; i < anchors.length; i++){
      if (yy >= anchors[i].y){
        const a = anchors[i-1], b = anchors[i];
        return a.m + (b.m - a.m) * ((a.y - yy) / Math.max(1, a.y - b.y));
      }
    }
    return anchors[anchors.length - 1].m;
  }
  function yOfMonth(m){
    if (m <= anchors[0].m) return anchors[0].y;
    for (let i = 1; i < anchors.length; i++){
      if (m <= anchors[i].m){
        const a = anchors[i-1], b = anchors[i];
        return a.y - (a.y - b.y) * ((m - a.m) / Math.max(1, b.m - a.m));
      }
    }
    return anchors[anchors.length - 1].y;
  }
  const spanPx = mk => Math.abs(yOfMonth(mk) - yOfMonth(mk + 1));

  /* ---------- map + ground ---------- */
  const map = document.getElementById('map');
  const NS = 'http://www.w3.org/2000/svg';

  /* camera elevation: 90 = straight down, lower = more grazing.
     Default 60; tune live with ?view=NN (no deploy needed). */
  const params = new URLSearchParams(location.search);
  const VIEW = clamp(parseFloat(params.get('view')) || 60, 25, 78);
  const TILT = 90 - VIEW;
  document.documentElement.style.setProperty('--tilt', TILT.toFixed(1) + 'deg');
  const COS_T = Math.cos(TILT * Math.PI / 180);
  const GI_F = COS_T * 0.89;          // map-y delta -> in-plane offset for grove trees
  const SH_R = clamp(0.32 * (COS_T / 0.6157), 0.2, 0.6);  // ground-shadow squash

  /* Lite tier for touch devices: iOS Safari has hard per-tab GPU limits and
     rasterizes 3D-transformed content into full (untiled) backing stores. */
  const LITE = matchMedia('(pointer: coarse)').matches
    || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (LITE) document.body.classList.add('lite');

  /* ALPINE is the manifest app.py reads at import (or an empty one
     on a missing/corrupt file). Index it by file name so the rest of this
     script can look up a hash or an atlas cell without re-parsing anything.
     assetUrl() appends the manifest's content hash as a cache-busting query
     string, so a real-art drop-in with a rehashed manifest changes what
     ships with no code change (the rehash step). This is a second URL
     builder on purpose: /img (built in app.py) proxies blob photos through
     auth and thumbnailing; assetUrl() serves art shipped with the app. */
  const ART = {};
  ((window.ALPINE && window.ALPINE.assets) || []).forEach(a => { ART[a.file] = a; });
  function assetUrl(name){
    const a = ART[name];
    return a ? `/static/images/alpine/${name}?v=${a.hash}` : null;
  }
  // An empty manifest (missing/corrupt file) or ?ground=flat both mean "no
  // painted overlays": the flat season gradient carries the ground instead,
  // which is always present so the page never renders blank.
  const GROUND_FLAT = params.get('ground') === 'flat' || !ART['ground-overlay-a.webp'];
  // Phone-budget levers, settable from the URL so a staging round on the
  // iPhone can isolate what blows the memory ceiling without a rebuild:
  //   ?snow=off   skip the winter snow rects entirely
  //   ?look=0     attach art only to visible bands (default: one band ahead)
  //   ?tile=512   dirt pattern tile size in world px (default 256; the one
  //               remaining <pattern>, since a stroke needs a paint server)
  const GROUND_SNOW = params.get('snow') !== 'off';
  const GROUND_INK = params.get('ink') !== 'off';        // ?ink=off   no brush-grain overlay rect
  const GROUND_DIRT = params.get('dirt') !== 'off';      // ?dirt=off  plain trail stroke, no dirt pattern
  const GROUND_SPRITES = params.get('sprites') !== 'off'; // ?sprites=off no atlas detail sprites
  const GROUND_WATER = params.get('water') !== 'off';     // ?water=off plain teal strokes, no water/bank tiles (U6)
  const GROUND_MOTION = params.get('motion') !== 'off';   // ?motion=off no grass sway / creek flow elements (U8)
  const LOOKAHEAD_BANDS = params.has('look') ? Math.max(0, Number(params.get('look')) || 0) : 1;
  const TILE = [256, 512, 1024].includes(Number(params.get('tile'))) ? Number(params.get('tile')) : 256;
  const ART_TILE = 1024;  // world px per overlay image; the art is 1024 px square
  const INK_COLOR = '#241F1A';  // docs/alpine-art-brief.md section 2
  const ATLAS = ART['tree-rock-atlas.webp'];
  const ATLAS_CELLS = {};
  ((ATLAS && ATLAS.cells) || []).forEach(c => { ATLAS_CELLS[c.name] = c; });
  const ATLAS_SIZE = ATLAS ? ATLAS.size : [530, 980];
  const DIRT_URL = assetUrl('dirt-trail-tile.webp');
  const WATER_URL = assetUrl('water-tile.webp'), BANK_URL = assetUrl('bank-tile.webp');
  // U6: the creek and pond are painted only when both tiles exist; flat mode
  // and ?water=off keep the plain strokes. The tiles are stroke paint
  // servers, so like the dirt trail they are the sanctioned small-tile
  // <pattern> exception (256 px): two patterns per band that carries water,
  // three bands on the fixture (the pond straddles a seam). Measured on the
  // WebKit probe at iPhone 13 scale: about 30 MB of GPU memory, painted 202
  // vs 171 MB with ?water=off, against a 116 MB flat build.
  const PAINT_WATER = !GROUND_FLAT && GROUND_WATER && !!WATER_URL && !!BANK_URL;
  const WATER_TILE = 256;
  const SNOW_URL = assetUrl('ground-overlay-winter.webp');
  const ATLAS_URL = assetUrl('tree-rock-atlas.webp');
  // Atlas load state, tracked once globally (one shared asset decoded once
  // for every band, not per-band) via a representative probe Image rather
  // than every detail <image> tag; folded into missingOverlays below the
  // same way overlayState/dirtState are. Defaults to 'painted' (no known
  // failure) in flat mode or when the manifest carries no atlas, so neither
  // ever falsely flags.
  let atlasState = (GROUND_FLAT || !ATLAS_URL) ? 'painted' : 'loading';
  // Nested-svg crop idiom (also used by prop() for set dressing): an <image> can't crop to an
  // atlas cell on its own, so each sprite is a small svg viewport whose
  // viewBox is the cell's rect in atlas pixels, with one full-atlas <image>
  // inside it — the atlas is one URL, decoded once, no matter how many
  // cells reference it. href is attached/detached by the caller.
  function atlasCellMarkup(name, ax, ay){
    const c = ATLAS_CELLS[name];
    if (!c || !GROUND_SPRITES) return '';
    return `<svg x="${ax - c.w/2}" y="${ay - c.h/2}" width="${c.w}" height="${c.h}" ` +
      `viewBox="${c.x} ${c.y} ${c.w} ${c.h}"><image class="atlas" width="${ATLAS_SIZE[0]}" height="${ATLAS_SIZE[1]}"/></svg>`;
  }
  // U5: grove and prop sprites. Same nested-svg crop idiom, but sized to a
  // display box (w x h css px) and carrying the atlas href from the start:
  // groves are HTML props inside the 3D map, not band SVGs, so there is no
  // lookahead attach to wait for, and the atlas is the one bitmap the band
  // details already decode. Painted mode only; flat mode (or a manifest
  // without the atlas) keeps the procedural pine/broadleaf/boulder SVGs as
  // the faithful rollback, the same way the ground does.
  // Every cell the grove and prop builders address; the gate checks the
  // whole set so a partial or renamed manifest falls back to the vector
  // trees instead of throwing inside the synchronous world build.
  const GROVE_CELLS = ['spruce-tall-a', 'spruce-tall-b', 'spruce-tall-c', 'spruce-tall-d',
    'spruce-short-a', 'spruce-short-b', 'spruce-short-c', 'spruce-short-d',
    'spruce-snow-a', 'spruce-snow-b', 'spruce-snow-c', 'broadleaf-a', 'broadleaf-b',
    'boulder-a', 'boulder-b', 'boulder-c', 'boulder-d'];
  const GROVE_SPRITES = !GROUND_FLAT && GROUND_SPRITES && !!ATLAS_URL && GROVE_CELLS.every(n => ATLAS_CELLS[n]);
  function spriteMarkup(name, w, h){
    const c = ATLAS_CELLS[name];
    return `<svg class="sp-img" width="${w.toFixed(0)}" height="${h.toFixed(0)}" ` +
      `viewBox="${c.x} ${c.y} ${c.w} ${c.h}"><image width="${ATLAS_SIZE[0]}" height="${ATLAS_SIZE[1]}" href="${ATLAS_URL}"/></svg>`;
  }
  // Display height h, cell aspect preserved. Every cell is at most 230 px
  // tall and callers never pass h above that, so no .gi exceeds the plan's
  // sprite ceiling (KTD3).
  function spriteBox(name, h){
    const c = ATLAS_CELLS[name];
    return {w: c.w * h / c.h, h};
  }
  // A prop-side sprite: the same sized .sp box a grove item gets, so the
  // #map.atlas-failed silhouette rules cover props too and the box keeps
  // its size when the sprite image is hidden.
  function spriteBoxMarkup(name, h, kind, inner = ''){
    const box = spriteBox(name, h);
    return `<div class="sp ${kind}" style="position:relative; width:${box.w.toFixed(0)}px; height:${box.h.toFixed(0)}px;">` +
      spriteMarkup(name, box.w, box.h) + inner + `</div>`;
  }

  /* The ground is sliced into band SVGs, culled independently, so no single
     giant raster surface ever exists (the previous one crashed iOS Safari). */
  const BANDH = 1600, BAND0 = -500;
  const NB = Math.ceil((LEN + 1000) / BANDH);

  let prevColor = null;
  const stops = [];
  for (let yy = 0; yy <= LEN; yy += 420){
    const c = SEASON_GROUND[SEASON_OF(Math.round(monthAtY(yy)))];
    if (c !== prevColor){
      if (prevColor) stops.push({off: Math.max(0, yy/LEN - 0.02), color: prevColor});
      stops.push({off: yy/LEN, color: c});
      prevColor = c;
    }
  }
  stops.push({off: 1, color: prevColor || SEASON_GROUND.summer});

  /* Winter stretches in world y, from the same 420 px sampling that builds
     the gradient stops. The snow overlay (the one colored overlay) is
     clipped to these instead of painted across a whole 1600 px band, and its
     masked edges fade over the same 2% of LEN the gradient does, so drifts
     never sit on gold autumn ground. Open-ended at either end of the trail. */
  const SEASON_FADE = 0.02 * LEN;
  const winterRanges = [];
  {
    let start = null;
    for (let yy = 0; yy <= LEN + 420; yy += 420){
      const w = yy <= LEN && SEASON_OF(Math.round(monthAtY(yy))) === 'winter';
      if (w && start === null) start = yy;
      if (!w && start !== null){
        winterRanges.push({a: start === 0 ? -3000 : start - SEASON_FADE, b: yy > LEN ? LEN + 3000 : yy});
        start = null;
      }
    }
  }

  const bands = [];
  for (let bi = 0; bi < NB; bi++){
    const y0 = BAND0 + bi * BANDH;
    const over = bi === 0 ? 0 : 2;    // paint over the previous band's seam
    const bsvg = document.createElementNS(NS, 'svg');
    bsvg.setAttribute('width', W + 2200); bsvg.setAttribute('height', BANDH + over);
    bsvg.setAttribute('viewBox', `-1100 ${y0 - over} ${W + 2200} ${BANDH + over}`);
    // Every band strokes the whole trail path, and band svgs keep
    // overflow:visible, so without a clip the nearer band's trail paints
    // over the previous (farther) band's creek and bridge. A rect clipPath
    // is a scissor (no buffer, see the GPU rules above).
    const bandClip = document.createElementNS(NS, 'clipPath');
    bandClip.id = 'bandclip' + bi;
    const bandClipRect = document.createElementNS(NS, 'rect');
    // The clip keeps this band's trail out of FARTHER bands only (it starts
    // at this band's top and runs to the world's end). Nearer bands paint
    // later and overpaint it anyway, so the seam paint structure is exactly
    // what it was before the clip existed; a clip that ended at the band's
    // bottom instead left a hairline where two clip edges met.
    bandClipRect.setAttribute('x', -1100); bandClipRect.setAttribute('y', y0 - over);
    bandClipRect.setAttribute('width', W + 2200); bandClipRect.setAttribute('height', NB * BANDH + 8000);
    bandClip.appendChild(bandClipRect);
    bsvg.style.left = '-1100px'; bsvg.style.top = (y0 - over) + 'px';
    const bdefs = document.createElementNS(NS, 'defs');
    const bgrad = document.createElementNS(NS, 'linearGradient');
    bgrad.id = 'seasons' + bi;
    bgrad.setAttribute('gradientUnits', 'userSpaceOnUse');
    bgrad.setAttribute('x1','0'); bgrad.setAttribute('y1','0');
    bgrad.setAttribute('x2','0'); bgrad.setAttribute('y2', LEN);
    stops.forEach(s => {
      const st = document.createElementNS(NS, 'stop');
      st.setAttribute('offset', (s.off * 100).toFixed(2) + '%');
      st.setAttribute('stop-color', s.color);
      bgrad.appendChild(st);
    });
    bdefs.appendChild(bgrad);
    bsvg.appendChild(bdefs);
    bdefs.appendChild(bandClip);
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', -1100); bg.setAttribute('y', y0 - over);
    bg.setAttribute('width', W + 2200); bg.setAttribute('height', BANDH + over);
    bg.setAttribute('fill', `url(#seasons${bi})`);
    bsvg.appendChild(bg);

    // Overlay choice is by band index, not rnd(): an extra rnd() call in
    // this loop would shift the seeded sequence and move every tree and
    // trail drift on the site.
    const overlayFile = `ground-overlay-${['a','b','c'][(bi * 7) % 3]}.webp`;
    let inkImgs = [], dirtImg = null, snowImgs = [];
    // Everything painted is skipped entirely in flat mode so ?ground=flat
    // really is the pre-art build. Budget rules learned on the iPhone
    // (2026-09-06): on WebKit every element filled with a <pattern> owns a
    // GPU tile buffer of tile size x 3x DPR, about 20 MB per band per
    // pattern at a 1024 tile, even before its image has an href. So the
    // overlays are plain <image> tiles instead (they draw straight from the
    // one decoded bitmap, no buffer), the dirt trail keeps the only pattern
    // because a stroke needs a paint server and uses a small tile, and
    // nothing here uses a mask, a filter or element opacity.
    if (!GROUND_FLAT){
      // World-anchored tiling: image positions are multiples of ART_TILE in
      // world space, and every band's viewBox is that same world space, so
      // the tile phase lines up continuously across the 2 px band overlap.
      // No href yet; update() attaches one only when the band enters the
      // lookahead window, and until then an <image> paints nothing, so the
      // gradient rect underneath still shows (the "never blank" guarantee).
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

      const dirtPattern = document.createElementNS(NS, 'pattern');
      dirtPattern.id = 'dirt' + bi;
      dirtPattern.setAttribute('patternUnits', 'userSpaceOnUse');
      dirtPattern.setAttribute('x', '0'); dirtPattern.setAttribute('y', '0');
      dirtPattern.setAttribute('width', TILE); dirtPattern.setAttribute('height', TILE);
      dirtImg = document.createElementNS(NS, 'image');
      dirtImg.setAttribute('width', TILE); dirtImg.setAttribute('height', TILE);
      dirtPattern.appendChild(dirtImg);
      bdefs.appendChild(dirtPattern);

      // Winter gets its own painted overlay (drifts + bare grass) because a
      // transparent grain doesn't read as snow (docs/alpine-art-brief.md
      // section 2). Its tiles sit in a group clipped by one plain rect (a
      // scissor, no buffer) to the winter stretch; the fade at each end is
      // the neighbouring season's ground colour painted back over the snow
      // through a plain gradient, which is a shading with no buffer either.
      const rx = -1100, rw = W + 2200;
      if (GROUND_SNOW) winterRanges.forEach((r, k) => {
        const top = Math.max(r.a, y0 - over), bot = Math.min(r.b, y0 + BANDH + over);
        if (bot <= top) return;
        const cp = document.createElementNS(NS, 'clipPath');
        cp.id = `snowclip${bi}_${k}`; cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
        const cr = document.createElementNS(NS, 'rect');
        cr.setAttribute('x', rx); cr.setAttribute('y', top);
        cr.setAttribute('width', rw); cr.setAttribute('height', bot - top);
        cp.appendChild(cr); bdefs.appendChild(cp);
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('clip-path', `url(#${cp.id})`);
        bsvg.appendChild(g);
        snowImgs.push(...tileImages(g, top, bot));
        const fade = Math.min(SEASON_FADE, (r.b - r.a) / 2);
        const edge = (yFrom, yTo, colorAtY, tag) => {
          const a = Math.max(Math.min(yFrom, yTo), top), b = Math.min(Math.max(yFrom, yTo), bot);
          if (b <= a) return;
          const lg = document.createElementNS(NS, 'linearGradient');
          lg.id = `snowfade${bi}_${k}${tag}`;
          lg.setAttribute('gradientUnits', 'userSpaceOnUse');
          lg.setAttribute('x1', '0'); lg.setAttribute('y1', yFrom); lg.setAttribute('x2', '0'); lg.setAttribute('y2', yTo);
          const color = SEASON_GROUND[SEASON_OF(Math.round(monthAtY(colorAtY)))];
          [[0, 1], [1, 0]].forEach(([off, o]) => {
            const st = document.createElementNS(NS, 'stop');
            st.setAttribute('offset', off * 100 + '%');
            st.setAttribute('stop-color', color); st.setAttribute('stop-opacity', o);
            lg.appendChild(st);
          });
          bdefs.appendChild(lg);
          const fr = document.createElementNS(NS, 'rect');
          fr.setAttribute('x', rx); fr.setAttribute('y', a);
          fr.setAttribute('width', rw); fr.setAttribute('height', b - a);
          fr.setAttribute('fill', `url(#${lg.id})`);
          bsvg.appendChild(fr);
        };
        // Neighbour colours come from the same 420 px sample grid the
        // gradient stops use: the sample before the first winter one, and
        // the first non-winter one after it (r.b is that sample).
        if (r.a > -3000) edge(r.a, r.a + fade, r.a + SEASON_FADE - 420, 'a');  // previous season fades out downward
        if (r.b < LEN + 3000) edge(r.b, r.b - fade, r.b, 'b');                   // next season fades out upward
      });
    }
    map.appendChild(bsvg);

    const band = {
      svg: bsvg, y0, overlayFile, inkImgs, dirtImg, snowImgs, clipId: 'bandclip' + bi,
      overlayUrl: assetUrl(overlayFile), dirtFill: `url(#dirt${bi})`,
      attached: false, attachedAt: 0, overlayState: 'loading', dirtState: 'loading', detailImgs: [],
    };
    if (!GROUND_FLAT){
      // Paint-state listeners are wired once at build so a late attach only
      // has to flip href. Chromium quirk: a <pattern>'s <image> whose href
      // fails to load does not fall back to transparent, it paints an opaque
      // placeholder over the gradient rect and breaks "never blank". So on
      // error the href is cleared, which reverts the pattern to its
      // transparent pre-attach state; overlayState still records 'failed' so
      // missingOverlays keeps detecting it. dirtState works the same way.
      // The overlay is many tiles of one bitmap; the first tile's events
      // stand for the band (same URL, same decode, same outcome).
      if (inkImgs.length){
        inkImgs[0].addEventListener('load', () => { band.overlayState = 'painted'; });
        inkImgs[0].addEventListener('error', () => { band.overlayState = 'failed'; });
      } else {
        band.overlayState = 'painted';  // ?ink=off: nothing to wait for
      }
      inkImgs.forEach(im => im.addEventListener('error', () => im.removeAttribute('href')));
      dirtImg.addEventListener('load', () => { band.dirtState = 'painted'; });
      dirtImg.addEventListener('error', () => { band.dirtState = 'failed'; dirtImg.removeAttribute('href'); });
      snowImgs.forEach(im => im.addEventListener('error', () => im.removeAttribute('href')));
    }
    bands.push(band);
  }
  const bandFor = yy => clamp(Math.floor((yy - BAND0) / BANDH), 0, NB - 1);

  /* trail geometry: waypoints = events + drift points inside long gaps */
  const waypts = [pts[0]];
  for (let i = 1; i < pts.length; i++){
    const a = pts[i-1], b = pts[i];
    if (a.y - b.y > 620){
      const my = (a.y + b.y) / 2;
      const mx = clamp((a.x + b.x) / 2 + (rnd() - 0.5) * 460, CX - AMP - 80, CX + AMP + 80);
      waypts.push({x: mx, y: my});
    }
    waypts.push(b);
  }
  let dStr = `M ${waypts[0].x} ${waypts[0].y + 700} L ${waypts[0].x} ${waypts[0].y}`;
  for (let i = 1; i < waypts.length; i++){
    const a = waypts[i-1], b = waypts[i];
    const g1 = (a.y - b.y) * (0.34 + rnd() * 0.3);
    const g2 = (a.y - b.y) * (0.34 + rnd() * 0.3);
    dStr += ` C ${a.x} ${a.y - g1}, ${b.x} ${b.y + g2}, ${b.x} ${b.y}`;
  }
  dStr += ` L ${waypts[waypts.length-1].x} ${waypts[waypts.length-1].y - 90}`;

  const guideProbe = document.createElementNS(NS, 'path');
  guideProbe.setAttribute('d', dStr); guideProbe.setAttribute('fill', 'none');
  bands[0].svg.appendChild(guideProbe);
  const PLEN = guideProbe.getTotalLength();
  const SAMPLES = 500, lut = [];
  for (let i = 0; i <= SAMPLES; i++){
    const pt = guideProbe.getPointAtLength(PLEN * i / SAMPLES);
    lut.push({d: PLEN * i / SAMPLES, x: pt.x, y: pt.y});
  }
  function atDist(dist){
    dist = clamp(dist, 0, PLEN);
    let lo = 0, hi = SAMPLES;
    while (hi - lo > 1){ const mid = (lo + hi) >> 1; (lut[mid].d <= dist) ? lo = mid : hi = mid; }
    const a = lut[lo], b = lut[hi], t = (dist - a.d) / Math.max(1e-6, b.d - a.d);
    return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
  }
  function distAtY(ty){
    let lo = 0, hi = SAMPLES;
    while (hi - lo > 1){ const mid = (lo + hi) >> 1; (lut[mid].y >= ty) ? lo = mid : hi = mid; }
    return lut[hi].d;
  }
  const trailXAtY = ty => atDist(distAtY(ty)).x;

  /* creek + pond in the two widest quiet stretches */
  const gapList = pts.slice(1).map((p, i) => ({y0: pts[i].y, y1: p.y, size: pts[i].y - p.y}))
                     .sort((a, b) => b.size - a.size);
  // The creek wants a quiet stretch, but every billboard stands up about
  // 420 world px of the ground behind it, wider than most stretches, so a
  // crossing centred in a gap lands behind the photo at the gap's near end.
  // The trail winds, though: pick the widest gap and crossing where the
  // bridge sits more than a billboard's half-width to the side of that
  // event (or fully beyond its shadow), so the bridge stays clickable-clear.
  // Where does the trail cross a given row? trailXAtY() is ambiguous on an
  // S-bend (the trail doubles back over the same rows), so the crossings
  // are read off the sampled trail polyline instead: one entry per sign
  // change, with the crossing x and the trail's angle from vertical there.
  const trailCrossings = (y) => {
    const out = [];
    for (let i = 1; i <= SAMPLES; i++){
      const a = lut[i - 1], b = lut[i];
      if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue;
      const t = (y - a.y) / (b.y - a.y);
      // direction over a longer stretch so the angle is not sample noise
      const p0 = lut[Math.max(0, i - 12)], p1 = lut[Math.min(SAMPLES, i + 12)];
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      out.push({x: a.x + (b.x - a.x) * t, angle: Math.atan2(dx, Math.abs(dy) || 1) * 180 / Math.PI});
    }
    return out;
  };
  // A bridge needs exactly one crossing of the deck's row.
  const bridgeSpot = (cy) => {
    const c = trailCrossings(cy + 30);
    return c.length === 1 ? c[0] : null;
  };
  // Clearance is sized to the billboard in question: the union's two pet
  // circles reach about 280 px either side of its point, a camp card 135;
  // plus the rotated deck's reach (about 110) and a margin.
  const bbHalf = p => (p.e && p.e.type === 'union') ? 290 : 140;
  const bridgeClear = (cy, near) => {
    const spot = bridgeSpot(cy);
    if (!spot) return false;
    return !near || Math.abs(spot.x - near.x) > bbHalf(near) + 130 || cy + 94 < near.y - 420;
  };
  // The squirrel's tree and the deer are placed later at fixed fractions of
  // the trail; neither belongs in the water, so their stretches are skipped.
  const critterYs = [atDist(PLEN * 0.34).y, atDist(PLEN * 0.56).y];
  const critterFree = (y, r) => critterYs.every(cy => Math.abs(cy - y) > r);
  let creekY = null, creekGap = null;
  const creekTries = [];   // diagnostics for the smoke and for tuning
  // Scan every quiet stretch in 20 px steps and keep the clear crossing
  // where the trail is closest to square-on; the gaps here are only about
  // 400 px, so a handful of fixed fractions would miss most of each one.
  // The trail begins with a straight 700 px stub below the first event (see
  // dStr): no events, no billboard standing in front of it, a square
  // crossing on the first screen, which is where the plan wanted the creek.
  const stubGap = pts.length ? {y0: pts[0].y + 700, y1: pts[0].y, size: 700, stub: true} : null;
  let best = null;
  for (const g of (stubGap ? [stubGap] : []).concat(gapList.slice(0, 6))){
    if (g.size < 300) continue;
    if (!critterFree((g.y0 + g.y1) / 2, 360)){ creekTries.push({y0: g.y0, size: g.size, skip: 'critter'}); continue; }
    const near = g.stub ? null : pts.find(p => p.y === g.y0);
    for (let cy = g.y1 + 120; cy <= g.y0 - 120; cy += 20){
      const cross = trailCrossings(cy + 30);
      if (cross.length !== 1) continue;
      const dx = near ? Math.abs(cross[0].x - near.x) : Infinity;
      const clear = !near || dx > bbHalf(near) + 130 || cy + 94 < near.y - 420;
      const angle = Math.abs(cross[0].angle);
      creekTries.push({y0: g.y0, cy, angle: Math.round(cross[0].angle), dx: Math.round(dx), need: near ? bbHalf(near) + 130 : 0, ok: clear});
      if (clear && (!best || angle < best.angle - 0.5 || (Math.abs(angle - best.angle) <= 0.5 && dx > best.dx))) best = {cy, g, angle, dx};
    }
  }
  if (best){ creekY = best.cy; creekGap = best.g; }
  if (creekY === null){ creekGap = gapList[0] || null; creekY = creekGap ? (creekGap.y0 + creekGap.y1) / 2 : LEN / 2; }
  // The pond wants open meadow beside the trail where no billboard stands
  // on it or in front of it: a card at (p.x, p.y) covers its own base and
  // the ground behind it (smaller y) for about 420 px, across its own half
  // width plus the pond's 252 px radius. Try each quiet stretch, both
  // sides, and a few rows before settling for the widest stretch's centre.
  const pondClear = (px, py) => !pts.some(p =>
    Math.abs(p.x - px) < bbHalf(p) + 252 && py - 170 < p.y && p.y < py + 570);
  let pondSpot = null;
  for (const g of gapList.slice(0, 8)){
    if (g === creekGap || !critterFree((g.y0 + g.y1) / 2, 420)) continue;
    for (const f of [0.5, 0.35, 0.65]){
      const py = g.y0 - g.size * f;
      const tx = trailXAtY(py);
      for (const side of (tx > CX ? [-1, 1] : [1, -1])){
        const px = clamp(tx + side * 640, 260, W - 260);
        if (Math.abs(px - tx) < 420) continue;   // clamped back onto the trail
        if (pondClear(px, py)){ pondSpot = {x: px, y: py, g}; break; }
      }
      if (pondSpot) break;
    }
    if (pondSpot) break;
  }
  const pondG = pondSpot ? pondSpot.g : (gapList.find(g => g !== creekGap && critterFree((g.y0 + g.y1) / 2, 420)) || null);

  const creekGroup = document.createElementNS(NS, 'g');
  // One source for the creek's quadratic chain: the painted path and the U8
  // flow clip both read it, so they can never disagree.
  const creekCtrlY = x => creekY + ((x / 300) % 2 ? 74 : -12);
  // The deck sits where the trail actually crosses the water (its x at the
  // deck's own row, creekY + 30) and turns to the trail's direction there,
  // so a diagonal crossing gets a diagonal bridge instead of one beside the
  // path. Positive rotate() turns clockwise with y down, so a trail that
  // drifts right as it comes nearer (dx > 0) needs a negative angle.
  const bridgeY = creekY + 30;
  const bridgeCross = bridgeSpot(creekY) || trailCrossings(bridgeY)[0] || {x: trailXAtY(bridgeY), angle: 0};
  const cx = bridgeCross.x;
  // The deck turns toward the trail but no further than 30deg: on this
  // trail the clear crossings are steep, and a deck turned 70deg reads as
  // a raft lying along the river, while a trail bending onto a bridge
  // reads fine.
  const bridgeRot = -clamp(bridgeCross.angle, -30, 30);
  const bridgeTransform = `translate(${cx}, ${bridgeY}) rotate(${bridgeRot.toFixed(1)})`;
  {
    let cd = `M -1100 ${creekY + 40}`;
    for (let x = -1000; x <= W + 1100; x += 300){
      cd += ` Q ${x - 150} ${creekCtrlY(x)}, ${x} ${creekY + 30}`;
    }
    creekGroup.innerHTML =
      `<path d="${cd}" fill="none" stroke="#7FA8B5" stroke-width="64" stroke-linecap="round" opacity=".85"/>
       <path d="${cd}" fill="none" stroke="#9DC2CC" stroke-width="40" stroke-linecap="round" opacity=".8"/>
       <path d="${cd}" class="shimmer" fill="none" stroke="#E9F3F0" stroke-width="7"
             stroke-linecap="round" stroke-dasharray="18 70" opacity=".55"/>
       <g transform="${bridgeTransform}">
         <rect x="-95" y="-58" width="190" height="116" rx="10" fill="#9A7E52"/>
         <g stroke="#7C6540" stroke-width="5">${[-38,-14,10,34].map(o => `<line x1="${o}" y1="-58" x2="${o}" y2="58"/>`).join('')}</g>
         <rect x="-101" y="-64" width="202" height="11" rx="5" fill="#7C6540"/>
         <rect x="-101" y="53" width="202" height="11" rx="5" fill="#7C6540"/>
       </g>`;
    // U6 painted creek, built per band because each band's <svg> needs its
    // own pattern ids. Paint order: a flat bank colour (the fallback if the
    // bank tile never loads), the bank tile, an ink rim, a flat teal (the
    // fallback for the water tile), the water tile, then the bridge with an
    // ink outline. No shimmer dash: nothing inside a band SVG animates; U8
    // supplies motion outside the band. Geometry (cd, cx) is unchanged.
    creekGroup.paintedMarkup = (bi) =>
      waterDefs('cw' + bi, 'cb' + bi) +
      `<path d="${cd}" fill="none" stroke="#8F8B7A" stroke-width="112" stroke-linecap="round" stroke-opacity=".5"/>
       <path d="${cd}" fill="none" stroke="url(#cb${bi})" stroke-width="112" stroke-linecap="round"/>
       <path d="${cd}" fill="none" stroke="${INK_COLOR}" stroke-width="72" stroke-linecap="round" stroke-opacity=".8"/>
       <path d="${cd}" fill="none" stroke="#2E7A80" stroke-width="64" stroke-linecap="round"/>
       <path d="${cd}" fill="none" stroke="url(#cw${bi})" stroke-width="64" stroke-linecap="round"/>
       <g transform="${bridgeTransform}" stroke="${INK_COLOR}" stroke-width="3">
         <rect x="-95" y="-58" width="190" height="116" rx="10" fill="#9A7E52"/>
         <g stroke="#7C6540" stroke-width="5">${[-38,-14,10,34].map(o => `<line x1="${o}" y1="-58" x2="${o}" y2="58"/>`).join('')}</g>
         <rect x="-101" y="-64" width="202" height="11" rx="5" fill="#7C6540"/>
         <rect x="-101" y="53" width="202" height="11" rx="5" fill="#7C6540"/>
       </g>`;
  }
  // Two 256 px userSpaceOnUse patterns (water, bank) with the tile image
  // attached from the start: one decoded bitmap each, shared by every band.
  function waterDefs(waterId, bankId){
    const pat = (id, url) => `<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${WATER_TILE}" height="${WATER_TILE}">` +
      `<image width="${WATER_TILE}" height="${WATER_TILE}" href="${url}"/></pattern>`;
    return `<defs>${pat(waterId, WATER_URL)}${pat(bankId, BANK_URL)}</defs>`;
  }

  let pondHTML = '', pondPos = null;
  if (pondG){
    const py = pondSpot ? pondSpot.y : (pondG.y0 + pondG.y1) / 2;
    const px = pondSpot ? pondSpot.x : clamp(trailXAtY(py) + (trailXAtY(py) > CX ? -640 : 640), 260, W - 260);
    pondPos = {x: px, y: py};
    pondHTML =
      `<g transform="translate(${px},${py})">
        <ellipse cx="0" cy="0" rx="230" ry="130" fill="#7FA8B5"/>
        <ellipse cx="0" cy="0" rx="196" ry="106" fill="#9DC2CC"/>
        <ellipse class="shimmer" cx="0" cy="0" rx="150" ry="76" fill="none"
                 stroke="#E9F3F0" stroke-width="5" stroke-dasharray="16 60" opacity=".6"/>
        <ellipse cx="-60" cy="-24" rx="26" ry="14" fill="#6E8F4E"/>
        <ellipse cx="48" cy="30" rx="20" ry="11" fill="#7C9E58"/>
        <ellipse cx="90" cy="-40" rx="16" ry="9" fill="#6E8F4E"/>
      </g>`;
  }
  // U6 painted pond: the same three layers on the ellipse (bank tile, ink
  // rim, water tile), each over its flat fallback colour; lily pads stay.
  const pondPainted = (bi) => !pondPos ? '' :
    waterDefs('pw' + bi, 'pb' + bi) +
    `<g transform="translate(${pondPos.x},${pondPos.y})">
      <ellipse cx="0" cy="0" rx="252" ry="150" fill="#8F8B7A" fill-opacity=".5"/>
      <ellipse cx="0" cy="0" rx="252" ry="150" fill="url(#pb${bi})"/>
      <ellipse cx="0" cy="0" rx="234" ry="134" fill="${INK_COLOR}" fill-opacity=".8"/>
      <ellipse cx="0" cy="0" rx="228" ry="128" fill="#2E7A80"/>
      <ellipse cx="0" cy="0" rx="228" ry="128" fill="url(#pw${bi})"/>
      <ellipse cx="-60" cy="-24" rx="26" ry="14" fill="#6E8F4E" stroke="${INK_COLOR}" stroke-width="2"/>
      <ellipse cx="48" cy="30" rx="20" ry="11" fill="#7C9E58" stroke="${INK_COLOR}" stroke-width="2"/>
      <ellipse cx="90" cy="-40" rx="16" ry="9" fill="#6E8F4E" stroke="${INK_COLOR}" stroke-width="2"/>
    </g>`;
  // Debug hook for the smoke's U6 scenario: where the water is.
  window.__journeyWater = { creekY, bridgeX: cx, bridgeRot, pond: pondPos, painted: PAINT_WATER, tries: creekTries };

  bands.forEach((b, bandIdx) => {
    if (GROUND_FLAT){
      // ?ground=flat (or an empty manifest) is a faithful rollback to
      // today's look: the dirt pattern never gets an href, so painting the
      // trail with it would show nothing — build the old plain stroke
      // instead of relying on that at runtime.
      const bandPath = document.createElementNS(NS, 'path');
      bandPath.setAttribute('d', dStr); bandPath.setAttribute('fill', 'none');
      bandPath.setAttribute('stroke', '#5C5137'); bandPath.setAttribute('stroke-width', '120');
      bandPath.setAttribute('stroke-linecap', 'round'); bandPath.setAttribute('opacity', '0.12');
      bandPath.setAttribute('clip-path', `url(#${b.clipId})`);
      b.svg.appendChild(bandPath);
    } else {
      // Fallback stroke, painted first (i.e. under everything else in this
      // band): if the dirt tile 404s, url(#dirtN) paints transparent and —
      // without this — the trail vanishes into the season ground, leaving
      // only the faint ink edge and dots below. This is the old flat-mode
      // stroke/opacity, so a failed tile degrades to today's look instead of
      // disappearing. No rnd() call; one extra path inside the existing band
      // <svg> (not a new element outside it, so no new GPU surface).
      const fallbackPath = document.createElementNS(NS, 'path');
      fallbackPath.setAttribute('d', dStr); fallbackPath.setAttribute('fill', 'none');
      fallbackPath.setAttribute('stroke', '#5C5137'); fallbackPath.setAttribute('stroke-width', '120');
      fallbackPath.setAttribute('stroke-linecap', 'round'); fallbackPath.setAttribute('stroke-opacity', '0.12');
      fallbackPath.setAttribute('clip-path', `url(#${b.clipId})`);
      b.svg.appendChild(fallbackPath);
      // Painted dirt trail: an ink edge line drawn first, slightly
      // wider than the trail stroke so it peeks out as an outline, then the
      // dirt-tile pattern on top at full opacity. dStr geometry is unchanged.
      const inkEdge = document.createElementNS(NS, 'path');
      inkEdge.setAttribute('d', dStr); inkEdge.setAttribute('fill', 'none');
      inkEdge.setAttribute('stroke', INK_COLOR); inkEdge.setAttribute('stroke-width', '126');
      inkEdge.setAttribute('stroke-linecap', 'round'); inkEdge.setAttribute('stroke-opacity', '.35');
      inkEdge.setAttribute('clip-path', `url(#${b.clipId})`);
      b.svg.appendChild(inkEdge);
      const dirtPath = document.createElementNS(NS, 'path');
      dirtPath.setAttribute('d', dStr); dirtPath.setAttribute('fill', 'none');
      dirtPath.setAttribute('stroke', GROUND_DIRT ? b.dirtFill : '#8B8A7E'); dirtPath.setAttribute('stroke-width', '120');
      dirtPath.setAttribute('stroke-linecap', 'round');
      dirtPath.setAttribute('clip-path', `url(#${b.clipId})`);
      b.svg.appendChild(dirtPath);
    }
    if (creekY + 160 > b.y0 && creekY - 160 < b.y0 + BANDH){
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'creek');
      g.innerHTML = PAINT_WATER ? creekGroup.paintedMarkup(bandIdx) : creekGroup.innerHTML;
      b.svg.appendChild(g);
    }
    if (pondHTML && pondPos && pondPos.y + 170 > b.y0 && pondPos.y - 170 < b.y0 + BANDH){
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'pond');
      g.innerHTML = PAINT_WATER ? pondPainted(bandIdx) : pondHTML;
      b.svg.appendChild(g);
    }
    const dotsPath = document.createElementNS(NS, 'path');
    dotsPath.setAttribute('d', dStr); dotsPath.setAttribute('fill', 'none');
    dotsPath.setAttribute('stroke', GROUND_FLAT ? '#6B5C40' : INK_COLOR); dotsPath.setAttribute('stroke-width', '13');
    dotsPath.setAttribute('stroke-linecap', 'round'); dotsPath.setAttribute('stroke-dasharray', '0.01 42');
    // stroke-opacity, not opacity: element opacity allocates an offscreen
    // buffer per band on iOS (see the snow strips above for the same rule).
    if (!GROUND_FLAT) dotsPath.setAttribute('stroke-opacity', '.45');
    dotsPath.setAttribute('clip-path', `url(#${b.clipId})`);
    b.svg.appendChild(dotsPath);
    b.detail = document.createElementNS(NS, 'g');
    b.svg.appendChild(b.detail);
    // Ground-detail sprites (scree/log/flower atlas cells or, flat-mode,
    // their vector predecessors) live in their own subgroup so the
    // window.__journeyDetailVectorCount check below can count just these —
    // b.detail also holds the holiday and birthday decorations appended
    // later, which keep their vector shapes.
    b.gdetail = document.createElementNS(NS, 'g');
    b.detail.appendChild(b.gdetail);
    b.shadows = document.createElementNS(NS, 'g');
    b.svg.appendChild(b.shadows);
  });

  /* Ground details: scree, fallen logs, spring/summer flowers, winter drift,
     autumn litter. Not-flat mode replaces scree/log/flower with atlas cells
     ; winter drift and autumn litter get no cell and are simply dropped,
     since the winter overlay paints its own drifts and the autumn palette
     carries the litter look. Every branch still calls rnd() exactly as
     many times as its flat-mode markup does, flat or not: this loop runs
     before grove/prop placement further down, and an extra or missing
     rnd() call here would shift that seeded sequence and move every tree on
     the site, not just re-skin this detail (same rationale as the per-band
     overlay pick above). */
  const bandDh = new Array(NB).fill('');
  for (let d = 250; d < PLEN - 250; d += 210 + rnd() * 150){
    const p = atDist(d);
    const off = (rnd() > 0.5 ? 1 : -1) * (300 + rnd() * 850);
    const x = clamp(p.x + off, -950, W + 950), yy = p.y + (rnd() - 0.5) * 160;
    const season = SEASON_OF(Math.round(monthAtY(yy)));
    const r = rnd();
    let dh = '';
    if (r < 0.24){       // scree / pebbles
      const r1w = 8+rnd()*10, r1h = 4+rnd()*5, r2w = 5+rnd()*7, r2h = 3+rnd()*4;
      dh += GROUND_FLAT
        ? `<g fill="#9C9C8C" opacity=".7"><ellipse cx="${x}" cy="${yy}" rx="${r1w}" ry="${r1h}"/>
             <ellipse cx="${x+20}" cy="${yy+8}" rx="${r2w}" ry="${r2h}"/></g>`
        : atlasCellMarkup('scree-patch', x, yy);
    } else if (r < 0.34){ // fallen log
      const rot = rnd()*80-40;
      dh += GROUND_FLAT
        ? `<g transform="translate(${x},${yy}) rotate(${rot})">
             <rect x="-34" y="-7" width="68" height="14" rx="7" fill="#84704C"/>
             <circle cx="34" cy="0" r="7" fill="#A08A5E"/></g>`
        : `<g transform="rotate(${rot} ${x} ${yy})">${atlasCellMarkup('fallen-log', x, yy)}</g>`;
    } else if (season === 'winter'){
      const rw = 50+rnd()*60, rh = 14+rnd()*10;
      dh += GROUND_FLAT
        ? `<ellipse cx="${x}" cy="${yy}" rx="${rw}" ry="${rh}" fill="#F2F4EC" opacity=".7"/>`
        : '';  // the winter overlay paints its own drifts
    } else if (season === 'spring'){
      const coin = rnd() > 0.5;
      dh += GROUND_FLAT
        ? `<g><circle cx="${x}" cy="${yy}" r="5.5" fill="${coin?'#D98BA4':'#EFE9F2'}"/>
             <circle cx="${x+16}" cy="${yy+8}" r="4.5" fill="#EAD9EE"/>
             <circle cx="${x-13}" cy="${yy+11}" r="4" fill="#D98BA4"/></g>`
        : atlasCellMarkup(`flower-clump-${coin ? 'a' : 'b'}`, x, yy);
    } else if (season === 'summer'){
      dh += GROUND_FLAT
        ? `<g fill="#F2E28C" opacity=".9"><circle cx="${x}" cy="${yy}" r="4.5"/>
             <circle cx="${x+15}" cy="${yy+9}" r="3.5"/><circle cx="${x-12}" cy="${yy+7}" r="3"/></g>`
        : atlasCellMarkup(`flower-clump-${Math.round(x + yy) % 2 === 0 ? 'a' : 'b'}`, x, yy);
    } else {
      dh += GROUND_FLAT
        ? `<g fill="#B98A4A" opacity=".8"><ellipse cx="${x}" cy="${yy}" rx="6" ry="3.5" transform="rotate(30 ${x} ${yy})"/>
             <ellipse cx="${x+17}" cy="${yy+7}" rx="5" ry="3" transform="rotate(-20 ${x+17} ${yy+7})"/>
             <ellipse cx="${x-12}" cy="${yy+11}" rx="5" ry="3" transform="rotate(60 ${x-12} ${yy+11})"/></g>`
        : '';  // autumn litter: the autumn palette carries it, no cell exists
    }
    bandDh[bandFor(yy)] += dh;
  }
  bands.forEach((b, i) => {
    b.gdetail.innerHTML = bandDh[i];
    // Collected once so update()'s per-frame lookahead attach/detach only
    // ever sets/clears href, never re-queries the DOM.
    b.detailImgs = Array.from(b.gdetail.querySelectorAll('image.atlas'));
    // Same Chromium <pattern>-style quirk can hit a plain <image> too when
    // its href 404s mid-tile-decode; clearing href on error is cheap
    // insurance for the same "never blank" intent.
    b.detailImgs.forEach(im => im.addEventListener('error', () => im.removeAttribute('href')));
  });
  // Smoke-test proof that no vector scree, flower or log path is left
  // behind, scoped to b.gdetail (b.detail also holds the vector holiday
  // and birthday decorations).
  window.__journeyDetailVectorCount = GROUND_FLAT ? undefined :
    bands.reduce((n, b) => n + b.gdetail.querySelectorAll('ellipse, rect, circle').length, 0);

  // Reduced motion jumps the camera straight to its target instead of
  // gliding, so a band can enter the lookahead window and need to paint
  // within the very same frame as the jump — there is no glide time for a
  // fresh network fetch + decode to finish invisibly. Preloading every art
  // file a band could reference, once here at build for every profile
  // (never in flat mode, where nothing is ever attached), warms WebKit's
  // decoded-image cache — keyed by URL and shared by every band that points
  // at the same file — so an attach after an instant jump reads from cache
  // instead of paying that cost live.
  if (!GROUND_FLAT){
    const preload = new Set(bands.map(b => b.overlayFile));
    preload.forEach(f => { const u = assetUrl(f); if (u){ const im = new Image(); im.src = u; } });
    [DIRT_URL, winterRanges.length ? SNOW_URL : null]
      .forEach(u => { if (u){ const im = new Image(); im.src = u; } });
    // Atlas preload doubles as the atlasState probe (see its declaration
    // above): one Image, load/error listeners flip the shared state that
    // every band's missingOverlays check reads.
    if (ATLAS_URL){
      const atlasProbe = new Image();
      atlasProbe.addEventListener('load', () => { atlasState = 'painted'; });
      // A failed atlas also flips the CSS fallback for grove sprites: each
      // .gi.sp hides its (empty) image and shows a flat ink silhouette
      // instead, so trees never vanish (journey.css, #map.atlas-failed).
      atlasProbe.addEventListener('error', () => { atlasState = 'failed'; map.classList.add('atlas-failed'); });
      atlasProbe.src = ATLAS_URL;
    }
  }

  // Debug hook for the smoke script's lookahead scenario: a plain
  // snapshot, not live references, so reading it can't itself perturb state.
  window.__journeyBands = () => bands.map(b => (
    {y0: b.y0, hidden: !!b.hidden, attached: !!b.attached, overlayFile: b.overlayFile, winter: b.snowImgs.length > 0}));

  /* cloud shadows drifting over the ground */
  if (!reduced && !LITE){
    for (let i = 0; i < 2; i++){
      const c = document.createElement('div');
      c.className = 'cloudshadow';
      const w = 700 + rnd() * 500;
      c.style.cssText = `left:${(rnd()*(W+1600)-800).toFixed(0)}px; top:${(rnd()*LEN).toFixed(0)}px;
        width:${w}px; height:${w*0.55}px; animation-duration:${(80+rnd()*60).toFixed(0)}s;
        animation-delay:-${(rnd()*70).toFixed(0)}s;`;
      map.appendChild(c);
    }
  }

  function addShadow(x, y, rx){
    const el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', x); el.setAttribute('cy', y - (rx * SH_R + 10));
    el.setAttribute('rx', rx); el.setAttribute('ry', rx * SH_R);
    el.setAttribute('fill', 'rgba(45,52,32,.16)');
    bands[bandFor(y)].shadows.appendChild(el);
  }

  /* ---------- standing props (forest, rocks, home, holidays, lore…) ---------- */
  const props = [];
  function prop(x, y, html, opts = {}){
    const el = document.createElement('div');
    el.className = 'prop' + (opts.cls ? ' ' + opts.cls : '');
    el.style.left = x + 'px'; el.style.top = y + 'px';
    if (opts.z) el.style.zIndex = opts.z;
    el.innerHTML = html;
    map.appendChild(el);
    if (opts.shadow) addShadow(x, y, opts.shadow);
    props.push({el, y, yMin: y, yMax: y});
    return el;
  }

  function pineSVG(h, tone, dark, lights){
    const w = h * 0.62;
    let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    s += `<rect x="${w/2 - h*0.035}" y="${h*0.82}" width="${h*0.07}" height="${h*0.18}" rx="3" fill="#7C6540"/>`;
    const tiers = [[0.30, 1.0], [0.16, 0.82], [0.04, 0.6]];
    tiers.forEach(([ty, tw], i) => {
      const half = (w * tw) / 2;
      s += `<path d="M ${w/2} ${h*ty} L ${w/2 - half} ${h*(ty + 0.34)} L ${w/2 + half} ${h*(ty + 0.34)} Z"
             fill="${i % 2 ? dark : tone}"/>`;
    });
    if (lights) s += lightsSVG(w, h);
    return s + '</svg>';
  }
  // String of holiday lights for a w x h tree box. Seven rnd() calls, the
  // same count whether it decorates the procedural pine or sits as its own
  // svg over an atlas spruce, so the seeded layout downstream is unchanged.
  function lightsSVG(w, h){
    let s = `<g class="xlights">`;
    for (let i = 0; i < 7; i++){
      const ly = h * (0.26 + 0.5 * (i / 6));
      const spreadHalf = (w * (0.5 + 0.5 * i / 6)) / 2 * 0.8;
      const lx = w/2 + (i % 2 ? 1 : -1) * spreadHalf * (0.4 + 0.55 * rnd());
      s += `<circle cx="${lx}" cy="${ly}" r="3.4" fill="${['#E25555','#EFC94C','#7FB5E2','#8FBF6A'][i % 4]}"/>`;
    }
    return s + `</g>`;
  }
  // Decorated spruce prop: atlas snow spruce with the lights overlaid in
  // painted mode, the procedural lit pine in flat mode.
  function litTreeMarkup(h){
    if (!GROVE_SPRITES) return pineSVG(h, '#4A5B48', '#3C4B3A', true);
    const box = spriteBox('spruce-snow-b', h);
    return spriteBoxMarkup('spruce-snow-b', h, 'spruce',
      `<svg width="${box.w.toFixed(0)}" height="${box.h.toFixed(0)}" viewBox="0 0 ${box.w} ${box.h}" ` +
      `style="position:absolute; left:0; top:0;">${lightsSVG(box.w, box.h)}</svg>`);
  }
  function broadleafSVG(h, tone){
    const w = h * 0.9;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect x="${w/2-5}" y="${h*0.6}" width="10" height="${h*0.4}" rx="4" fill="#7C6540"/>
      <ellipse cx="${w/2}" cy="${h*0.38}" rx="${w*0.44}" ry="${h*0.34}" fill="${tone}"/>
      <ellipse cx="${w*0.3}" cy="${h*0.5}" rx="${w*0.24}" ry="${h*0.2}" fill="${tone}" opacity=".85"/>
      <ellipse cx="${w*0.72}" cy="${h*0.48}" rx="${w*0.22}" ry="${h*0.18}" fill="${tone}" opacity=".9"/>
    </svg>`;
  }
  function boulderSVG(s){
    return `<svg width="${s}" height="${s*0.7}" viewBox="0 0 100 70">
      <path d="M8 62 L2 44 Q10 18 34 12 L66 8 Q92 16 96 40 L92 62 Z" fill="#A8A896"/>
      <path d="M8 62 L2 44 Q10 18 34 12 L46 10 L38 62 Z" fill="#8F8F7E"/>
    </svg>`;
  }

  const SEASON_PINE = {
    spring:['#5E8256','#4E6F49'], summer:['#4F7348','#3F5E3B'],
    autumn:['#5E7A4C','#4C6340'], winter:['#5B6E58','#4A5B48']
  };
  // A tree behind an event can only overdraw its billboard if the tree's
  // 260px cluster bucket can anchor nearer than the event — so the keep-out
  // zone is one bucket deep (+jitter), not more, or the zones of adjacent
  // events merge into a continuous no-tree corridor.
  const eventClear = (x, y) => pts.some(p =>
    Math.abs(p.x - x) < 450 &&
    (y < p.y ? p.y - y < 460 : y - p.y < 380));

  /* forest: pines + boulders merged into grove clusters — one composited
     surface per ~520px stretch per side, instead of one per tree */
  const groveItems = [];
  const treeTarget = clamp(Math.round(LEN / 85), 50, 130);
  let placed = 0, guard = 0;
  while (placed < treeTarget && guard++ < treeTarget * 7){
    const d = 120 + rnd() * (PLEN - 240);
    const p = atDist(d);
    const off = (rnd() > 0.5 ? 1 : -1) * (360 + Math.pow(rnd(), 0.6) * 640);
    const x = clamp(p.x + off, -950, W + 950), yy = p.y + (rnd() - 0.5) * 200;
    if (eventClear(x, yy)) continue;
    if (pondPos && Math.abs(pondPos.x - x) < 300 && Math.abs(pondPos.y - yy) < 220) continue;
    if (Math.abs(yy - creekY) < 130) continue;
    const season = SEASON_OF(Math.round(monthAtY(yy)));
    const [tone, dark] = SEASON_PINE[season];
    const h = 100 + rnd() * 130;
    const isPine = rnd() < 0.74;
    const leafTone = season === 'autumn' ? (rnd() > 0.5 ? '#A8722E' : '#96823C')
                   : season === 'winter' ? '#87947A' : (rnd() > 0.5 ? '#54763C' : '#5F8244');
    if (GROVE_SPRITES){
      // U5: pick an atlas cell. The silhouette index comes from h's low
      // digits rather than another rnd() call, so the seeded sequence (and
      // every grove count and position after it) is exactly the vector
      // build's. Winter groves are all snow-capped spruce (R6); elsewhere
      // the 26% broadleaf share stays, rust in autumn.
      const pick = Math.floor(h * 1000);
      let cell, dh;
      if (season === 'winter'){ cell = 'spruce-snow-' + 'abc'[pick % 3]; dh = h; }
      else if (!isPine){ cell = season === 'autumn' ? 'broadleaf-b' : 'broadleaf-a'; dh = h * 0.8; }
      else { cell = (h >= 165 ? 'spruce-tall-' : 'spruce-short-') + 'abcd'[pick % 4]; dh = h; }
      const box = spriteBox(cell, dh);
      groveItems.push({x, y: yy, sh: h * 0.3, cell, season, box,
        kind: cell.startsWith('broadleaf') ? 'broadleaf' : 'spruce'});
    } else {
      groveItems.push({x, y: yy, svg: isPine ? pineSVG(h, tone, dark) : broadleafSVG(h * 0.8, leafTone), sh: h * 0.3});
    }
    placed++;
  }
  for (let i = 0; i < Math.round(LEN / 900); i++){
    const d = rnd() * PLEN;
    const p = atDist(d);
    const off = (rnd() > 0.5 ? 1 : -1) * (430 + rnd() * 520);
    const x = clamp(p.x + off, -950, W + 950), yy = p.y + (rnd() - 0.5) * 150;
    if (eventClear(x, yy) || Math.abs(yy - creekY) < 140) continue;
    const bw = 70 + rnd() * 90;
    if (GROVE_SPRITES){
      const cell = 'boulder-' + 'abcd'[Math.floor(bw * 1000) % 4];
      const c = ATLAS_CELLS[cell];
      groveItems.push({x, y: yy, sh: 44, cell, kind: 'boulder', box: {w: bw, h: c.h * bw / c.w}});
    } else {
      groveItems.push({x, y: yy, svg: boulderSVG(bw), sh: 44});
    }
  }
  const groves = {};
  groveItems.forEach(it => {
    const key = Math.floor(it.y / 260) + '|' + (it.x < CX ? 'L' : 'R');
    (groves[key] = groves[key] || []).push(it);
  });
  Object.values(groves).forEach(items => {
    // anchor at the NEAREST tree: the whole cluster renders at one depth, and
    // rendering slightly-far trees at a slightly-near scale is invisible,
    // while the reverse (far anchor) shrinks whole groves into the horizon
    const baseY = Math.max(...items.map(i => i.y));
    const yMin = Math.min(...items.map(i => i.y));
    const baseX = items.reduce((a, i) => a + i.x, 0) / items.length;
    const el = document.createElement('div');
    el.className = 'grove';
    el.style.left = baseX + 'px'; el.style.top = baseY + 'px';
    el.innerHTML = items
      .sort((a, b) => a.y - b.y)   // farther trees paint first
      .map(i => i.cell
        ? `<div class="gi sp ${i.kind}" data-cell="${i.cell}"${i.season ? ` data-season="${i.season}"` : ''} ` +
          `style="left:${(i.x - baseX).toFixed(0)}px; bottom:${((baseY - i.y) * GI_F).toFixed(0)}px; ` +
          `width:${i.box.w.toFixed(0)}px; height:${i.box.h.toFixed(0)}px;">${spriteMarkup(i.cell, i.box.w, i.box.h)}</div>`
        : `<div class="gi" style="left:${(i.x - baseX).toFixed(0)}px; bottom:${((baseY - i.y) * GI_F).toFixed(0)}px;">${i.svg}</div>`)
      .join('');
    map.appendChild(el);
    props.push({el, y: baseY, yMin, yMax: baseY});
    items.forEach(i => addShadow(i.x, i.y, i.sh));
  });

  /* home at the trailhead */
  const homeX = pts[0].x + 300, homeY = pts[0].y + 430;
  prop(homeX, homeY, `
    <svg width="260" height="230" viewBox="0 0 260 230">
      <rect x="30" y="96" width="200" height="118" rx="6" fill="#C9B68F"/>
      <path d="M14 104 L130 22 L246 104 Z" fill="#8A6A44"/>
      <rect x="172" y="34" width="22" height="52" rx="3" fill="#9A7E52"/>
      <rect x="112" y="150" width="40" height="64" rx="4" fill="#7C6540"/>
      <circle cx="145" cy="184" r="3" fill="#C9A227"/>
      <rect class="win" x="54" y="126" width="34" height="30" rx="3" fill="#E8E4CE"/>
      <rect class="win" x="176" y="126" width="34" height="30" rx="3" fill="#E8E4CE"/>
      <circle class="porch" cx="132" cy="132" r="7" fill="#F5DE9C"
              style="filter:drop-shadow(0 0 10px #F5DE9C)"/>
      <rect x="20" y="212" width="220" height="10" rx="5" fill="#8F7B57" opacity=".6"/>
    </svg>
    <div class="home-smoke" style="left:178px; top:18px;"></div>
    <div class="home-smoke" style="left:182px; top:22px; animation-delay:2.4s;"></div>
    <div class="home-smoke" style="left:174px; top:20px; animation-delay:4.6s;"></div>`,
    {shadow: 130, z: 3});

  /* holidays: only where that month has real room on the trail */
  const startYear = Math.floor(J.trailhead_month / 12), endYear = Math.floor(J.now_month / 12);
  for (let yr = startYear; yr <= endYear; yr++){
    [[9, 'pumpkin'], [11, 'lights'], [1, 'hearts']].forEach(([m, kind]) => {
      const mk = yr * 12 + m;
      if (mk < J.trailhead_month || mk > J.now_month || spanPx(mk) < 70) return;
      const yy = yOfMonth(mk + 0.5);
      const tx = trailXAtY(yy);
      const x = tx + (tx > CX ? -1 : 1) * (250 + rnd() * 90);
      if (kind === 'pumpkin'){
        const g = document.createElementNS(NS, 'g');
        g.innerHTML = `<g transform="translate(${x},${yy})">
          <ellipse cx="0" cy="0" rx="20" ry="15" fill="#C97A2E"/>
          <ellipse cx="0" cy="0" rx="9" ry="15" fill="none" stroke="#B36622" stroke-width="3"/>
          <rect x="-3" y="-21" width="6" height="9" rx="2" fill="#6E8043"/></g>`;
        bands[bandFor(yy)].detail.appendChild(g);
      } else if (kind === 'lights'){
        prop(x, yy, litTreeMarkup(150), {shadow: 42});
      } else {
        const g = document.createElementNS(NS, 'g');
        g.innerHTML = `<g transform="translate(${x},${yy})" fill="#D97795">
          <path d="M0 6 C-8 -4 -20 2 0 16 C20 2 8 -4 0 6 Z"/>
          <path d="M26 12 C20 5 12 9 26 19 C40 9 32 5 26 12 Z" opacity=".8"/></g>`;
        bands[bandFor(yy)].detail.appendChild(g);
      }
    });
  }

  /* birthdays: a cupcake in that dog's colour, each year with room */
  J.pets.forEach(p => {
    const born = ymKey(p.born); if (born == null) return;
    const from = Math.max(ymKey(p.joined) ?? born, J.trailhead_month);
    const until = ymKey(p.passed) ?? J.now_month;
    for (let mk = born; mk <= until; mk += 12){
      if (mk < from || spanPx(mk) < 70) continue;
      const yy = yOfMonth(mk + 0.4);
      const tx = trailXAtY(yy);
      const x = tx + (tx > CX ? 1 : -1) * (230 + rnd() * 70);
      const yrs = (mk - born) / 12;
      if (yrs < 1) continue;
      const el = prop(x, yy, `
        <svg width="46" height="58" viewBox="0 0 46 58" role="img" aria-label="${esc(p.name)} turns ${yrs}">
          <rect x="10" y="30" width="26" height="20" rx="4" fill="#C9B68F"/>
          <path d="M8 30 Q23 12 38 30 Z" fill="${p.color}"/>
          <rect x="21" y="8" width="4" height="12" rx="2" fill="#EFE3C2"/>
          <circle cx="23" cy="6" r="4" fill="#EFC94C"/>
        </svg>`, {shadow: 26, cls: 'bday'});
      el.title = `${p.name} turns ${yrs}`;
    }
  });

  /* family lore, hidden near their dates */
  const LORE_ART = {
    'tennis-ball': `<svg width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="14" fill="#C9D64B"/>
      <path d="M5 10 Q17 17 5 25 M29 10 Q17 17 29 25" stroke="#F4F6E2" stroke-width="2.5" fill="none"/></svg>`,
    'slipper': `<svg width="44" height="30" viewBox="0 0 44 30"><path d="M4 22 Q2 8 16 8 L30 8 Q42 8 42 18 Q42 26 32 26 L10 26 Q4 26 4 22 Z" fill="#9A7E52"/>
      <path d="M16 8 Q28 4 30 8 L30 16 L16 16 Z" fill="#C9B68F"/></svg>`,
    'bone': `<svg width="42" height="22" viewBox="0 0 42 22"><path d="M9 5 A5 5 0 1 0 9 17 L33 17 A5 5 0 1 0 33 5 A5 5 0 1 0 27 5 L15 5 A5 5 0 1 0 9 5 Z" fill="#EFEAD6" stroke="#D6CBA8" stroke-width="1.5"/></svg>`,
    'stick': `<svg width="48" height="18" viewBox="0 0 48 18"><path d="M2 12 L34 6 L46 2 M22 8 L28 14" stroke="#84704C" stroke-width="5" stroke-linecap="round" fill="none"/></svg>`,
    'sock': `<svg width="28" height="38" viewBox="0 0 28 38"><path d="M8 2 L22 2 L22 20 Q22 34 10 34 Q2 34 2 26 Q2 20 8 18 Z" fill="#C9718A"/><rect x="8" y="2" width="14" height="7" fill="#EFEAD6"/></svg>`,
    'bowl': `<svg width="40" height="24" viewBox="0 0 40 24"><path d="M2 6 L38 6 L32 20 Q20 24 8 20 Z" fill="#5B7FA6"/><ellipse cx="20" cy="6" rx="18" ry="4" fill="#7FA0C2"/></svg>`,
    'party-hat': `<svg width="30" height="36" viewBox="0 0 30 36"><path d="M15 2 L28 32 L2 32 Z" fill="#D98BA4"/><circle cx="15" cy="3" r="3" fill="#EFC94C"/><circle cx="10" cy="22" r="2.4" fill="#EFEAD6"/><circle cx="19" cy="14" r="2" fill="#EFEAD6"/></svg>`
  };
  (J.lore || []).forEach((item, i) => {
    const yy = yOfMonth(item.month + 0.5);
    const tx = trailXAtY(yy);
    const x = tx + ((i % 2 ? 1 : -1) * (280 + rnd() * 120));
    const pet = item.dog ? petBy[item.dog] : null;
    const el = prop(x, yy, `
      ${LORE_ART[item.item] || LORE_ART.bone}
      <div class="lore-chip" style="--acc:${pet ? pet.color : 'var(--gold)'}">
        ${pet ? `<span class="lwho">${esc(pet.name)}</span>` : ''}${esc(item.note)}
      </div>`, {shadow: 20, cls: 'lore critter'});
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'A hidden memory');
    const toggle = () => el.classList.toggle('open');
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter'){ ev.preventDefault(); toggle(); }});
  });

  /* critters */
  const squirrelD = PLEN * 0.34;
  {
    const p = atDist(squirrelD);
    const x = p.x + (p.x > CX ? -1 : 1) * 420;
    const el = prop(x, p.y, `
      ${GROVE_SPRITES ? spriteBoxMarkup('spruce-tall-b', 170, 'spruce') : pineSVG(170, '#4F7348', '#3F5E3B')}
      <svg class="sq" width="30" height="26" viewBox="0 0 30 26"
           style="position:absolute; left:50%; bottom:0; margin-left:-6px;">
        <path d="M20 22 Q30 16 26 6 Q22 -2 16 6 Q20 14 14 20 Z" fill="#8A5A34"/>
        <ellipse cx="10" cy="18" rx="8" ry="6" fill="#9A6A40"/>
        <circle cx="5" cy="14" r="4" fill="#9A6A40"/><circle cx="3.6" cy="13" r="1" fill="#2E2418"/>
      </svg>`, {shadow: 50, cls: 'squirrel critter'});
    el.tabIndex = 0; el.setAttribute('aria-label', 'A squirrel');
    el.addEventListener('click', () => {
      el.classList.add('up');
      setTimeout(() => el.classList.remove('up'), 4200);
    });
  }
  if (pondPos){
    const el = prop(pondPos.x - 250, pondPos.y + 60, `
      <svg class="fr" width="30" height="22" viewBox="0 0 30 22">
        <ellipse cx="15" cy="15" rx="12" ry="7" fill="#6E8F4E"/>
        <circle cx="8" cy="8" r="4" fill="#6E8F4E"/><circle cx="20" cy="8" r="4" fill="#6E8F4E"/>
        <circle cx="8" cy="7" r="1.4" fill="#20281A"/><circle cx="20" cy="7" r="1.4" fill="#20281A"/>
      </svg>`, {shadow: 16, cls: 'frog critter'});
    el.tabIndex = 0; el.setAttribute('aria-label', 'A frog');
    el.addEventListener('click', () => {
      el.classList.add('hop');
      setTimeout(() => el.classList.remove('hop'), 1400);
    });
  }
  let deer = null, deerY = 0;
  {
    const d = PLEN * 0.56, p = atDist(d);
    const x = p.x + (p.x > CX ? -1 : 1) * 560;
    deerY = p.y;
    deer = prop(x, p.y, `
      <svg width="80" height="86" viewBox="0 0 80 86">
        <g class="head-down">
          <ellipse cx="42" cy="46" rx="24" ry="14" fill="#9A7048"/>
          <path d="M22 50 Q10 58 8 70" stroke="#9A7048" stroke-width="8" stroke-linecap="round" fill="none"/>
          <circle cx="10" cy="70" r="6" fill="#9A7048"/>
        </g>
        <g class="head-up">
          <ellipse cx="42" cy="48" rx="24" ry="14" fill="#9A7048"/>
          <path d="M24 44 Q18 26 20 14" stroke="#9A7048" stroke-width="8" stroke-linecap="round" fill="none"/>
          <circle cx="20" cy="12" r="7" fill="#9A7048"/>
          <path d="M16 8 L10 0 M22 6 L20 -4" stroke="#7C5A38" stroke-width="3" stroke-linecap="round"/>
        </g>
        <g stroke="#7C5A38" stroke-width="5" stroke-linecap="round">
          <line x1="30" y1="56" x2="30" y2="82"/><line x1="52" y1="56" x2="52" y2="82"/>
        </g>
        <path d="M64 42 L70 36" stroke="#9A7048" stroke-width="5" stroke-linecap="round"/>
      </svg>`, {shadow: 40, cls: 'deer'});
  }

  /* butterflies near flower patches */
  if (!reduced){
    (LITE ? [0.24] : [0.24, 0.68]).forEach((f, i) => {
      const p = atDist(PLEN * f);
      const x = p.x + (i ? -1 : 1) * 330;
      prop(x, p.y, `
        <div class="flutter" style="animation-delay:-${i*7}s">
          <svg width="16" height="14" viewBox="0 0 16 14">
            <path d="M8 7 Q1 0 1 6 Q1 11 8 7 Q15 0 15 6 Q15 11 8 7 Z" fill="${i ? '#C9A227' : '#C9718A'}"/>
          </svg>
        </div>`, {});
    });
  }

  /* ---------- golden paw hunt ---------- */
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .goldpaw{position:absolute; width:40px; height:40px; cursor:pointer; transform:translate(-50%,-50%);
      transition:transform .6s, opacity .6s; z-index:2;}
    .goldpaw svg{filter:drop-shadow(0 0 6px rgba(201,162,39,.75));}
    .goldpaw.found{transform:translate(-50%,-50%) scale(2.2); opacity:0; pointer-events:none;}`;
  document.head.appendChild(styleEl);
  const PAW_SVG = `<svg width="40" height="40" viewBox="0 0 40 40" fill="#C9A227">
    <ellipse cx="20" cy="25" rx="8" ry="9"/>
    <circle cx="10" cy="15" r="4"/><circle cx="16" cy="10" r="4"/>
    <circle cx="24" cy="10" r="4"/><circle cx="30" cy="15" r="4"/></svg>`;
  const PAW_KEY = 'packPawHunt.v1';
  const PAW_FRACS = [0.06, 0.17, 0.29, 0.42, 0.55, 0.70, 0.86];
  let found = [];
  try { found = JSON.parse(localStorage.getItem(PAW_KEY) || '[]'); } catch (e) { found = []; }
  const pawCounter = document.getElementById('pawcount');
  const pawMsg = document.getElementById('pawmsg');
  function pawUI(){
    pawCounter.textContent = `${found.length} / ${PAW_FRACS.length}`;
    document.getElementById('pawcounter').classList.toggle('done', found.length === PAW_FRACS.length);
  }
  PAW_FRACS.forEach((f, i) => {
    const p = atDist(PLEN * f);
    const off = (i % 2 ? -1 : 1) * (240 + ((i * 53) % 3) * 70);
    const el = document.createElement('div');
    el.className = 'goldpaw' + (found.includes(i) ? ' found' : '');
    el.style.left = (p.x + off) + 'px';
    el.style.top = (p.y + 60) + 'px';
    el.innerHTML = PAW_SVG;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'A golden paw print');
    el.addEventListener('click', () => {
      if (found.includes(i)) return;
      found.push(i);
      try { localStorage.setItem(PAW_KEY, JSON.stringify(found)); } catch (e) {}
      el.classList.add('found');
      pawUI();
      if (found.length === PAW_FRACS.length) celebrate();
    });
    map.appendChild(el);
  });
  pawUI();
  function celebrate(){
    if (reduced) return;
    const colors = ['#C9A227', '#8A4E76', '#C9718A', '#3F7D77', '#C98A3D'];
    for (let i = 0; i < 44; i++){
      const c = document.createElement('div');
      c.className = 'confetti';
      const sz = 6 + rnd() * 8;
      c.style.cssText = `left:${(rnd()*100).toFixed(1)}vw; width:${sz}px; height:${sz*0.6}px;
        background:${colors[i % colors.length]}; border-radius:2px;
        --dur:${(2.4 + rnd()*2).toFixed(2)}s; --spin:${(rnd()*720-360).toFixed(0)}deg;
        animation-delay:${(rnd()*0.8).toFixed(2)}s;`;
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 6000);
    }
  }

  /* ---------- "you are here": paw prints walking the trail ---------- */
  const PAW_G = '<ellipse cx="0" cy="4" rx="5" ry="6"/><circle cx="-5.5" cy="-3.5" r="2.2"/>'
    + '<circle cx="-1.8" cy="-6.5" r="2.2"/><circle cx="1.8" cy="-6.5" r="2.2"/><circle cx="5.5" cy="-3.5" r="2.2"/>';
  const pawMark = document.createElement('div');
  pawMark.className = 'pawmark';
  pawMark.innerHTML = `<svg width="86" height="52" viewBox="0 0 86 52" style="position:absolute; left:-43px; top:-26px;">
    <g fill="#C9A227" stroke="#6B5C40" stroke-width="1">
      <g opacity=".3" transform="translate(12,33) rotate(90) scale(.6)">${PAW_G}</g>
      <g opacity=".62" transform="translate(40,19) rotate(90) scale(.72)">${PAW_G}</g>
      <g transform="translate(70,33) rotate(90) scale(.85)">${PAW_G}</g>
    </g></svg>`;
  map.appendChild(pawMark);

  /* ---------- narrative billboards ---------- */
  const bbs = [], campBbs = [];
  function bb(cls, x, y, html, shadowR){
    const el = document.createElement('div');
    el.className = 'bb ' + cls;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.innerHTML = html;
    map.appendChild(el);
    if (shadowR) addShadow(x, y, shadowR);
    bbs.push({el, x, y});
    return el;
  }

  pts.forEach(({x, y, e}) => {
    if (e.type === 'union'){
      const [a, b] = e.pets.map(s => petBy[s]);
      bb('bb-union', x, y, `
        <span class="date-chip">${monthLabel(e.month)} &middot; The Union</span>
        <svg class="arc" width="420" height="86" viewBox="0 0 420 86">
          <path d="M 60 84 C 130 6, 200 2, 210 2" fill="none" stroke="${a.color}" stroke-width="5" stroke-linecap="round"/>
          <path d="M 360 84 C 290 6, 220 2, 210 2" fill="none" stroke="${b.color}" stroke-width="5" stroke-linecap="round"/>
          <circle cx="210" cy="4" r="9" fill="#C9A227"/>
        </svg>
        <div class="ports">
          <div class="p" style="--acc:${a.color}"><img src="${a.headshot_thumb}" alt="${esc(a.name)}"><div class="nm">${esc(a.name)}</div></div>
          <div class="p" style="--acc:${b.color}"><img src="${b.headshot_thumb}" alt="${esc(b.name)}"><div class="nm">${esc(b.name)}</div></div>
        </div>
        <p class="sub">Two paths joined at the foot of the valley, and the trail began.</p>`, 210);
    }
    else if (e.type === 'arrival'){
      const p = petBy[e.pet];
      const age = ageStr(p.born, e.month);
      bb('bb-arrival', x, y, `
        <span class="date-chip" style="--acc:${p.color}">${monthLabel(e.month)} &middot; ${esc(p.name)} joins</span>
        <div style="margin-top:10px"><img src="${p.headshot_thumb}" alt="${esc(p.name)}" style="border-color:${p.color}"></div>
        <div class="nm">${esc(p.name)}</div>
        ${age ? `<p class="age">${age} when she joined the pack</p>` : ''}`, 140);
    }
    else if (e.type === 'camp'){
      const feat = e.photos[0];
      const featPet = petBy[feat.dog];
      const el = bb('bb-camp', x, y, `
        <span class="date-chip" style="--acc:${featPet ? featPet.color : 'var(--gold)'}">${e.label}</span>
        <div class="frame"><img src="${feat.thumb}" alt="${esc(e.label)}" loading="lazy">
          <div class="count">${e.photos.length === 1 ? '1 photo' : e.photos.length + ' photos'}</div></div>
        <div class="post"></div>`, 130);
      el.tabIndex = 0;
      el._photos = e.photos;
      el.addEventListener('click', () => openFan(el));
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); openFan(el); }});
      campBbs.push({el, y});
    }
    else if (e.type === 'passing'){
      const p = petBy[e.pet];
      bb('bb-lantern', x, y, `
        <div class="halo"></div>
        <img src="${p.headshot_thumb}" alt="${esc(p.name)}">
        <div class="nm">${esc(p.name)}</div>
        <div class="yrs">${yearOf(p.born)} &ndash; ${yearOf(p.passed)}</div>
        <p class="line">She walks with us in every season.</p>`, 130);
    }
    else if (e.type === 'today'){
      const living = J.pets.filter(p => !p.passed);
      const remembered = J.pets.filter(p => p.passed);
      bb('bb-today', x, y, `
        ${remembered.length ? '<div class="star">&#10022;</div>' : ''}
        <div class="row">${living.map(p =>
          `<img src="${p.headshot_thumb}" alt="${esc(p.name)}" style="border-color:${p.color}">`).join('')}</div>
        <h2>&hellip;and the trail goes on.</h2>
        <p>${living.map(p => p.name).join(', ').replace(/, ([^,]*)$/, ' and $1')} walk it today${remembered.length ? ' — ' + remembered.map(p => p.name).join(' and ') + ' lights the way' : ''}.</p>`, 210);
    }
  });

  /* The photo fan lives in a fixed overlay ABOVE the 3D world — inside the
     world, nearer scenery would depth-sort in front of the photos. */
  const fanOv = document.createElement('div');
  fanOv.id = 'fanOverlay';
  document.body.appendChild(fanOv);
  let fanOpenEl = null, fanScrollY = 0;
  function closeFan(){
    if (!fanOpenEl) return;
    fanOpenEl = null;
    fanOv.classList.remove('on');
    fanOv.innerHTML = '';
  }
  function openFan(el){
    if (fanOpenEl === el){ closeFan(); return; }
    closeFan();
    fanOpenEl = el; fanScrollY = scrollY;
    const r = el.getBoundingClientRect();
    const photos = el._photos;
    const shown = photos.slice(0, 8);
    const scaleF = Math.min(1, innerWidth / 580);
    const rad = 205 * scaleF;
    const margin = Math.min(rad + 80, innerWidth / 2 - 8);
    const ax = clamp(r.left + r.width / 2, margin, innerWidth - margin);
    const ay = clamp(r.top + 44, 200, innerHeight - 110);
    const box = document.createElement('div');
    box.className = 'fanbox';
    box.style.left = ax + 'px'; box.style.top = ay + 'px';
    shown.forEach((ph, i) => {
      const pet = petBy[ph.dog];
      const n = shown.length, spread = Math.min(165, 50 + n * 15);
      const ang = (n === 1) ? 0 : (-spread / 2 + spread * i / (n - 1));
      const fp = document.createElement('button');
      fp.className = 'fanpop';
      fp.style.setProperty('--fx', (Math.sin(ang * Math.PI / 180) * rad).toFixed(0) + 'px');
      fp.style.setProperty('--fy', (-46 - Math.cos(ang * Math.PI / 180) * rad * 0.62).toFixed(0) + 'px');
      fp.style.setProperty('--acc', pet ? pet.color : 'var(--gold)');
      fp.style.transitionDelay = (i * 0.04) + 's';
      fp.setAttribute('aria-label', 'View photo');
      fp.innerHTML = `<img src="${ph.thumb}" alt="" loading="lazy">`;
      fp.addEventListener('click', ev => { ev.stopPropagation(); openLightbox(photos, photos.indexOf(ph)); });
      box.appendChild(fp);
    });
    if (photos.length > shown.length){
      const more = document.createElement('button');
      more.className = 'fanmore';
      more.textContent = 'all ' + photos.length + ' photos';
      more.addEventListener('click', ev => { ev.stopPropagation(); openLightbox(photos, 0); });
      box.appendChild(more);
    }
    fanOv.appendChild(box);
    requestAnimationFrame(() => fanOv.classList.add('on'));
  }
  fanOv.addEventListener('click', ev => { if (ev.target === fanOv) closeFan(); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape'){ closeFan(); closeLightbox(); }
  });

  /* ---------- lightbox ---------- */
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lb-img');
  const lbWho = document.getElementById('lb-who');
  const lbDate = document.getElementById('lb-date');
  const lbCap = document.getElementById('lb-cap');
  let lbSet = [], lbIdx = 0;
  function openLightbox(photos, idx){
    lbSet = photos; lbIdx = idx; renderLb();
    lb.classList.add('open');
  }
  function renderLb(){
    const ph = lbSet[lbIdx]; if (!ph) return;
    const pet = petBy[ph.dog];
    lbImg.src = ph.large;
    lbWho.textContent = pet ? pet.name : ph.dog;
    lbWho.style.setProperty('--acc', pet ? pet.color : 'var(--gold)');
    const mk = ymKey(ph.taken);
    const age = pet ? ageStr(pet.born, mk) : '';
    lbDate.textContent = (mk != null ? monthLabel(mk) : '') + (age ? ' · ' + age : '');
    lbCap.textContent = ph.caption || '';
    lbCap.style.display = ph.caption ? 'block' : 'none';
  }
  function closeLightbox(){ lb.classList.remove('open'); lbImg.src = ''; }
  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  lb.addEventListener('click', ev => { if (ev.target === lb) closeLightbox(); });
  document.getElementById('lb-prev').addEventListener('click', ev => { ev.stopPropagation(); lbIdx = (lbIdx - 1 + lbSet.length) % lbSet.length; renderLb(); });
  document.getElementById('lb-next').addEventListener('click', ev => { ev.stopPropagation(); lbIdx = (lbIdx + 1) % lbSet.length; renderLb(); });
  document.addEventListener('keydown', ev => {
    if (!lb.classList.contains('open')) return;
    if (ev.key === 'ArrowLeft'){ lbIdx = (lbIdx - 1 + lbSet.length) % lbSet.length; renderLb(); }
    if (ev.key === 'ArrowRight'){ lbIdx = (lbIdx + 1) % lbSet.length; renderLb(); }
  });

  /* ---------- minimap ---------- */
  const mmBox = document.getElementById('minimap');
  const small = innerWidth <= 700;
  const MMW = small ? 54 : 74;
  const MMH = small ? Math.min(innerHeight * 0.34, 280) : Math.min(innerHeight * 0.56, 460);
  const mmX = x => 10 + (x / W) * (MMW - 20);
  const mmY = yy => 8 + (yy / LEN) * (MMH - 16);
  let mmPath = `M ${mmX(pts[0].x)} ${mmY(pts[0].y)}`;
  for (let i = 1; i <= SAMPLES; i += 4) mmPath += ` L ${mmX(lut[i].x).toFixed(1)} ${mmY(lut[i].y).toFixed(1)}`;
  let marks = '';
  pts.forEach(({x, y, e}) => {
    const cx = mmX(x), cy = mmY(y);
    if (e.type === 'union') marks += `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="#C9A227" stroke-width="2.5"/>`;
    else if (e.type === 'arrival') marks += `<circle cx="${cx}" cy="${cy}" r="4" fill="${petBy[e.pet].color}"/>`;
    else if (e.type === 'passing') marks += `<text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="12" fill="#C9A227">&#10022;</text>`;
    else if (e.type === 'camp') marks += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="#6B5C40"/>`;
  });
  mmBox.innerHTML = `<svg width="${MMW}" height="${MMH}" viewBox="0 0 ${MMW} ${MMH}">
    <rect x="0" y="0" width="${MMW}" height="${MMH}" rx="12" fill="rgba(238,240,224,.82)" stroke="#D8D6BC"/>
    <path d="${mmPath}" fill="none" stroke="#8A795B" stroke-width="2" opacity=".7"/>
    ${marks}
    <circle id="mmCam" cx="${mmX(pts[0].x)}" cy="${mmY(pts[0].y)}" r="5.5" fill="#39422E" stroke="#F2F0E2" stroke-width="1.5"/>
  </svg>`;
  const mmCam = document.getElementById('mmCam');
  mmBox.addEventListener('click', ev => {
    const r = mmBox.getBoundingClientRect();
    const ty = clamp((ev.clientY - r.top - 8) / (MMH - 16), 0, 1) * LEN;
    const dist = distAtY(ty);
    const doc = document.documentElement;
    scrollTo({top: (dist / PLEN) * (doc.scrollHeight - innerHeight), behavior: reduced ? 'auto' : 'smooth'});
  });

  /* ---------- time of day, stars, weather ---------- */
  function timeMode(){
    const o = params.get('t');
    if (o === 'day' || o === 'dusk' || o === 'night') return o;
    const h = new Date().getHours();
    if (h >= 20 || h < 5) return 'night';
    if (h >= 17 || h < 8) return 'dusk';
    return 'day';
  }
  let mode = null;
  function applyMode(){
    const m = timeMode();
    if (m === mode) return;
    mode = m;
    document.body.classList.remove('t-day', 't-dusk', 't-night');
    document.body.classList.add('t-' + m);
    refreshAmbient();
  }
  const starsBox = document.getElementById('stars');
  for (let i = 0; i < 70; i++){
    const s = document.createElement('span');
    s.className = 'star';
    const size = (rnd() * 1.6 + 0.8).toFixed(1);
    s.style.cssText = `left:${(rnd()*100).toFixed(1)}%; top:${(rnd()*100).toFixed(1)}%;
      width:${size}px; height:${size}px; --o:${(rnd()*0.6+0.25).toFixed(2)};
      animation-delay:${(rnd()*4).toFixed(1)}s;`;
    starsBox.appendChild(s);
  }

  const weather = document.getElementById('weather');
  let weatherSeason = null;
  const W_GLYPH = {
    winter: () => `<svg width="7" height="7"><circle cx="3.5" cy="3.5" r="3" fill="#F5F7F1" opacity=".9"/></svg>`,
    autumn: () => `<svg width="12" height="9"><ellipse cx="6" cy="4.5" rx="5.5" ry="3.4" fill="${rnd() > 0.5 ? '#C08A3E' : '#A8792E'}"/></svg>`,
    spring: () => `<svg width="9" height="8"><ellipse cx="4.5" cy="4" rx="4" ry="2.8" fill="#E9BFCB"/></svg>`,
    summer: () => `<svg width="8" height="10"><circle cx="4" cy="3" r="2.6" fill="#F2F3E8" opacity=".85"/><line x1="4" y1="5" x2="4" y2="10" stroke="#E4E6D2" stroke-width="1"/></svg>`
  };
  function refreshAmbient(){
    if (reduced) return;
    weather.innerHTML = '';
    document.querySelectorAll('.firefly').forEach(f => f.remove());
    if (mode === 'night'){
      if (weatherSeason === 'summer' || weatherSeason === 'spring'){
        for (let i = 0; i < (LITE ? 5 : 9); i++){
          const f = document.createElement('div');
          f.className = 'firefly';
          f.style.cssText = `left:${(rnd()*96+2).toFixed(1)}vw; top:${(rnd()*46+46).toFixed(1)}vh;
            --dx:${(rnd()*80-40).toFixed(0)}px; --dy:${(rnd()*60-30).toFixed(0)}px;
            --dur:${(3+rnd()*4).toFixed(1)}s; animation-delay:-${(rnd()*5).toFixed(1)}s;`;
          document.body.appendChild(f);
        }
      }
      if (weatherSeason === 'winter') spawnParticles('winter', 10);
      return;
    }
    if (!weatherSeason) return;
    let density = {winter: 14, autumn: 12, spring: 10, summer: 6}[weatherSeason];
    if (LITE) density = Math.min(density, 6);
    spawnParticles(weatherSeason, density);
  }
  function spawnParticles(season, n){
    for (let i = 0; i < n; i++){
      const w = document.createElement('div');
      w.className = 'wpart';
      w.style.cssText = `left:${(rnd()*100).toFixed(1)}vw;
        --dur:${(season === 'winter' ? 9 + rnd()*7 : 6 + rnd()*6).toFixed(1)}s;
        --delay:-${(rnd()*10).toFixed(1)}s; --drift:${(rnd()*120-60).toFixed(0)}px;
        --spin:${(rnd()*360-180).toFixed(0)}deg;`;
      w.innerHTML = W_GLYPH[season]();
      weather.appendChild(w);
    }
  }

  /* rare bird flyover */
  function scheduleBird(){
    if (reduced) return;
    setTimeout(() => {
      if (!document.hidden && mode !== 'night'){
        const b = document.createElement('div');
        b.className = 'bird';
        b.style.cssText = `--fy:${(8 + rnd()*16).toFixed(1)}vh; --dur:${(10 + rnd()*5).toFixed(1)}s;`;
        b.innerHTML = `<svg width="26" height="12" viewBox="0 0 26 12">
          <path d="M1 8 Q7 1 13 7 Q19 1 25 8" stroke="#4A4A3C" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`;
        document.body.appendChild(b);
        setTimeout(() => b.remove(), 17000);
      }
      scheduleBird();
    }, 34000 + rnd() * 40000);
  }
  scheduleBird();

  /* ---------- soft sound (synthesised, off by default) ---------- */
  const soundBtn = document.getElementById('soundbtn');
  let audio = null, chirpTimer = null;
  function buildAudio(){
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain(); master.gain.value = 0.0; master.connect(ctx.destination);
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++){
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const windGain = ctx.createGain(); windGain.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.22;
    lfo.connect(lfoGain); lfoGain.connect(windGain.gain);
    src.connect(lp); lp.connect(windGain); windGain.connect(master);
    src.start(); lfo.start();
    master.gain.linearRampToValueAtTime(0.055, ctx.currentTime + 2);
    return {ctx, master};
  }
  function chirp(){
    if (!audio || audio.ctx.state !== 'running') return;
    const {ctx, master} = audio;
    const isNight = mode === 'night';
    if (weatherSeason === 'winter' && !isNight) return;
    const t0 = ctx.currentTime + 0.05;
    const n = isNight ? 5 : 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++){
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const t = t0 + i * (isNight ? 0.09 : 0.16 + Math.random() * 0.1);
      osc.frequency.setValueAtTime(isNight ? 4100 : 2900 + Math.random() * 500, t);
      if (!isNight) osc.frequency.exponentialRampToValueAtTime(2100, t + 0.11);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(isNight ? 0.018 : 0.03, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0008, t + (isNight ? 0.05 : 0.13));
      osc.connect(g); g.connect(master);
      osc.start(t); osc.stop(t + 0.2);
    }
  }
  function soundOn(){
    if (!audio) audio = buildAudio();
    audio.ctx.resume();
    soundBtn.classList.add('playing');
    soundBtn.setAttribute('aria-pressed', 'true');
    clearInterval(chirpTimer);
    chirpTimer = setInterval(() => { if (Math.random() < 0.55) chirp(); }, 5000);
    try { localStorage.setItem('packSound', 'on'); } catch (e) {}
  }
  function soundOff(){
    if (audio) audio.ctx.suspend();
    soundBtn.classList.remove('playing');
    soundBtn.setAttribute('aria-pressed', 'false');
    clearInterval(chirpTimer);
    try { localStorage.setItem('packSound', 'off'); } catch (e) {}
  }
  soundBtn.addEventListener('click', () => {
    soundBtn.classList.contains('playing') ? soundOff() : soundOn();
  });
  document.addEventListener('visibilitychange', () => {
    if (!audio) return;
    if (document.hidden) audio.ctx.suspend();
    else if (soundBtn.classList.contains('playing')) audio.ctx.resume();
  });

  /* ---------- U8: grass sway and creek flow, desktop only ----------
     KTD5: motion is a few small compositor-only elements, created only when
     the tier is not lite and the user has not asked for reduced motion (the
     CSS reduced-motion block also silences them, belt and braces), never
     inside a band SVG, never animating background-position. Sway clumps are
     billboard props (a .prop that counter-tilts like every other prop)
     whose inner element rotates a few degrees about its base; flow is one
     flat element per water body lying in the map plane, clipped to the
     water shape, whose inner strip of highlight tiles translates along the
     water. Both are registered in props so the existing cull hides them
     off camera. Placed after every other rnd() consumer so the seeded
     layout is identical with motion on or off. */
  const GRASS = ART['grass-clumps.webp'];
  const GRASS_URL = assetUrl('grass-clumps.webp'), HIGHLIGHT_URL = assetUrl('water-highlight.webp');
  const GRASS_CELLS = ((GRASS && GRASS.cells) || []);
  const MOTION = !LITE && !reduced && !GROUND_FLAT && GROUND_MOTION && !!GRASS_URL && !!HIGHLIGHT_URL && GRASS_CELLS.length >= 4;
  const swayPlaced = [];
  // A clump's own keep-out: a 128 x 64 billboard only has to stay out from
  // under a camp's 270 px frame and its post, not the 450 x 460 px zone the
  // trees need (their cluster bucket can anchor nearer than the event). A
  // clump farther away than the card is hidden behind it, so the far side
  // is short; the near side covers the card's projected foot.
  const grassClear = (x, y) => pts.some(p =>
    Math.abs(p.x - x) < 200 && (y < p.y ? p.y - y < 160 : y - p.y < 120));
  if (MOTION){
    const gw = GRASS.size[0], gh = GRASS.size[1];
    const clumpMarkup = () => {
      const n = 3 + Math.floor(rnd() * 3);   // 3..5 sprites
      let inner = '';
      for (let k = 0; k < n; k++){
        const c = GRASS_CELLS[Math.floor(rnd() * GRASS_CELLS.length)];
        const h = 40 + rnd() * 24, w = h * c.w / c.h;
        const x = 8 + k * (104 / n) + rnd() * 10;
        inner += `<svg x="${x.toFixed(0)}" y="${(64 - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="${c.x} ${c.y} ${c.w} ${c.h}">` +
          `<image width="${gw}" height="${gh}" href="${GRASS_URL}"/></svg>`;
      }
      return `<div class="sway-in" style="--dur:${(2.4 + rnd() * 1.6).toFixed(2)}s; --delay:-${(rnd() * 3).toFixed(2)}s; --amp:${(2.6 + rnd() * 2).toFixed(1)}deg;">` +
        `<svg width="128" height="64" viewBox="0 0 128 64">${inner}</svg></div>`;
    };
    bands.forEach(b => {
      const want = 2 + Math.floor(rnd() * 2);   // 2..3 clumps per band
      // Most trail-side spots sit inside a camp's keep-out (the camps line
      // the trail), so this needs many more tries than the tree loop, and
      // the offset range reaches past the keep-out's 450 px half-width so
      // the meadow beside a camp can still sway.
      let placed = 0, guard = 0;
      while (placed < want && guard++ < 48){
        const yy = b.y0 + 80 + rnd() * (BANDH - 160);
        if (yy < 120 || yy > LEN - 120) continue;
        const tx = trailXAtY(yy);
        const x = tx + (rnd() > 0.5 ? 1 : -1) * (95 + rnd() * 300);
        if (grassClear(x, yy)) continue;
        if (Math.abs(yy - creekY) < 150) continue;
        if (pondPos && Math.abs(pondPos.x - x) < 320 && Math.abs(pondPos.y - yy) < 230) continue;
        const el = prop(x, yy, clumpMarkup(), {cls: 'sway'});
        swayPlaced.push({x, y: yy, el});
        placed++;
      }
    });
    // Flow: the creek's water shape as a polygon (the same quadratic chain
    // as the creek path, offset +-30 px, inside the 64 px water stroke).
    const flowBody = (left, top, width, height, clip, dur = '9s') => {
      const el = document.createElement('div');
      el.className = 'prop flow';
      el.style.cssText = `left:${left}px; top:${top}px; width:${width}px; height:${height}px; clip-path:${clip}; --flow-dur:${dur};`;
      el.innerHTML = `<div class="flow-in" style="background-image:url('${HIGHLIGHT_URL}')"></div>`;
      map.appendChild(el);
      return el;
    };
    {
      const top = creekY - 60, left = -1100, width = W + 2200, height = 140;
      const up = [], down = [];
      // The bridge deck (cx +- 101 world px) is cut out of the clip by
      // collapsing the band to zero height across it, so highlights never
      // paint over the deck or the paw prints crossing it.
      const bx = cx;
      let px = -1100, py = creekY + 40;
      for (let x = -1000; x <= W + 1100; x += 300){
        const cx = x - 150, cy = creekCtrlY(x), ex = x, ey = creekY + 30;
        for (let t = 0.1; t <= 1.0001; t += 0.1){
          const mx = (1 - t) * (1 - t) * px + 2 * (1 - t) * t * cx + t * t * ex;
          const my = (1 - t) * (1 - t) * py + 2 * (1 - t) * t * cy + t * t * ey;
          // the trail crosses the creek at an angle and is 120 px wide plus
          // ink edges, so the cut follows the trail, not just the deck
          const onBridge = Math.abs(mx - bx) < 101 || trailCrossings(my).some(c => Math.abs(mx - c.x) < 150);
          up.push(`${(mx - left).toFixed(0)}px ${(my + (onBridge ? 30 : -30) - top).toFixed(0)}px`);
          down.unshift(`${(mx - left).toFixed(0)}px ${(my + 30 - top).toFixed(0)}px`);
        }
        px = ex; py = ey;
      }
      const el = flowBody(left, top, width, height, `polygon(${up.concat(down).join(', ')})`);
      props.push({el, y: creekY, yMin: creekY - 60, yMax: creekY + 60});
    }
    if (pondPos){
      // Still water: the pond's highlights crawl at a fifth of the creek's pace.
      const el = flowBody(pondPos.x - 230, pondPos.y - 130, 460, 260, 'ellipse(226px 126px at 50% 50%)', '45s');
      props.push({el, y: pondPos.y, yMin: pondPos.y - 130, yMax: pondPos.y + 130});
    }
  }
  window.__journeyMotion = { on: MOTION, sway: swayPlaced.map(s => ({x: s.x, y: s.y})) };

  /* ---------- camera ---------- */
  const intro = document.getElementById('intro');
  const meterYr = document.getElementById('meterYr');
  const endnote = document.getElementById('endnote');
  const zoom = document.getElementById('zoom');
  const ridge = document.getElementById('ridgeInner');
  const spacer = document.getElementById('spacer');
  spacer.style.height = Math.round(PLEN * 1.12 + innerHeight) + 'px';
  let lastIntro = null, lastLabel = '', lastMmx = -1, lastMmy = -1, lastEnd = null;
  let pendingSeason = null, seasonTimer = null;

  /* The camera is decoupled from the scrollbar: it glides toward the scroll
     target at a bounded speed. A fast fling becomes a quick smooth flight
     instead of a teleport, which caps how much fresh world must rasterize
     per frame — the difference between smooth and janky on impatient
     scrolling. */
  let camDist = 0, lastT = 0;
  // Capped ring of overlay-attach timestamps: the smoke script checks that
  // no long task starts within 100ms of any of these.
  const attachTimes = [];
  let frameCount = 0;

  function update(now){
    // Frame-time budget for the smoke script: timed from the top of
    // update() to its last line, since that is the whole per-frame cost this
    // engine controls — the gap between rAF callbacks is pinned to the
    // display's refresh rate and tells us nothing about our own work.
    const statT0 = performance.now();
    const doc = document.documentElement;
    const prog = clamp(scrollY / (doc.scrollHeight - innerHeight), 0, 1);
    const target = prog * PLEN;
    const dt = clamp(now - lastT, 8, 48);
    lastT = now;
    const gap = target - camDist;
    if (reduced || Math.abs(gap) < 0.5){
      camDist = target;
    } else {
      const maxStep = (Math.abs(gap) > 2800 ? 6.2 : 3.2) * dt;   // px per ms budget
      const step = gap * (1 - Math.exp(-dt / 150));
      camDist += clamp(step, -maxStep, maxStep);
      if (Math.abs(target - camDist) < 0.5) camDist = target;
    }
    const camProg = camDist / PLEN;
    const p = atDist(camDist);
    const ahead = atDist(camDist + 480);
    const camX = p.x + (ahead.x - p.x) * 0.45;
    const camY = p.y;

    const s = clamp(innerWidth / 1150, 0.52, 1);
    zoom.style.transform = `scale(${s.toFixed(3)})`;
    map.style.transform = `translate3d(${(-camX).toFixed(1)}px, ${(-camY).toFixed(1)}px, 0)`;
    if (ridge) ridge.style.transform = `translateX(${(-camX * 0.045).toFixed(1)}px)`;

    const arrived = camProg > 0.012;
    // Counted alongside the existing cull passes below (no extra walk) for
    // the __journeyStats surface-count hook at the bottom of this function.
    let aliveBbs = 0, aliveProps = 0, aliveBands = 0;
    let attachedOverlays = 0, missingOverlays = 0;
    bbs.forEach(b => {
      const on = arrived && b.y > camY - 1500 && b.y < camY + 800;
      if (on) aliveBbs++;
      if (on !== b.el.classList.contains('on')) b.el.classList.toggle('on', on);
    });
    props.forEach(pr => {
      const vis = pr.yMax > camY - 2400 && pr.yMax < camY + 900;
      if (vis) aliveProps++;
      if (vis === !pr.hidden) return;
      pr.hidden = !vis;
      pr.el.style.display = vis ? '' : 'none';
    });
    bands.forEach(b => {
      const vis = b.y0 < camY + 1700 && b.y0 + BANDH > camY - 2400;
      if (vis) aliveBands++;
      if (vis !== !b.hidden){
        b.hidden = !vis;
        b.svg.style.display = vis ? '' : 'none';
      }
      // Lookahead is the visibility window widened by one BANDH on
      // each side, attached and detached only on a state change, same guard
      // pattern as b.hidden above. Reduced motion does NOT widen this
      // further — see the preload block above for how that profile is
      // handled instead.
      //
      // Worst case: band tops fall in an open interval of 4100 + 2*1600 px
      // (visibility) + 2*1600 px (lookahead) = 8900 px, so at most
      // ceil(8900/1600) = 6 bands are attached at once; the visibility
      // window alone gives ceil(5700/1600) = 4 alive. The smoke test asserts
      // the 6-band bound.
      if (GROUND_FLAT) return;
      const look = LOOKAHEAD_BANDS * BANDH;
      const ahead = b.y0 < camY + 1700 + look && b.y0 + BANDH > camY - 2400 - look;
      if (ahead !== b.attached){
        b.attached = ahead;
        if (ahead){
          b.attachedAt = statT0;
          attachTimes.push(b.attachedAt);
          if (attachTimes.length > 64) attachTimes.shift();
          b.overlayState = 'loading'; b.dirtState = 'loading';
          if (b.overlayUrl) b.inkImgs.forEach(im => im.setAttribute('href', b.overlayUrl));
          if (SNOW_URL) b.snowImgs.forEach(im => im.setAttribute('href', SNOW_URL));
          if (DIRT_URL) b.dirtImg.setAttribute('href', DIRT_URL);
          if (ATLAS_URL) b.detailImgs.forEach(im => im.setAttribute('href', ATLAS_URL));
        } else {
          b.inkImgs.forEach(im => im.removeAttribute('href'));
          b.snowImgs.forEach(im => im.removeAttribute('href'));
          b.dirtImg.removeAttribute('href');
          b.detailImgs.forEach(im => im.removeAttribute('href'));
        }
      }
      if (b.attached) attachedOverlays++;
      if (vis && b.attached && statT0 - b.attachedAt > 1000){
        // Same detector as before (a visible, long-attached band that hasn't
        // reported 'painted'), extended to the dirt-trail pattern and — for
        // bands that actually place atlas sprites — the shared tree/rock
        // atlas, so a failed dirt or atlas tile is caught exactly like a
        // failed ground overlay.
        const atlasMissing = b.detailImgs.length > 0 && atlasState !== 'painted';
        if (b.overlayState !== 'painted' || b.dirtState !== 'painted' || atlasMissing) missingOverlays++;
      }
    });

    {
      const back = atDist(camDist - 60);
      const ang = Math.atan2(p.y - back.y, p.x - back.x) * 180 / Math.PI;
      pawMark.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${ang.toFixed(1)}deg)`;
    }
    campBbs.forEach(c => {
      const here = Math.abs(c.y - camY) < 260;
      if (here !== c.el.classList.contains('here')) c.el.classList.toggle('here', here);
    });

    if (deer){
      const near = Math.abs(deerY - camY) < 640;
      if (near !== deer.classList.contains('alert')) deer.classList.toggle('alert', near);
    }

    if (prog < 0.07 || lastIntro !== true){
      intro.style.opacity = 1 - clamp(prog / 0.05, 0, 1);
      const hide = prog > 0.055;
      if (hide !== lastIntro){ lastIntro = hide; intro.style.visibility = hide ? 'hidden' : 'visible'; }
    }

    const mk = Math.round(monthAtY(camY));
    const label = camProg > 0.985 ? 'Today' : monthLabel(mk);
    if (label !== lastLabel){ lastLabel = label; meterYr.textContent = label; }

    const season = SEASON_OF(mk);
    if (season !== pendingSeason){
      pendingSeason = season;
      clearTimeout(seasonTimer);
      seasonTimer = setTimeout(() => {
        if (pendingSeason !== weatherSeason){ weatherSeason = pendingSeason; refreshAmbient(); }
      }, 450);
    }

    const mcx = Math.round(mmX(p.x)), mcy = Math.round(mmY(p.y));
    if (mcx !== lastMmx || mcy !== lastMmy){
      lastMmx = mcx; lastMmy = mcy;
      mmCam.setAttribute('cx', mcx); mmCam.setAttribute('cy', mcy);
    }
    const end = camProg > 0.965;
    if (end !== lastEnd){ lastEnd = end; endnote.classList.toggle('on', end); }

    if (fanOpenEl && Math.abs(scrollY - fanScrollY) > 90) closeFan();

    // Smoke-test hook: a plain object the browser smoke script
    // polls, so the pre-art baseline is measured with the same instrument
    // later units (overlays, motion) will be judged against. aliveBands and
    // aliveSurfaces reuse the counts above rather than re-walking the DOM;
    // aliveSurfaces = bands + props (which already holds groves) + billboards.
    window.__journeyStats = {
      camY,
      mk, season,  // lets the smoke script locate a fixture camp by month
      aliveBands,
      aliveSurfaces: aliveBands + aliveProps + aliveBbs,
      attachedOverlays,   // both 0 in flat mode: nothing is ever attached
      missingOverlays,
      attachTimes,
      updateMs: performance.now() - statT0,
      frames: ++frameCount,
      flat: GROUND_FLAT,
    };
  }

  /* keep animating until the camera has caught up with the scrollbar */
  let rafOn = false;
  function frame(now){
    update(now);
    const doc = document.documentElement;
    const target = clamp(scrollY / (doc.scrollHeight - innerHeight), 0, 1) * PLEN;
    if (Math.abs(target - camDist) > 0.5) requestAnimationFrame(frame);
    else rafOn = false;
  }
  const kick = () => {
    if (!rafOn){ rafOn = true; lastT = performance.now(); requestAnimationFrame(frame); }
  };
  addEventListener('scroll', kick, {passive: true});
  addEventListener('resize', kick);
  applyMode();
  setInterval(applyMode, 10 * 60 * 1000);
  // start at the scroll-restored position — no fly-in on refresh
  camDist = clamp(scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight), 0, 1) * PLEN;
  lastT = performance.now();
  update(lastT);
})();

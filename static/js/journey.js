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
  let layoutY = LEN - PAD_BOT, side = 1;
  evs.forEach((e, i) => {
    if (i > 0) layoutY -= gaps[i-1];
    let x = CX;
    if (e.type !== 'union' && e.type !== 'today'){
      x = CX + side * AMP * (0.72 + 0.28 * ((i * 37) % 10) / 10);
      side = -side;
    }
    pts.push({x, y: layoutY, e});
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
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', LEN);
  svg.setAttribute('viewBox', `0 0 ${W} ${LEN}`);
  map.appendChild(svg);

  const defs = document.createElementNS(NS, 'defs');
  const grad = document.createElementNS(NS, 'linearGradient');
  grad.id = 'seasons';
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1','0'); grad.setAttribute('y1','0');
  grad.setAttribute('x2','0'); grad.setAttribute('y2', LEN);
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
  stops.forEach(s => {
    const st = document.createElementNS(NS, 'stop');
    st.setAttribute('offset', (s.off * 100).toFixed(2) + '%');
    st.setAttribute('stop-color', s.color);
    grad.appendChild(st);
  });
  defs.appendChild(grad); svg.appendChild(defs);

  const ground = document.createElementNS(NS, 'rect');
  ground.setAttribute('x', -2400); ground.setAttribute('y', -800);
  ground.setAttribute('width', W + 4800); ground.setAttribute('height', LEN + 1600);
  ground.setAttribute('fill', 'url(#seasons)');
  svg.appendChild(ground);

  /* trail geometry */
  let dStr = `M ${pts[0].x} ${pts[0].y + 700} L ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++){
    const a = pts[i-1], b = pts[i], g = (a.y - b.y) * 0.5;
    dStr += ` C ${a.x} ${a.y - g}, ${b.x} ${b.y + g}, ${b.x} ${b.y}`;
  }
  dStr += ` L ${pts[pts.length-1].x} ${pts[pts.length-1].y - 90}`;

  const guideProbe = document.createElementNS(NS, 'path');
  guideProbe.setAttribute('d', dStr); guideProbe.setAttribute('fill', 'none');
  svg.appendChild(guideProbe);
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
  const creekY = gapList.length ? (gapList[0].y0 + gapList[0].y1) / 2 : LEN / 2;
  const pondG = gapList.length > 1 ? gapList[1] : null;

  const creekGroup = document.createElementNS(NS, 'g');
  {
    const cx = trailXAtY(creekY);
    let cd = `M -2300 ${creekY + 40}`;
    for (let x = -2200; x <= W + 2300; x += 300){
      cd += ` Q ${x - 150} ${creekY + ((x/300) % 2 ? 74 : -12)}, ${x} ${creekY + 30}`;
    }
    creekGroup.innerHTML =
      `<path d="${cd}" fill="none" stroke="#7FA8B5" stroke-width="64" stroke-linecap="round" opacity=".85"/>
       <path d="${cd}" fill="none" stroke="#9DC2CC" stroke-width="40" stroke-linecap="round" opacity=".8"/>
       <path d="${cd}" class="shimmer" fill="none" stroke="#E9F3F0" stroke-width="7"
             stroke-linecap="round" stroke-dasharray="18 70" opacity=".55"/>
       <g transform="translate(${cx}, ${creekY + 30})">
         <rect x="-95" y="-58" width="190" height="116" rx="10" fill="#9A7E52"/>
         <g stroke="#7C6540" stroke-width="5">${[-38,-14,10,34].map(o => `<line x1="${o}" y1="-58" x2="${o}" y2="58"/>`).join('')}</g>
         <rect x="-101" y="-64" width="202" height="11" rx="5" fill="#7C6540"/>
         <rect x="-101" y="53" width="202" height="11" rx="5" fill="#7C6540"/>
       </g>`;
  }

  let pondHTML = '', pondPos = null;
  if (pondG){
    const py = (pondG.y0 + pondG.y1) / 2;
    const px = clamp(trailXAtY(py) + (trailXAtY(py) > CX ? -640 : 640), 260, W - 260);
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

  const band = document.createElementNS(NS, 'path');
  band.setAttribute('d', dStr); band.setAttribute('fill', 'none');
  band.setAttribute('stroke', '#5C5137'); band.setAttribute('stroke-width', '120');
  band.setAttribute('stroke-linecap', 'round'); band.setAttribute('opacity', '0.12');
  svg.appendChild(band);
  svg.appendChild(creekGroup);
  if (pondHTML){ const g = document.createElementNS(NS, 'g'); g.innerHTML = pondHTML; svg.appendChild(g); }
  const dots = document.createElementNS(NS, 'path');
  dots.setAttribute('d', dStr); dots.setAttribute('fill', 'none');
  dots.setAttribute('stroke', '#6B5C40'); dots.setAttribute('stroke-width', '13');
  dots.setAttribute('stroke-linecap', 'round'); dots.setAttribute('stroke-dasharray', '0.01 42');
  svg.appendChild(dots);

  /* flat ground details: scree, boulders-lite, flowers, leaf litter, logs */
  const detail = document.createElementNS(NS, 'g');
  let dh = '';
  for (let d = 250; d < PLEN - 250; d += 210 + rnd() * 150){
    const p = atDist(d);
    const off = (rnd() > 0.5 ? 1 : -1) * (300 + rnd() * 850);
    const x = clamp(p.x + off, -1500, W + 1500), yy = p.y + (rnd() - 0.5) * 160;
    const season = SEASON_OF(Math.round(monthAtY(yy)));
    const r = rnd();
    if (r < 0.24){       // scree / pebbles
      dh += `<g fill="#9C9C8C" opacity=".7"><ellipse cx="${x}" cy="${yy}" rx="${8+rnd()*10}" ry="${4+rnd()*5}"/>
             <ellipse cx="${x+20}" cy="${yy+8}" rx="${5+rnd()*7}" ry="${3+rnd()*4}"/></g>`;
    } else if (r < 0.34){ // fallen log
      dh += `<g transform="translate(${x},${yy}) rotate(${rnd()*80-40})">
             <rect x="-34" y="-7" width="68" height="14" rx="7" fill="#84704C"/>
             <circle cx="34" cy="0" r="7" fill="#A08A5E"/></g>`;
    } else if (season === 'winter'){
      dh += `<ellipse cx="${x}" cy="${yy}" rx="${50+rnd()*60}" ry="${14+rnd()*10}" fill="#F2F4EC" opacity=".7"/>`;
    } else if (season === 'spring'){
      dh += `<g><circle cx="${x}" cy="${yy}" r="5.5" fill="${rnd()>0.5?'#D98BA4':'#EFE9F2'}"/>
             <circle cx="${x+16}" cy="${yy+8}" r="4.5" fill="#EAD9EE"/>
             <circle cx="${x-13}" cy="${yy+11}" r="4" fill="#D98BA4"/></g>`;
    } else if (season === 'summer'){
      dh += `<g fill="#F2E28C" opacity=".9"><circle cx="${x}" cy="${yy}" r="4.5"/>
             <circle cx="${x+15}" cy="${yy+9}" r="3.5"/><circle cx="${x-12}" cy="${yy+7}" r="3"/></g>`;
    } else {
      dh += `<g fill="#B98A4A" opacity=".8"><ellipse cx="${x}" cy="${yy}" rx="6" ry="3.5" transform="rotate(30 ${x} ${yy})"/>
             <ellipse cx="${x+17}" cy="${yy+7}" rx="5" ry="3" transform="rotate(-20 ${x+17} ${yy+7})"/>
             <ellipse cx="${x-12}" cy="${yy+11}" rx="5" ry="3" transform="rotate(60 ${x-12} ${yy+11})"/></g>`;
    }
  }
  detail.innerHTML = dh;
  svg.appendChild(detail);

  /* cloud shadows drifting over the ground */
  if (!reduced){
    for (let i = 0; i < 3; i++){
      const c = document.createElement('div');
      c.className = 'cloudshadow';
      const w = 700 + rnd() * 500;
      c.style.cssText = `left:${(rnd()*(W+1600)-800).toFixed(0)}px; top:${(rnd()*LEN).toFixed(0)}px;
        width:${w}px; height:${w*0.55}px; animation-duration:${(80+rnd()*60).toFixed(0)}s;
        animation-delay:-${(rnd()*70).toFixed(0)}s;`;
      map.appendChild(c);
    }
  }

  const shadows = document.createElementNS(NS, 'g');
  svg.appendChild(shadows);
  function addShadow(x, y, rx){
    const el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', x); el.setAttribute('cy', y - (rx * 0.32 + 10));
    el.setAttribute('rx', rx); el.setAttribute('ry', rx * 0.32);
    el.setAttribute('fill', 'rgba(45,52,32,.16)');
    shadows.appendChild(el);
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
    props.push({el, y});
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
    if (lights){
      s += `<g class="xlights">`;
      for (let i = 0; i < 7; i++){
        const ly = h * (0.26 + 0.5 * (i / 6));
        const spreadHalf = (w * (0.5 + 0.5 * i / 6)) / 2 * 0.8;
        const lx = w/2 + (i % 2 ? 1 : -1) * spreadHalf * (0.4 + 0.55 * rnd());
        s += `<circle cx="${lx}" cy="${ly}" r="3.4" fill="${['#E25555','#EFC94C','#7FB5E2','#8FBF6A'][i % 4]}"/>`;
      }
      s += `</g>`;
    }
    return s + '</svg>';
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
  const eventClear = (x, y) => pts.some(p => Math.abs(p.y - y) < 380 && Math.abs(p.x - x) < 560);

  /* forest: pines with real height flanking the corridor */
  const treeTarget = clamp(Math.round(LEN / 78), 60, 170);
  let placed = 0, guard = 0;
  while (placed < treeTarget && guard++ < treeTarget * 5){
    const d = 120 + rnd() * (PLEN - 240);
    const p = atDist(d);
    const off = (rnd() > 0.5 ? 1 : -1) * (360 + Math.pow(rnd(), 0.6) * 780);
    const x = p.x + off, yy = p.y + (rnd() - 0.5) * 200;
    if (x < -1300 || x > W + 1300) continue;
    if (eventClear(x, yy)) continue;
    if (pondPos && Math.abs(pondPos.x - x) < 300 && Math.abs(pondPos.y - yy) < 220) continue;
    if (Math.abs(yy - creekY) < 130) continue;
    const season = SEASON_OF(Math.round(monthAtY(yy)));
    const [tone, dark] = SEASON_PINE[season];
    const h = 100 + rnd() * 130;
    const isPine = rnd() < 0.74;
    const leafTone = season === 'autumn' ? (rnd() > 0.5 ? '#B9823E' : '#A8944E')
                   : season === 'winter' ? '#9AA88E' : (rnd() > 0.5 ? '#6E8F4E' : '#7C9E58');
    prop(x, yy, isPine ? pineSVG(h, tone, dark) : broadleafSVG(h * 0.8, leafTone),
         {shadow: h * 0.3, cls: rnd() < 0.25 ? 'sway' : ''});
    placed++;
  }

  /* boulders + outcrops */
  for (let i = 0; i < Math.round(LEN / 900); i++){
    const d = rnd() * PLEN;
    const p = atDist(d);
    const off = (rnd() > 0.5 ? 1 : -1) * (430 + rnd() * 620);
    const x = p.x + off, yy = p.y + (rnd() - 0.5) * 150;
    if (eventClear(x, yy) || Math.abs(yy - creekY) < 140) continue;
    prop(x, yy, boulderSVG(70 + rnd() * 90), {shadow: 44});
  }

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
        detail.appendChild(g);
      } else if (kind === 'lights'){
        prop(x, yy, pineSVG(150, '#4A5B48', '#3C4B3A', true), {shadow: 42});
      } else {
        const g = document.createElementNS(NS, 'g');
        g.innerHTML = `<g transform="translate(${x},${yy})" fill="#D97795">
          <path d="M0 6 C-8 -4 -20 2 0 16 C20 2 8 -4 0 6 Z"/>
          <path d="M26 12 C20 5 12 9 26 19 C40 9 32 5 26 12 Z" opacity=".8"/></g>`;
        detail.appendChild(g);
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
      ${pineSVG(170, '#4F7348', '#3F5E3B')}
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
    [0.24, 0.68].forEach((f, i) => {
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
    .goldpaw svg{filter:drop-shadow(0 0 6px rgba(201,162,39,.75)); animation:pawpulse 3.2s ease-in-out infinite;}
    @keyframes pawpulse{0%,100%{opacity:.75}50%{opacity:1}}
    .goldpaw.found{transform:translate(-50%,-50%) scale(2.2); opacity:0; pointer-events:none;}
    @media (prefers-reduced-motion: reduce){ .goldpaw svg{animation:none;} }`;
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

  /* ---------- narrative billboards ---------- */
  const bbs = [];
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
        <div class="post"></div>
        <div class="fan"></div>`, 130);
      el.tabIndex = 0;
      const fan = el.querySelector('.fan');
      const shown = e.photos.slice(0, 8);
      shown.forEach((ph, i) => {
        const pet = petBy[ph.dog];
        const fp = document.createElement('div');
        fp.className = 'fp';
        const n = shown.length, spread = Math.min(150, 44 + n * 14);
        const ang = (n === 1) ? 0 : (-spread/2 + spread * i / (n - 1));
        const rad = 205;
        fp.style.setProperty('--fx', (Math.sin(ang * Math.PI/180) * rad).toFixed(0) + 'px');
        fp.style.setProperty('--fy', (-70 - Math.cos(ang * Math.PI/180) * rad * 0.62).toFixed(0) + 'px');
        fp.style.setProperty('--acc', pet ? pet.color : 'var(--gold)');
        fp.style.transitionDelay = (i * 0.04) + 's';
        fp.innerHTML = `<img src="${ph.thumb}" alt="" loading="lazy">`;
        fp.addEventListener('click', ev => { ev.stopPropagation(); openLightbox(e.photos, e.photos.indexOf(ph)); });
        fan.appendChild(fp);
      });
      el.addEventListener('click', () => toggleCamp(el));
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); toggleCamp(el); }});
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

  function toggleCamp(el){
    const wasOpen = el.classList.contains('open');
    document.querySelectorAll('.bb-camp.open').forEach(c => c.classList.remove('open'));
    map.classList.remove('dimmed');
    if (!wasOpen){ el.classList.add('open'); map.classList.add('dimmed'); }
  }
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape'){
      document.querySelectorAll('.bb-camp.open').forEach(c => c.classList.remove('open'));
      map.classList.remove('dimmed');
      closeLightbox();
    }
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
  const params = new URLSearchParams(location.search);
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
        for (let i = 0; i < 9; i++){
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
    const density = {winter: 14, autumn: 12, spring: 10, summer: 6}[weatherSeason];
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

  /* ---------- camera ---------- */
  const intro = document.getElementById('intro');
  const meterYr = document.getElementById('meterYr');
  const endnote = document.getElementById('endnote');
  const zoom = document.getElementById('zoom');
  const ridge = document.getElementById('ridgeInner');
  const spacer = document.getElementById('spacer');
  spacer.style.height = Math.round(PLEN * 1.12 + innerHeight) + 'px';

  function update(){
    const doc = document.documentElement;
    const prog = clamp(scrollY / (doc.scrollHeight - innerHeight), 0, 1);
    const dist = prog * PLEN;
    const p = atDist(dist);
    const ahead = atDist(dist + 480);
    const camX = p.x + (ahead.x - p.x) * 0.45;
    const camY = p.y;

    const s = clamp(innerWidth / 1150, 0.52, 1);
    zoom.style.transform = `scale(${s.toFixed(3)})`;
    map.style.transform = `translate3d(${(-camX).toFixed(1)}px, ${(-camY).toFixed(1)}px, 0)`;
    if (ridge) ridge.style.transform = `translateX(${(-camX * 0.045).toFixed(1)}px)`;

    const arrived = prog > 0.018;
    bbs.forEach(b => {
      const on = arrived && b.y > camY - 1500 && b.y < camY + 800;
      if (on !== b.el.classList.contains('on')) b.el.classList.toggle('on', on);
    });
    props.forEach(pr => {
      const vis = pr.y > camY - 1700 && pr.y < camY + 900;
      const cur = pr.el.style.visibility !== 'hidden';
      if (vis !== cur) pr.el.style.visibility = vis ? '' : 'hidden';
    });

    if (deer){
      const near = Math.abs(deerY - camY) < 640;
      if (near !== deer.classList.contains('alert')) deer.classList.toggle('alert', near);
    }

    intro.style.opacity = 1 - clamp(prog / 0.05, 0, 1);
    intro.style.visibility = prog > 0.055 ? 'hidden' : 'visible';

    const mk = Math.round(monthAtY(camY));
    meterYr.textContent = prog > 0.985 ? 'Today' : monthLabel(mk);

    const season = SEASON_OF(mk);
    if (season !== weatherSeason){
      weatherSeason = season;
      refreshAmbient();
    }

    mmCam.setAttribute('cx', mmX(p.x)); mmCam.setAttribute('cy', mmY(p.y));
    endnote.classList.toggle('on', prog > 0.965);
  }

  let tick = false;
  const onScroll = () => { if (!tick){ tick = true; requestAnimationFrame(() => { update(); tick = false; }); } };
  addEventListener('scroll', onScroll, {passive: true});
  addEventListener('resize', onScroll);
  applyMode();
  setInterval(applyMode, 10 * 60 * 1000);
  update();
})();

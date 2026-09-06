#!/usr/bin/env node
/*
 * Browser smoke test for the alpine journey (KTD7/U3, extended for KTD1/
 * KTD3/KTD4/U4).
 *
 * What this measures and why:
 *   - "Frame time" here means the wall-clock duration of one journey.js
 *     update() call, read from window.__journeyStats.updateMs, NOT the
 *     interval between requestAnimationFrame callbacks. rAF cadence is
 *     pinned to the display refresh rate and says nothing about the cost of
 *     our own work; update() is the one function that does all of the
 *     site's per-frame camera/cull/DOM work, so its duration is the real
 *     budget every later unit (overlays, motion) has to fit inside.
 *   - aliveBands / aliveSurfaces come from the same hook, counted from the
 *     arrays journey.js already tracks for its own visibility culling, not
 *     a separate DOM walk.
 *   - attachedOverlays / missingOverlays (U4/KTD4): real values from the
 *     band lookahead-attach state. attachedOverlays is the count of bands
 *     whose art is currently attached; missingOverlays counts VISIBLE bands
 *     that have been attached over 1s and still haven't reported 'painted'
 *     (0 in flat mode, where nothing is ever attached).
 *   - Long tasks (>=50ms on the main thread) are read from a
 *     PerformanceObserver installed before the page loads.
 *
 * Runs three profiles (desktop, lite, reduced motion) against a Flask
 * server started in JOURNEY_FIXTURE mode (tests/fixtures/journey-sample.json),
 * sweeps the whole trail in fixed steps plus three instant teleports, and
 * checks the numbers against absolute ceilings and against
 * tests/smoke/baseline.json (small tolerance on frame-time metrics only,
 * since machines vary). Also runs:
 *   - AE2: a fixture with twice the trail length, checking alive bands and
 *     attached overlays still never exceed their caps.
 *   - ?ground=flat (U4): the rollback gate never attaches anything.
 *   - a blocked-overlay run (U4): art requests aborted, the missingOverlays
 *     detector must fire, and the ground must not go blank.
 *   - a lookahead snapshot (U4/KTD4): per-band attach state at a fixed
 *     camera position, checked against the visibility/lookahead windows.
 *   - a seam check (AE2/KTD4): pixel continuity across a band boundary.
 *   - an AE5 palette check: ground colors at a spring/summer/autumn/winter
 *     camp stay within the season's documented palette plus ink.
 *
 * Usage:
 *   node journey-smoke.mjs                 # run and check against baseline
 *   node journey-smoke.mjs --write-baseline # record current numbers as baseline
 *   SMOKE_URL=http://localhost:8000 node journey-smoke.mjs   # use a server
 *     that's already running instead of spawning one (skips the AE2 pass,
 *     since that needs a second fixture the caller's server isn't using).
 */
import { chromium, devices } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/journey-sample.json');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const PYTHON_BIN = path.join(REPO_ROOT, 'venv/bin/python');
const ALPINE_DIR = path.join(REPO_ROOT, 'static/images/alpine');
const PORT = 8000;
const WRITE_BASELINE = process.argv.includes('--write-baseline');
const SWEEP_STEPS = 20;
const CONSOLE_TIMEOUT_MS = 20000;
const BANDH = 1600;  // must match journey.js's BANDH — no runtime way to read it from Node

/* ---------- small process/server helpers ---------- */

function startServer(fixturePath) {
  const env = { ...process.env, JOURNEY_FIXTURE: fixturePath };
  delete env.WEBSITE_INSTANCE_ID; // never run the fixture test suite "as if" on App Service
  const proc = spawn(path.join(REPO_ROOT, 'venv/bin/python'), ['app.py'], {
    cwd: REPO_ROOT,
    env,
    detached: true, // its own process group, so we can kill Werkzeug's reloader child too
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });
  proc.getOutput = () => output;
  return proc;
}

function stopServer(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
}

async function waitForHttp200(url, timeoutMs, proc) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    if (proc && proc.exitCode !== null) {
      throw new Error(`server process exited early (code ${proc.exitCode}):\n${proc.getOutput()}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server did not answer 200 at ${url} within ${timeoutMs}ms` +
    (proc ? `\n--- server output ---\n${proc.getOutput()}` : ''));
}

/* ---------- AE2: a fixture with twice the trail length ---------- */
// Duplicates only the camp (photo group) events, shifted a whole number of
// years later so season labels and SEASON_OF(month) math both stay correct.
function makeLongFixture(sample) {
  const today = sample.events.find(e => e.type === 'today');
  const camps = sample.events.filter(e => e.type === 'camp');
  const others = sample.events.filter(e => e.type !== 'camp' && e.type !== 'today');
  const spanMonths = today.month - sample.trailhead_month;
  const shift = Math.max(12, Math.ceil(spanMonths / 12) * 12);
  const dupCamps = camps.map(e => {
    const yearShift = shift / 12;
    return {
      ...e,
      month: e.month + shift,
      year: e.year + yearShift,
      label: e.label.replace(/\d{4}/, m => String(Number(m) + yearShift)),
    };
  });
  const events = [...others, ...camps, ...dupCamps]
    .sort((a, b) => (a.month - b.month) || ((a.type === 'union' ? -1 : 0) - (b.type === 'union' ? -1 : 0)));
  events.push({ type: 'today', month: today.month + shift });
  return { ...sample, events, now_month: today.month + shift };
}

// A local replica of journey.js's SEASON_OF, for picking fixture camps by
// season from Node (same convention makeLongFixture already uses for month
// arithmetic). Keep in sync with static/js/journey.js if that ever changes —
// the season boundaries are a session-settled Key Decision, not something
// this unit reopens, so drift risk here is low.
function seasonOfMonth(m) {
  const mm = ((m % 12) + 12) % 12 + 1;
  return (mm === 12 || mm <= 2) ? 'winter' : (mm <= 5) ? 'spring' : (mm <= 8) ? 'summer' : 'autumn';
}

/* ---------- AE5 palette reference (docs/alpine-art-brief.md section 2) ---------- */
// Duplicated here rather than read from the app: these are fixed, documented
// design constants (session-settled per the plan's Key Decisions), the same
// way SEASON_GROUND is a fixed constant in journey.js.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const INK_RGB = hexToRgb('#241F1A');
const SEASON_GROUND_HEX = { spring: '#A2B87F', summer: '#8CA668', autumn: '#AC9A5C', winter: '#D3D6CB' };
const SEASON_COMPANION_HEX = {
  spring: ['#5E8256', '#D8D9C8', '#8B8A7E'],
  summer: ['#4F7348', '#7C7A6C', '#C9A227'],
  autumn: ['#5E7A4C', '#A8722E', '#8F8B7A'],
  winter: ['#A9B4B7', '#5B6E58', '#87947A'],
};
const WATER_RGB = [hexToRgb('#2E7A80'), hexToRgb('#6FC7C2')];

/* ---------- pixel helpers (shell to Pillow, already a project dependency) ---------- */
// No image-decoding npm package is installed for this test script, and
// Pillow already ships with the app (app.py uses it for thumbnailing), so
// screenshots are decoded by a one-line Python invocation instead of adding
// a new JS dependency for two call sites.
function samplePixels(pngBuffer, points) {
  const tmp = path.join(os.tmpdir(), `journey-smoke-shot-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(tmp, pngBuffer);
  const code = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
pts = json.loads(sys.argv[2])
print(json.dumps([list(im.getpixel((x, y))) for x, y in pts]))
`;
  try {
    const out = execFileSync(PYTHON_BIN, ['-c', code, tmp, JSON.stringify(points)],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function imageAverageColor(assetPath) {
  const code = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
print(','.join(map(str, im.resize((1, 1)).getpixel((0, 0)))))
`;
  const out = execFileSync(PYTHON_BIN, ['-c', code, assetPath], { encoding: 'utf8' }).trim();
  return out.split(',').map(Number);
}

// Is `pixel` within `tol` per channel of any reference swatch, or of any
// blend between two swatches? A grain pixel is ink over ground (or over
// dirt, or over water), so the blend line between any two palette colors is
// as valid a sample as the colors themselves.
function withinPaletteTolerance(pixel, swatches, tol = 40) {
  const close = c => Math.abs(pixel[0] - c[0]) <= tol && Math.abs(pixel[1] - c[1]) <= tol && Math.abs(pixel[2] - c[2]) <= tol;
  if (swatches.some(close)) return true;
  for (let i = 0; i < swatches.length; i++) {
    for (let j = i + 1; j < swatches.length; j++) {
      for (let t = 0.1; t < 1; t += 0.1) {
        const blend = [0, 1, 2].map(k => swatches[i][k] * (1 - t) + swatches[j][k] * t);
        if (close(blend)) return true;
      }
    }
  }
  return false;
}

/* ---------- camera positioning ---------- */
// journey.js decouples the camera from the scrollbar (it glides toward the
// scroll target), so "scroll to Y" doesn't directly give a known camY or
// month. This bisects on scrollY using a value read from the page after each
// settle, assuming (as the layout guarantees for anchor points) that the
// value is monotonic in scrollY over the relevant range.
async function bisectScroll(page, maxY, valueFn, target, { increasing = true, tol = 1, maxIter = 22 } = {}) {
  let lo = 0, hi = maxY;
  const setAndRead = async (y) => {
    await page.evaluate(y => window.scrollTo(0, Math.round(y)), y);
    await settle(page);
    return page.evaluate(valueFn);
  };
  let mid = (lo + hi) / 2, val = await setAndRead(mid);
  for (let i = 0; i < maxIter && Math.abs(val - target) > tol; i++) {
    const goRight = increasing ? val < target : val > target;
    if (goRight) lo = mid; else hi = mid;
    mid = (lo + hi) / 2;
    val = await setAndRead(mid);
  }
  return { scrollY: mid, value: val };
}

/* ---------- page instrumentation ---------- */

function installRecorder() {
  window.__longTasks = []; // {dur, start}, start relative to navigation like performance.now()
  try {
    const po = new PerformanceObserver(list => {
      for (const e of list.getEntries()) window.__longTasks.push({ dur: e.duration, start: e.startTime });
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* longtask entries are Chromium-only; we only run Chromium */ }

  window.__statsLog = [];
  let lastFrames = -1;
  (function poll() {
    const s = window.__journeyStats;
    if (s && s.frames !== lastFrames) {
      lastFrames = s.frames;
      window.__statsLog.push({
        frames: s.frames, updateMs: s.updateMs, aliveBands: s.aliveBands,
        aliveSurfaces: s.aliveSurfaces, missingOverlays: s.missingOverlays,
        attachedOverlays: s.attachedOverlays,
      });
    }
    requestAnimationFrame(poll);
  })();
}

async function anyRunningAnimation(page) {
  return page.evaluate(() => {
    const map = document.querySelector('#map');
    if (!map) return false;
    const els = [map, ...map.querySelectorAll('*')];
    return els.some(el => el.getAnimations && el.getAnimations().some(a => a.playState === 'running'));
  });
}

// Waits until window.__journeyStats.frames stops changing (the camera has
// caught up with the scroll target), or a timeout, whichever comes first.
async function settle(page, { maxWaitMs = 4000, idleMs = 130, pollMs = 30 } = {}) {
  const start = Date.now();
  let lastFrames = null, lastChange = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const frames = await page.evaluate(() => (window.__journeyStats ? window.__journeyStats.frames : null));
    if (frames !== lastFrames) { lastFrames = frames; lastChange = Date.now(); }
    else if (Date.now() - lastChange > idleMs) return;
    await page.waitForTimeout(pollMs);
  }
}

/* ---------- one profile run ---------- */

async function runProfile(browser, baseUrl, { name, contextOptions, checkNoAnim, extraQuery = '', isFlat = false }) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Photos 404 (or, before allowed_img_paths() warms up, 502) in fixture
  // mode by design (KTD7: "the script measures the world, not the photos") —
  // those resource-load failures are expected and excluded here, not a sign
  // of a real regression.
  const consoleErrors = [];
  let expectedPhotoFailures = 0;
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const url = msg.location() && msg.location().url;
    if (url && url.includes('/img?path=')) { expectedPhotoFailures++; return; }
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(String(err && err.message ? err.message : err)));

  let artBytes = 0;
  page.on('response', res => {
    if (res.url().includes('/static/images/alpine/')) {
      const len = res.headers()['content-length'];
      if (len) artBytes += parseInt(len, 10);
    }
  });

  await page.addInitScript(installRecorder);
  await page.goto(`${baseUrl}/?t=day${extraQuery}`, { waitUntil: 'load', timeout: CONSOLE_TIMEOUT_MS });

  // Static per-build value (E9/U4): no vector scree/flower/log path should
  // remain once the atlas cells are wired up. undefined in flat mode, where
  // the vector predecessors are the intended look.
  const vectorCount = await page.evaluate(() => window.__journeyDetailVectorCount);

  const maxY = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight));

  // journey.js builds the whole world (bands, groves, billboards) synchronously
  // before its first paint; that one-time construction cost is a page-load
  // concern, not the "full-trail scroll sweep keeps the current bar: no long
  // frames" success criterion this script checks. So long tasks are split at
  // this mark: before it is reported as load cost, from here on is the metric
  // the ceiling applies to.
  const sweepStartMark = await page.evaluate(() => performance.now());

  let animDetected = false;
  const checkAnim = async () => {
    if (checkNoAnim && await anyRunningAnimation(page)) animDetected = true;
  };

  for (let i = 0; i <= SWEEP_STEPS; i++) {
    const y = Math.round((i / SWEEP_STEPS) * maxY);
    await page.evaluate(y => window.scrollTo(0, y), y);
    await settle(page);
    await checkAnim();
  }
  for (const y of [0, maxY, Math.round(maxY / 2)]) {
    await page.evaluate(y => window.scrollTo(0, y), y);
    await settle(page);
    await checkAnim();
  }

  const [statsLog, longTasks, finalAttachTimes] = await page.evaluate(() =>
    [window.__statsLog, window.__longTasks,
      (window.__journeyStats && window.__journeyStats.attachTimes) || []]);
  await context.close();

  const warm = statsLog.filter(s => s.frames > 20); // ignore ~20 warmup frames
  const updateTimes = warm.map(s => s.updateMs);
  const maxOf = key => statsLog.reduce((m, s) => Math.max(m, s[key]), 0);
  const loadLongTasks = longTasks.filter(t => t.start < sweepStartMark);
  const sweepLongTasks = longTasks.filter(t => t.start >= sweepStartMark);

  // KTD4/E2: no long task should start within 100ms after an overlay attach —
  // a first attach can repaint a whole band, and that repaint must not be
  // the kind of work that blocks the main thread for 50ms+.
  let attachViolation = null;
  for (const lt of sweepLongTasks) {
    const near = finalAttachTimes.find(at => lt.start >= at && lt.start <= at + 100);
    if (near !== undefined) { attachViolation = { longTaskStart: lt.start, dur: lt.dur, attachAt: near }; break; }
  }

  return {
    name,
    isFlat,
    consoleErrors,
    expectedPhotoFailures,
    artBytes,
    vectorCount,
    aliveBandsMax: maxOf('aliveBands'),
    aliveSurfacesMax: maxOf('aliveSurfaces'),
    missingOverlaysMax: maxOf('missingOverlays'),
    attachedOverlaysMax: maxOf('attachedOverlays'),
    updateMsAvg: updateTimes.length ? updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length : 0,
    updateMsWorst: updateTimes.length ? Math.max(...updateTimes) : 0,
    longTasks: sweepLongTasks.length,
    loadLongTasks: loadLongTasks.length,
    loadLongTaskDurations: loadLongTasks.map(t => Math.round(t.dur)),
    attachViolation,
    animDetected,
    frameSamples: statsLog.length,
  };
}

/* ---------- ceilings + baseline comparison ---------- */

function evalProfile(stats, { isLite, isReduced, isFlat, baseline }) {
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });

  add('console errors == 0', stats.consoleErrors.length === 0,
    stats.consoleErrors.length ? stats.consoleErrors.slice(0, 3).join(' | ') : 'none');
  add('aliveBands <= 4', stats.aliveBandsMax <= 4, `max ${stats.aliveBandsMax}`);
  add('missingOverlays == 0', stats.missingOverlaysMax === 0, `max ${stats.missingOverlaysMax}`);
  // Band tops fall in an 8900 px open interval (visibility + one band of
  // lookahead each side) over 1600 px bands, so 6 is the true worst case.
  add('attachedOverlays <= 6', stats.attachedOverlaysMax <= 6, `max ${stats.attachedOverlaysMax}`);
  if (isFlat) add('attachedOverlays == 0 (flat)', stats.attachedOverlaysMax === 0, `max ${stats.attachedOverlaysMax}`);
  add('art bytes < 1.5MB', stats.artBytes < 1572864, `${stats.artBytes} bytes`);
  add('long tasks (>=50ms) == 0', stats.longTasks === 0, `${stats.longTasks}`);
  add('no long task within 100ms of an attach', !stats.attachViolation,
    stats.attachViolation ? JSON.stringify(stats.attachViolation) : 'none');
  if (!isFlat) {
    add('no vector scree/flower/log path (__journeyDetailVectorCount == 0)',
      stats.vectorCount === 0, `${stats.vectorCount}`);
  }

  const avgCeil = isLite ? 14 : 12;
  const worstCeil = isLite ? 20 : 16; // reduced uses the desktop ceilings
  add(`updateMs avg <= ${avgCeil}ms`, stats.updateMsAvg <= avgCeil, `${stats.updateMsAvg.toFixed(2)}ms`);
  add(`updateMs worst <= ${worstCeil}ms`, stats.updateMsWorst <= worstCeil, `${stats.updateMsWorst.toFixed(2)}ms`);

  if (isReduced) {
    add('no running animation inside #map', !stats.animDetected, stats.animDetected ? 'FOUND' : 'none');
  }

  if (baseline) {
    const noRegress = (curr, base, label) =>
      add(`${label} <= baseline (${base})`, curr <= base, `${curr}`);
    noRegress(stats.aliveBandsMax, baseline.aliveBandsMax, 'aliveBands');
    noRegress(stats.aliveSurfacesMax, baseline.aliveSurfacesMax, 'aliveSurfaces');
    noRegress(stats.longTasks, baseline.longTasks, 'longTasks');
    // Overlays add real per-frame work at attach moments, and the U3
    // baseline numbers are sub-millisecond (a flat 25% of ~0.3ms is a
    // fraction of a millisecond, well inside measurement noise), so the
    // tolerance is the larger of +25% or +1.0ms.
    const tol = base => Math.max(base * 1.25, base + 1.0);
    add('updateMs avg <= max(baseline*1.25, baseline+1ms)', stats.updateMsAvg <= tol(baseline.updateMsAvg),
      `${stats.updateMsAvg.toFixed(2)} vs ${tol(baseline.updateMsAvg).toFixed(2)}`);
    add('updateMs worst <= max(baseline*1.25, baseline+1ms)', stats.updateMsWorst <= tol(baseline.updateMsWorst),
      `${stats.updateMsWorst.toFixed(2)} vs ${tol(baseline.updateMsWorst).toFixed(2)}`);
  }
  return checks;
}

/* ---------- reporting ---------- */

function printProfileTable(stats, checks) {
  console.log(`\n=== ${stats.name} ===`);
  console.log(
    `frames=${stats.frameSamples} aliveBandsMax=${stats.aliveBandsMax} ` +
    `aliveSurfacesMax=${stats.aliveSurfacesMax} missingOverlaysMax=${stats.missingOverlaysMax} ` +
    `attachedOverlaysMax=${stats.attachedOverlaysMax} vectorCount=${stats.vectorCount} ` +
    `updateMs avg=${stats.updateMsAvg.toFixed(2)} worst=${stats.updateMsWorst.toFixed(2)} ` +
    `sweepLongTasks=${stats.longTasks} artBytes=${stats.artBytes} consoleErrors=${stats.consoleErrors.length}`
  );
  console.log(
    `  (info) loadLongTasks=${stats.loadLongTasks} ${stats.loadLongTaskDurations.length ? `durations=${JSON.stringify(stats.loadLongTaskDurations)}ms ` : ''}` +
    `— the synchronous initial world-build, not the scroll-sweep metric checked below; ` +
    `expectedPhotoFailures=${stats.expectedPhotoFailures} (fixture-mode /img 404s, KTD7, excluded from consoleErrors)`
  );
  for (const c of checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label} (${c.detail})`);
  }
}

/* ---------- U4 scenario: lookahead attach/detach snapshot ---------- */

async function scenarioLookahead(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(installRecorder);
  await page.goto(`${baseUrl}/?t=day`, { waitUntil: 'load' });
  const maxY = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  await page.evaluate(y => window.scrollTo(0, y), Math.round(maxY * 0.5));
  await settle(page);
  const { camY, bandsInfo } = await page.evaluate(() => ({
    camY: window.__journeyStats.camY,
    bandsInfo: window.__journeyBands(),
  }));
  await context.close();

  const visLo = camY - 2400, visHi = camY + 1700;
  const lookLo = visLo - BANDH, lookHi = visHi + BANDH;
  const checks = [];
  for (const b of bandsInfo) {
    const vis = b.y0 < visHi && b.y0 + BANDH > visLo;
    const ahead = b.y0 < lookHi && b.y0 + BANDH > lookLo;
    if (vis) checks.push({ label: `visible band y0=${b.y0} is attached`, ok: b.attached === true });
    else if (ahead) checks.push({ label: `lookahead band y0=${b.y0} is attached`, ok: b.attached === true });
    else checks.push({ label: `far band y0=${b.y0} is NOT attached`, ok: b.attached === false });
  }
  return { camY, bandsInfo, checks };
}

/* ---------- U4 scenario: overlay requests blocked ---------- */

async function scenarioBlockedOverlay(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/ground-overlay-*', route => route.abort());
  const page = await context.newPage();
  await page.addInitScript(installRecorder);
  await page.goto(`${baseUrl}/?t=day`, { waitUntil: 'load' });
  const maxY = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  await page.evaluate(y => window.scrollTo(0, y), Math.round(maxY * 0.4));
  await settle(page);
  // Let the >1000ms missingOverlays threshold actually elapse, then force one
  // more update() call (the rAF loop stops once the camera settles) so the
  // hook recomputes with the now-current performance.now().
  await page.waitForTimeout(1300);
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(60);
  const stats = await page.evaluate(() => window.__journeyStats);

  // A camp card (or another screen-space overlay) can sit in the lower half
  // too, with its own cream/white frame or a broken photo <img> — neither is
  // "the ground", so candidate points inside any such element's box are
  // dropped rather than trusted at face value; this fixture's camps are
  // close enough together that a popup-free scroll position isn't guaranteed.
  const overlayRects = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.bb-camp.here, .fanpop, .lightbox.open, .intro, .meter, .hud-left, #minimap'))
      .map(el => el.getBoundingClientRect())
      .map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
  const shot = await page.screenshot();
  await context.close();

  const vw = 1440, vh = 900;
  const inOverlay = (x, y) => overlayRects.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  const points = [];
  for (let gy = 0; gy < 10 && points.length < 50; gy++) {
    for (let gx = 0; gx < 10 && points.length < 50; gx++) {
      const x = Math.round(vw * (0.05 + 0.9 * gx / 9)), y = Math.round(vh * (0.55 + 0.4 * gy / 9));
      if (!inOverlay(x, y)) points.push([x, y]);
    }
  }
  const pixels = samplePixels(shot, points);
  const allSame = pixels.every(p => p[0] === pixels[0][0] && p[1] === pixels[0][1] && p[2] === pixels[0][2]);
  const anyBlank = pixels.some(p => p[0] > 250 && p[1] > 250 && p[2] > 250);

  return {
    missingOverlays: stats.missingOverlays,
    detectorFired: stats.missingOverlays > 0,
    notAllOneColor: !allSame,
    noBlankPixel: !anyBlank,
  };
}

/* ---------- U4/AE2 scenario: seam continuity across a band boundary ---------- */

async function scenarioSeam(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(installRecorder);
  await page.goto(`${baseUrl}/?t=day`, { waitUntil: 'load' });
  const maxY = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  const bandsInfo = await page.evaluate(() => window.__journeyBands());
  const seamWorldY = bandsInfo[2].y0; // the boundary between band 1 and band 2

  await bisectScroll(page, maxY, () => window.__journeyStats.camY, seamWorldY, { increasing: false, tol: 2 });
  // Measure the seam's real screen position with a transient, transform-free
  // marker (test-only DOM, never shipped) rather than assuming a fixed
  // percentage — exact, and robust to viewport/zoom changes.
  const seamScreenY = await page.evaluate((worldY) => {
    const map = document.getElementById('map');
    const marker = document.createElement('div');
    marker.style.cssText = `position:absolute; left:0px; top:${worldY}px; width:1px; height:1px;`;
    map.appendChild(marker);
    const y = marker.getBoundingClientRect().top;
    marker.remove();
    return y;
  }, seamWorldY);
  await page.waitForTimeout(50);
  const shot = await page.screenshot();
  await context.close();

  const vw = 1440;
  const xs = []; for (let i = 0; i < 30; i++) xs.push(Math.round(vw * 0.1 + i * (vw * 0.8 / 29)));
  const rowsAt = centerY => { const rs = []; for (let dy = -20; dy < 20; dy++) rs.push(Math.round(centerY) + dy); return rs; };
  const seamRows = rowsAt(seamScreenY);
  const refRows = rowsAt(seamScreenY - 300); // elsewhere on the same screenshot, away from any seam

  const points = [];
  for (const y of [...seamRows, ...refRows]) for (const x of xs) points.push([x, y]);
  const pixels = samplePixels(shot, points);

  const rowAvg = idx => {
    const start = idx * xs.length;
    const slice = pixels.slice(start, start + xs.length);
    return [0, 1, 2].map(k => slice.reduce((a, p) => a + p[k], 0) / slice.length);
  };
  const rowDiffs = (rows) => {
    const avgs = rows.map((_, i) => rowAvg(i));
    const diffs = [];
    for (let i = 1; i < avgs.length; i++) {
      diffs.push([0, 1, 2].reduce((a, k) => a + Math.abs(avgs[i][k] - avgs[i - 1][k]), 0) / 3);
    }
    return diffs;
  };

  const seamDiffs = rowDiffs(seamRows);
  const refDiffsRaw = pixels.slice(seamRows.length * xs.length);
  // reuse rowAvg logic but offset into the ref block
  const refAvgs = refRows.map((_, i) => {
    const start = (seamRows.length + i) * xs.length;
    const slice = pixels.slice(start, start + xs.length);
    return [0, 1, 2].map(k => slice.reduce((a, p) => a + p[k], 0) / slice.length);
  });
  const refDiffs = [];
  for (let i = 1; i < refAvgs.length; i++) {
    refDiffs.push([0, 1, 2].reduce((a, k) => a + Math.abs(refAvgs[i][k] - refAvgs[i - 1][k]), 0) / 3);
  }

  const maxSeamDiff = Math.max(...seamDiffs);
  const typicalDiff = refDiffs.reduce((a, b) => a + b, 0) / refDiffs.length;
  const threshold = typicalDiff * 2 + 3;

  return { maxSeamDiff, typicalDiff, threshold, ok: maxSeamDiff <= threshold, seamScreenY };
}

/* ---------- AE5 scenario: seasonal ground palette ---------- */

async function scenarioPalette(browser, baseUrl, sample) {
  const camps = sample.events.filter(e => e.type === 'camp');
  const bySeasonFirst = {};
  for (const c of camps) { const s = seasonOfMonth(c.month); if (!(s in bySeasonFirst)) bySeasonFirst[s] = c; }
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  const missingSeasons = seasons.filter(s => !(s in bySeasonFirst));
  // Per the plan: if the fixture has no winter camp, extend it in-script
  // (AE2-style). Not needed here — tests/fixtures/journey-sample.json
  // already carries a camp in every season — but reported either way.

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(installRecorder);
  await page.goto(`${baseUrl}/?t=day`, { waitUntil: 'load' });
  const maxY = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));

  const dirtAvg = imageAverageColor(path.join(ALPINE_DIR, 'dirt-trail-tile.webp'));
  const winterOverlayAvg = imageAverageColor(path.join(ALPINE_DIR, 'ground-overlay-winter.webp'));

  const results = {};
  for (const season of seasons) {
    const camp = bySeasonFirst[season];
    if (!camp) { results[season] = { skipped: true }; continue; }
    // The snow overlay is clipped to the winter stretch inside a band (a
    // masked rect per stretch, see journey.js), so a camp's own month is
    // enough to land the camera on ground of the right season.
    await bisectScroll(page, maxY, () => window.__journeyStats.mk, camp.month, { increasing: true, tol: 1 });
    const read = await page.evaluate(() => ({
      bandsInfo: window.__journeyBands(), camY: window.__journeyStats.camY,
      hasPopup: !!document.querySelector('.bb-camp.here'),
    }));
    const bandsInfo = read.bandsInfo, camY = read.camY, hasPopup = read.hasPopup, landedOffset = 0;
    const band = bandsInfo.find(b => camY >= b.y0 && camY < b.y0 + BANDH);
    // The world point at (camX, camY) always renders at the same fixed
    // screen anchor regardless of camX (the .tilt rotateX hinge sits at
    // local Y=0, i.e. world Y=camY, and rotating around that hinge doesn't
    // move a point already on it) — so a marker at world (0, camY) gives the
    // exact on-screen row for "here", the same trick the seam check uses.
    // Sampling near that row (not an arbitrary "upper viewport" band) is
    // what makes this the *targeted* band's ground, not whatever a distant,
    // differently-seasoned band happens to occupy higher on screen.
    const anchorScreenY = await page.evaluate(() => {
      const map = document.getElementById('map');
      const marker = document.createElement('div');
      marker.style.cssText = `position:absolute; left:0px; top:${window.__journeyStats.camY}px; width:1px; height:1px;`;
      map.appendChild(marker);
      const y = marker.getBoundingClientRect().top;
      marker.remove();
      return y;
    });
    const overlayRects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.bb-camp.here, .fanpop, .lightbox.open, .intro, .meter, .hud-left, #minimap'))
        .map(el => el.getBoundingClientRect())
        .map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })));
    const shot = await page.screenshot();

    const vw = 1440, vh = 900;
    const inOverlay = (x, y) => overlayRects.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    const points = [];
    for (let gy = 0; gy < 8 && points.length < 30; gy++) {
      for (let gx = 0; gx < 8 && points.length < 30; gx++) {
        const x = Math.round(vw * (0.05 + 0.9 * gx / 7));
        const y = Math.round(clamp(anchorScreenY - 150 + 300 * gy / 7, 5, vh - 5));
        if (!inOverlay(x, y)) points.push([x, y]);
      }
    }
    const pixels = samplePixels(shot, points);
    const swatches = [
      hexToRgb(SEASON_GROUND_HEX[season]), ...SEASON_COMPANION_HEX[season].map(hexToRgb),
      INK_RGB, ...WATER_RGB, dirtAvg,
    ];
    if (season === 'winter') swatches.push(winterOverlayAvg);
    const passFlags = pixels.map(p => withinPaletteTolerance(p, swatches, 40));
    results[season] = {
      camp: camp.label, hasPopup, landedOffset,
      overlayFile: band ? band.overlayFile : null,
      bandHasSnow: !!band && !!band.winter,
      passCount: passFlags.filter(Boolean).length,
      total: pixels.length,
    };
  }
  await context.close();
  return { results, missingSeasons };
}

/* ---------- main ---------- */

async function main() {
  const baseline = fs.existsSync(BASELINE_PATH) && !WRITE_BASELINE
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    : null;
  if (!baseline && !WRITE_BASELINE) {
    console.log('(no baseline.json found — checks run without regression comparison; ' +
      'pass --write-baseline once to record one)');
  }

  const smokeUrlEnv = process.env.SMOKE_URL;
  let server = null;
  let baseUrl = smokeUrlEnv;
  if (!baseUrl) {
    server = startServer(SAMPLE_FIXTURE);
    baseUrl = `http://127.0.0.1:${PORT}`;
    await waitForHttp200(`${baseUrl}/`, 20000, server);
  }

  let browser;
  let allOk = true;
  const newBaseline = {};

  try {
    browser = await chromium.launch();

    const profiles = [
      { name: 'desktop', contextOptions: { viewport: { width: 1440, height: 900 } },
        isLite: false, isReduced: false },
      { name: 'lite', contextOptions: { ...devices['iPhone 13'] },
        isLite: true, isReduced: false, checkNoAnim: false },
      { name: 'reduced', contextOptions: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' },
        isLite: false, isReduced: true, checkNoAnim: true },
    ];

    for (const profile of profiles) {
      const stats = await runProfile(browser, baseUrl, profile);
      const checks = evalProfile(stats, {
        isLite: profile.isLite, isReduced: profile.isReduced, isFlat: false,
        baseline: baseline ? baseline[profile.name] : null,
      });
      printProfileTable(stats, checks);
      if (checks.some(c => !c.ok)) allOk = false;
      newBaseline[profile.name] = {
        aliveBandsMax: stats.aliveBandsMax,
        aliveSurfacesMax: stats.aliveSurfacesMax,
        missingOverlaysMax: stats.missingOverlaysMax,
        attachedOverlaysMax: stats.attachedOverlaysMax,
        updateMsAvg: stats.updateMsAvg,
        updateMsWorst: stats.updateMsWorst,
        longTasks: stats.longTasks,
      };
    }

    // U4 scenario: ?ground=flat is a faithful rollback — nothing is ever
    // attached, and the page still renders cleanly.
    {
      const stats = await runProfile(browser, baseUrl, {
        name: 'desktop (?ground=flat)',
        contextOptions: { viewport: { width: 1440, height: 900 } },
        extraQuery: '&ground=flat', isFlat: true,
      });
      const checks = evalProfile(stats, { isLite: false, isReduced: false, isFlat: true, baseline: null });
      printProfileTable(stats, checks);
      if (checks.some(c => !c.ok)) allOk = false;
    }

    // U4 scenario: overlay requests blocked — the missingOverlays detector
    // must fire (this scenario PASSES when it does), and the ground must
    // still show something, never a blank/white area.
    {
      const r = await scenarioBlockedOverlay(browser, baseUrl);
      console.log('\n=== U4: blocked overlay requests ===');
      console.log(`missingOverlays=${r.missingOverlays}`);
      console.log(`  [${r.detectorFired ? 'PASS' : 'FAIL'}] missingOverlays detector fired (missingOverlays > 0)`);
      console.log(`  [${r.notAllOneColor ? 'PASS' : 'FAIL'}] sampled pixels are not all one color`);
      console.log(`  [${r.noBlankPixel ? 'PASS' : 'FAIL'}] no sampled pixel is blank/white`);
      if (!r.detectorFired || !r.notAllOneColor || !r.noBlankPixel) allOk = false;
    }

    // U4/KTD4 scenario: lookahead attach/detach snapshot at a fixed camera position.
    {
      const r = await scenarioLookahead(browser, baseUrl);
      console.log(`\n=== U4: lookahead attach/detach (camY=${r.camY.toFixed(0)}) ===`);
      for (const c of r.checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}`);
      if (r.checks.some(c => !c.ok)) allOk = false;
    }

    // Seam check: band boundary continuity (calibrated against a non-seam strip).
    {
      const r = await scenarioSeam(browser, baseUrl);
      console.log('\n=== Seam check (band boundary continuity) ===');
      console.log(`maxSeamDiff=${r.maxSeamDiff.toFixed(2)} typicalDiff=${r.typicalDiff.toFixed(2)} threshold=${r.threshold.toFixed(2)}`);
      console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] maxSeamDiff <= threshold`);
      if (!r.ok) allOk = false;
    }

    // AE5: seasonal ground palette.
    {
      const sample = JSON.parse(fs.readFileSync(SAMPLE_FIXTURE, 'utf8'));
      const r = await scenarioPalette(browser, baseUrl, sample);
      console.log('\n=== AE5: seasonal ground palette ===');
      if (r.missingSeasons.length) console.log(`  (info) fixture has no camp in: ${r.missingSeasons.join(', ')}`);
      for (const season of ['spring', 'summer', 'autumn', 'winter']) {
        const res = r.results[season];
        if (!res || res.skipped) { console.log(`  [SKIP] ${season}: no fixture camp`); continue; }
        const passRate = res.passCount / res.total;
        const ok = passRate >= 0.9;
        console.log(`  ${season} (${res.camp}): ${res.passCount}/${res.total} within palette+ink tolerance, hasPopup=${res.hasPopup}, overlayFile=${res.overlayFile}, bandHasSnow=${res.bandHasSnow}`);
        console.log(`    [${ok ? 'PASS' : 'FAIL'}] >= 90% of sampled ground pixels within tolerance`);
        if (!ok) allOk = false;
        if (season === 'winter') {
          const winterOk = res.bandHasSnow;
          console.log(`    [${winterOk ? 'PASS' : 'FAIL'}] winter band carries the ground-overlay-winter.webp snow rect`);
          if (!winterOk) allOk = false;
        }
      }
    }

    // AE2: a trail twice today's length must still keep alive bands <= 4
    // and attached overlays <= 6.
    // Needs a second server pointed at the long fixture — skipped when the
    // caller supplied an already-running server via SMOKE_URL.
    if (server) {
      stopServer(server);
      server = null;
      const sample = JSON.parse(fs.readFileSync(SAMPLE_FIXTURE, 'utf8'));
      const longFixturePath = path.join(os.tmpdir(), `journey-sample-long-${process.pid}.json`);
      fs.writeFileSync(longFixturePath, JSON.stringify(makeLongFixture(sample)));
      try {
        server = startServer(longFixturePath);
        await waitForHttp200(`${baseUrl}/`, 20000, server);
        const stats = await runProfile(browser, baseUrl,
          { name: 'AE2 (2x trail length, desktop)', contextOptions: { viewport: { width: 1440, height: 900 } } });
        const ok = stats.aliveBandsMax <= 4 && stats.attachedOverlaysMax <= 6;
        console.log(`\n=== AE2: double-length trail ===`);
        console.log(`aliveBandsMax=${stats.aliveBandsMax} attachedOverlaysMax=${stats.attachedOverlaysMax}`);
        console.log(`  [${stats.aliveBandsMax <= 4 ? 'PASS' : 'FAIL'}] aliveBands <= 4 on a trail twice today's length`);
        console.log(`  [${stats.attachedOverlaysMax <= 6 ? 'PASS' : 'FAIL'}] attachedOverlays <= 6 on a trail twice today's length`);
        if (!ok) allOk = false;
      } finally {
        fs.rmSync(longFixturePath, { force: true });
      }
    } else {
      console.log('\n=== AE2: double-length trail ===\n  SKIPPED (SMOKE_URL supplied; no server to repoint at the long fixture)');
    }
  } finally {
    if (browser) await browser.close();
    stopServer(server);
  }

  if (WRITE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
    console.log(`\nWrote baseline to ${BASELINE_PATH}`);
  }

  console.log(`\n${allOk ? 'ALL PROFILES PASS' : 'SMOKE FAILED'}`);
  process.exit(allOk ? 0 : 1);
}

process.on('SIGINT', () => process.exit(130));

main().catch(err => {
  console.error('journey-smoke: fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/*
 * Browser smoke test for the alpine journey (KTD7 / U3).
 *
 * What this measures and why:
 *   - "Frame time" here means the wall-clock duration of one journey.js
 *     update() call, read from window.__journeyStats.updateMs, NOT the
 *     interval between requestAnimationFrame callbacks. rAF cadence is
 *     pinned to the display refresh rate (60/120Hz) and says nothing about
 *     the cost of our own work; update() is the one function that does all
 *     of the site's per-frame camera/cull/DOM work, so its duration is the
 *     real budget every later unit (overlays, motion) has to fit inside.
 *   - aliveBands / aliveSurfaces come from the same hook, counted from the
 *     arrays journey.js already tracks for its own visibility culling, not
 *     a separate DOM walk.
 *   - missingOverlays is always 0 today: overlays don't exist until U4. It
 *     is reported so later units can watch it stay at 0 while visible.
 *   - Long tasks (>=50ms on the main thread) are read from a
 *     PerformanceObserver installed before the page loads.
 *
 * Runs three profiles (desktop, lite, reduced motion) against a Flask
 * server started in JOURNEY_FIXTURE mode (tests/fixtures/journey-sample.json),
 * sweeps the whole trail in fixed steps plus three instant teleports, and
 * checks the numbers against absolute ceilings and against
 * tests/smoke/baseline.json (small tolerance on frame-time metrics only,
 * since machines vary). Also runs the AE2 scenario: a fixture with twice
 * the trail length, checking alive bands still never exceeds 4.
 *
 * Usage:
 *   node journey-smoke.mjs                 # run and check against baseline
 *   node journey-smoke.mjs --write-baseline # record current numbers as baseline
 *   SMOKE_URL=http://localhost:8000 node journey-smoke.mjs   # use a server
 *     that's already running instead of spawning one (skips the AE2 pass,
 *     since that needs a second fixture the caller's server isn't using).
 */
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/journey-sample.json');
const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const PORT = 8000;
const WRITE_BASELINE = process.argv.includes('--write-baseline');
const SWEEP_STEPS = 20;
const CONSOLE_TIMEOUT_MS = 20000;

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

async function runProfile(browser, baseUrl, { name, contextOptions, checkNoAnim }) {
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
  await page.goto(`${baseUrl}/?t=day`, { waitUntil: 'load', timeout: CONSOLE_TIMEOUT_MS });

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

  const [statsLog, longTasks] = await page.evaluate(() => [window.__statsLog, window.__longTasks]);
  await context.close();

  const warm = statsLog.filter(s => s.frames > 20); // ignore ~20 warmup frames
  const updateTimes = warm.map(s => s.updateMs);
  const maxOf = key => statsLog.reduce((m, s) => Math.max(m, s[key]), 0);
  const loadLongTasks = longTasks.filter(t => t.start < sweepStartMark);
  const sweepLongTasks = longTasks.filter(t => t.start >= sweepStartMark);

  return {
    name,
    consoleErrors,
    expectedPhotoFailures,
    artBytes,
    aliveBandsMax: maxOf('aliveBands'),
    aliveSurfacesMax: maxOf('aliveSurfaces'),
    missingOverlaysMax: maxOf('missingOverlays'),
    updateMsAvg: updateTimes.length ? updateTimes.reduce((a, b) => a + b, 0) / updateTimes.length : 0,
    updateMsWorst: updateTimes.length ? Math.max(...updateTimes) : 0,
    longTasks: sweepLongTasks.length,
    loadLongTasks: loadLongTasks.length,
    loadLongTaskDurations: loadLongTasks.map(t => Math.round(t.dur)),
    animDetected,
    frameSamples: statsLog.length,
  };
}

/* ---------- ceilings + baseline comparison ---------- */

function evalProfile(stats, { isLite, isReduced, baseline }) {
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });

  add('console errors == 0', stats.consoleErrors.length === 0,
    stats.consoleErrors.length ? stats.consoleErrors.slice(0, 3).join(' | ') : 'none');
  add('aliveBands <= 4', stats.aliveBandsMax <= 4, `max ${stats.aliveBandsMax}`);
  add('missingOverlays == 0', stats.missingOverlaysMax === 0, `max ${stats.missingOverlaysMax}`);
  add('long tasks (>=50ms) == 0', stats.longTasks === 0, `${stats.longTasks}`);

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
    const tol = 1.25; // machines vary; only the timing metrics get slack
    add('updateMs avg <= baseline +25%', stats.updateMsAvg <= baseline.updateMsAvg * tol,
      `${stats.updateMsAvg.toFixed(2)} vs ${(baseline.updateMsAvg * tol).toFixed(2)}`);
    add('updateMs worst <= baseline +25%', stats.updateMsWorst <= baseline.updateMsWorst * tol,
      `${stats.updateMsWorst.toFixed(2)} vs ${(baseline.updateMsWorst * tol).toFixed(2)}`);
  }
  return checks;
}

/* ---------- reporting ---------- */

function printProfileTable(stats, checks) {
  console.log(`\n=== ${stats.name} ===`);
  console.log(
    `frames=${stats.frameSamples} aliveBandsMax=${stats.aliveBandsMax} ` +
    `aliveSurfacesMax=${stats.aliveSurfacesMax} missingOverlaysMax=${stats.missingOverlaysMax} ` +
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
        isLite: profile.isLite, isReduced: profile.isReduced,
        baseline: baseline ? baseline[profile.name] : null,
      });
      printProfileTable(stats, checks);
      if (checks.some(c => !c.ok)) allOk = false;
      newBaseline[profile.name] = {
        aliveBandsMax: stats.aliveBandsMax,
        aliveSurfacesMax: stats.aliveSurfacesMax,
        missingOverlaysMax: stats.missingOverlaysMax,
        updateMsAvg: stats.updateMsAvg,
        updateMsWorst: stats.updateMsWorst,
        longTasks: stats.longTasks,
      };
    }

    // AE2: a trail twice today's length must still keep alive bands <= 4.
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
        const ok = stats.aliveBandsMax <= 4;
        console.log(`\n=== AE2: double-length trail ===`);
        console.log(`aliveBandsMax=${stats.aliveBandsMax}`);
        console.log(`  [${ok ? 'PASS' : 'FAIL'}] aliveBands <= 4 on a trail twice today's length`);
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

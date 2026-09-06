#!/usr/bin/env node
/*
 * WebKit GPU-memory probe for the journey (the iPhone budget proxy).
 *
 * Playwright's WebKit shares Safari's SVG rendering code, and on Apple
 * platforms pattern tiles, masks and layer backing stores live in the
 * separate GPU process, not in the web-content process. This script loads
 * each URL variant at iPhone 13 size (3x DPR), flings the trail, and reports
 * the peak RSS of every WebKit process, split into gpu / web / other.
 * Compare variants against ?ground=flat: that is the pre-art build that
 * survived the phone. Found on 2026-09-06 that every <pattern>-filled
 * element costs a GPU tile buffer per band (about 20 MB at a 1024 tile).
 *
 * Usage (fixture server already running on :8000):
 *   JOURNEY_FIXTURE=tests/fixtures/journey-sample.json python app.py &
 *   cd tests/smoke && node webkit-gpu-memory.mjs ground=flat base tile=512 snow=off
 * Requires `npx playwright install webkit` once.
 */
import { webkit, devices } from 'playwright';
import { execSync } from 'node:child_process';
const variants = process.argv.slice(2);
function webContentRss() {
  // sum RSS (KB) of every WebKit web-content process spawned by Playwright's WebKit
  try {
    const out = execSync("ps -axo rss=,command= | grep -i 'webkit-2359' | grep -v grep", { encoding: 'utf8' });
    const rows = out.trim().split('\n').filter(Boolean).map(l => { const [rss, ...cmd] = l.trim().split(/\s+/); const c = cmd.join(' '); return [Number(rss), /GPU/i.test(c) ? 'gpu' : /WebContent|WebProcess/i.test(c) ? 'web' : 'other']; });
    globalThis.__bd = rows.reduce((m, [r, k]) => (m[k] = (m[k] || 0) + r, m), {});
    return rows.reduce((a, [r]) => a + r, 0);
  } catch { return 0; }
}
for (const v of variants) {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 120)));
  page.on('crash', () => errors.push('PAGE CRASHED'));
  const base = 'http://localhost:8000/';
  const url = base + (v === 'base' ? '?t=day' : '?t=day&' + v);
  let peak = 0;
  let peakBd = {}; const sampler = setInterval(() => { const t = webContentRss(); if (t > peak) { peak = t; peakBd = { ...globalThis.__bd }; } }, 150);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2500);
    const afterLoad = webContentRss();
    const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    for (const f of [1, 0, 1, 0, 0.5]) { await page.evaluate(y => window.scrollTo(0, y), Math.round(maxY * f)); await page.waitForTimeout(1500); }
    await page.waitForTimeout(1500);
    const stats = await page.evaluate(() => { const s = window.__journeyStats || {}; return { attached: s.attachedOverlays, alive: s.aliveBands, flat: s.flat }; }).catch(() => ({}));
    clearInterval(sampler);
    console.log(`${v.padEnd(22)} afterLoad=${(afterLoad/1024).toFixed(0)}MB peak=${(peak/1024).toFixed(0)}MB (gpu=${((peakBd.gpu||0)/1024).toFixed(0)} web=${((peakBd.web||0)/1024).toFixed(0)} other=${((peakBd.other||0)/1024).toFixed(0)}) attached=${stats.attached} alive=${stats.alive} flat=${stats.flat} errors=${errors.length ? errors.join(' | ') : 'none'}`);
  } catch (e) {
    clearInterval(sampler);
    console.log(`${v.padEnd(22)} FAILED peak=${(peak/1024).toFixed(0)}MB ${String(e).slice(0, 160)} errors=${errors.join(' | ')}`);
  }
  await browser.close();
}

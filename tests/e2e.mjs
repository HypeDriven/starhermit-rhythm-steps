// Rhythm Steps — verified automated QA playthrough (playwright-core + system Chrome).
//
// Drives the REAL visible UI only: button clicks, touchscreen taps on the lane
// buttons, and real keyboard presses (D/F/J/K lanes, Escape pause). Game state
// (window.RhythmSteps: phase/chart/session) is read solely for synchronization
// and note-timing decisions — every action goes through on-screen controls.
//
// Two passes: desktop 1280x800, then a fresh context at mobile 390x844 with
// touch. Both must pass; any non-benign console/page error fails the run.
//
// Run: npm run test:e2e

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOT = (stage, tag) => `/tmp/rhythm-steps-e2e-${stage}-${tag}.png`;
const LANE_KEYS = ['d', 'f', 'j', 'k'];

// Benign GPU/swiftshader noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ts': 'text/plain',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
      if (!path) path = 'index.html';
      const file = join(ROOT, path);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runPass(browser, { tag, viewport, hasTouch }) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`); });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${tag}] ${name}`);
  };
  const phase = () => page.evaluate(() => window.RhythmSteps.getPhase());
  const songNow = () => page.evaluate(() => window.RhythmSteps.getSession()?.songTimeMs() ?? -1);

  // Hit one note through the real UI: keyboard on desktop, touchscreen lane
  // buttons on mobile. Holds are held down for their duration on desktop;
  // on mobile a tap registers the head (release is early but legitimate play).
  const hitNote = async (note, waited) => {
    // Measure the live clock after locating the target; locator actionability
    // and previous input round trips must not accumulate into timing drift.
    const box = hasTouch ? await page.locator(`.lane-btn[data-lane="${note.lane}"]`).boundingBox() : null;
    if (hasTouch && !box) throw new Error('lane button is not visible');
    const wait = note.time - await songNow() - 40;
    if (wait > 0) await page.waitForTimeout(wait);
    if (hasTouch) {
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      const key = LANE_KEYS[note.lane];
      await page.keyboard.down(key);
      await page.waitForTimeout(note.kind === 'hold' ? Math.min(note.duration, 2000) : 60);
      await page.keyboard.up(key);
    }
    return Math.max(waited, note.time);
  };

  try {
    await step('load → title screen visible', async () => {
      await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
      await page.waitForSelector('#screen-title:not(.hidden)', { timeout: 10000 });
      await page.waitForFunction(() => window.RhythmSteps?.getPhase() === 'title');
      await page.waitForSelector('#canvas-host canvas');
      await page.screenshot({ path: SHOT('title', tag) });
    });

    await step('journey grid renders 40 stages with locks', async () => {
      await page.click('[data-mode="journey"]');
      await page.waitForSelector('#screen-journey:not(.hidden)');
      const stages = await page.locator('.stage-btn').count();
      if (stages !== 40) throw new Error(`expected 40 stages, got ${stages}`);
      const locked = await page.locator('.stage-btn.locked').count();
      if (locked === 0) throw new Error('expected locked stages on a fresh save');
      await page.screenshot({ path: SHOT('journey', tag) });
    });

    await step('stage 1 → setup screen', async () => {
      await page.locator('.stage-btn:not(.locked)').first().click();
      await page.waitForSelector('#screen-setup:not(.hidden)');
      await page.waitForSelector('#btn-setup-start');
      await page.screenshot({ path: SHOT('setup', tag) });
    });

    await step('start → countdown → active play', async () => {
      await page.click('#btn-setup-start');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'countdown', null, { timeout: 8000 });
      await page.screenshot({ path: SHOT('countdown', tag) });
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active', null, { timeout: 10000 });
      if (await page.locator('#playfield').isHidden()) throw new Error('playfield not visible');
    });

    await step('hit opening notes on beat via real inputs', async () => {
      const notes = await page.evaluate(() => {
        const s = window.RhythmSteps.getSession();
        return window.RhythmSteps.getChart().notes.slice(0, 8)
          .map((n) => ({ lane: n.lane, kind: n.kind, duration: n.duration, time: n.time }))
          .filter((n) => n.time > s.songTimeMs() + 100);
      });
      let waited = await songNow();
      for (const n of notes) waited = await hitNote(n, waited);
      await page.waitForTimeout(250);
      const score = await page.evaluate(() => window.RhythmSteps.getSession().state.score.total);
      const hits = await page.evaluate(() => {
        const c = window.RhythmSteps.getSession().state.counts;
        return c.perfect + c.great + c.good;
      });
      if (hits === 0 || score <= 0) throw new Error(`no hits registered (score ${score})`);
      console.log(`  [${tag}] ${hits} hits, score ${score}`);
      await page.screenshot({ path: SHOT('play', tag) });
    });

    await step('pause freezes simulation, resume continues', async () => {
      if (hasTouch) await page.locator('#btn-pause').tap();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      if (await phase() !== 'paused') throw new Error('phase not paused');
      const t1 = await page.evaluate(() => window.RhythmSteps.getSession().state.tick);
      await page.waitForTimeout(500);
      const t2 = await page.evaluate(() => window.RhythmSteps.getSession().state.tick);
      if (t1 !== t2) throw new Error('simulation advanced while paused');
      await page.screenshot({ path: SHOT('pause', tag) });
      await page.click('#btn-resume');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active');
    });

    await step('pause → settings overlay → back leaves the game paused', async () => {
      if (hasTouch) await page.locator('#btn-pause').tap();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-pause-settings');
      await page.waitForSelector('#screen-settings:not(.hidden)');
      // Escape (or Back) must close the panel only — never resume underneath it.
      if (hasTouch) await page.click('#screen-settings [data-nav="back"]');
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#screen-settings', { state: 'hidden' });
      if (await phase() !== 'paused') throw new Error('game resumed while the settings panel was closing');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-resume');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active');
    });

    await step('play to natural completion → results screen', async () => {
      // Keep hitting remaining notes through the UI until the track ends.
      const deadline = await page.evaluate(() => window.RhythmSteps.getChart().durationMs + 12000);
      const start = Date.now();
      while (Date.now() - start < deadline) {
        const next = await page.evaluate(() => {
          const s = window.RhythmSteps.getSession();
          if (!s || window.RhythmSteps.getPhase() !== 'active') return null;
          const now = s.songTimeMs();
          const n = window.RhythmSteps.getChart().notes.find((x) => x.time > now + 60);
          return n ? { lane: n.lane, kind: n.kind, duration: n.duration, time: n.time, now } : { done: true };
        });
        if (!next) break; // left active phase (results incoming)
        if (next.done) { await page.waitForTimeout(500); continue; }
        await hitNote(next, next.now);
      }
      await page.waitForSelector('#screen-results:not(.hidden)', { timeout: 15000 });
      const grade = await page.textContent('#results-grade');
      const headline = await page.textContent('#results-headline');
      if (!grade.trim() || !headline.trim()) throw new Error('results not populated');
      console.log(`  [${tag}] grade ${grade.trim()} — "${headline.trim()}"`);
      await page.screenshot({ path: SHOT('results', tag) });
    });

    await step('progress persisted to save', async () => {
      const save = await page.evaluate(() => JSON.parse(localStorage.getItem('rhythm-steps:save')));
      if (!save || save.stats.sessionsPlayed < 1) throw new Error('session not persisted');
      if (save.journey.unlocked < 2) throw new Error(`stage 2 not unlocked (unlocked=${save.journey.unlocked})`);
    });

    await step('next stage → pause → leave track → title', async () => {
      if (await page.locator('#btn-next').isVisible()) await page.click('#btn-next');
      else await page.click('#btn-retry');
      await page.waitForSelector('#screen-setup:not(.hidden)');
      await page.click('#btn-setup-start');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active', null, { timeout: 10000 });
      if (hasTouch) await page.locator('#btn-pause').tap();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-leave');
      await page.waitForSelector('#screen-title:not(.hidden)');
    });

    await step('settings open/change/close', async () => {
      await page.click('[data-nav="settings"]');
      await page.waitForSelector('#screen-settings:not(.hidden)');
      const binds = await page.locator('.keybind-btn').count();
      if (binds !== 4) throw new Error(`expected 4 key bindings, got ${binds}`);
      await page.locator('#set-reduced-motion').check();
      if (!(await page.locator('#set-reduced-motion').isChecked())) throw new Error('setting did not apply');
      await page.screenshot({ path: SHOT('settings', tag) });
      await page.locator('#set-reduced-motion').uncheck(); // leave save as found
      await page.click('#screen-settings [data-nav="back"]');
      await page.waitForSelector('#screen-title:not(.hidden)');
    });

    await step('practice mode starts a track', async () => {
      await page.click('[data-mode="practice"]');
      await page.waitForSelector('#screen-practice:not(.hidden)');
      await page.locator('#practice-list .btn').first().click(); // Calm
      await page.waitForSelector('#screen-setup:not(.hidden)');
      await page.click('#btn-setup-start');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active', null, { timeout: 10000 });
      await page.screenshot({ path: SHOT('practice', tag) });
      if (hasTouch) await page.locator('#btn-pause').tap();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-leave');
      await page.waitForSelector('#screen-title:not(.hidden)');
    });

    await step('challenge restart keeps the health modifier', async () => {
      await page.click('[data-mode="challenge"]');
      await page.waitForSelector('#screen-challenge:not(.hidden)');
      await page.locator('#challenge-list .btn').nth(2).click(); // Thin Ice (failEnabled)
      await page.waitForSelector('#screen-setup:not(.hidden)');
      await page.click('#btn-setup-start');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active', null, { timeout: 10000 });
      const failOn = () => page.evaluate(() => !!window.RhythmSteps.getSession()?.state.failEnabled);
      if (!(await failOn())) throw new Error('challenge did not start with health enabled');
      if (hasTouch) await page.locator('#btn-pause').tap();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-pause-restart');
      await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active', null, { timeout: 12000 });
      if (!(await failOn())) throw new Error('restart dropped the challenge health modifier');
      // The HUD refreshes on a 120ms cadence, so wait for the readout to appear.
      await page.waitForSelector('#hud-health:not(.hidden)', { timeout: 3000 });
      if (hasTouch) await page.locator('#btn-pause').tap();
      else await page.keyboard.press('Escape');
      await page.waitForSelector('#overlay-pause:not(.hidden)');
      await page.click('#btn-leave');
      await page.waitForSelector('#screen-title:not(.hidden)');
    });

    if (errors.length) throw new Error(`non-benign page errors:\n${errors.join('\n')}`);
    console.log(`ok - [${tag}] no console/page errors`);
  } finally {
    await context.close();
  }
}

let server, browser;
try {
  server = await startServer();
  var port = server.address().port;
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });

  await runPass(browser, { tag: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false });
  await runPass(browser, { tag: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true });

  console.log('\nE2E PASS — both desktop and mobile playthroughs completed with no page errors');
} catch (e) {
  console.error('E2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
  try { server?.close(); } catch {}
}

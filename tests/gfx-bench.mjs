// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts the densest challenge (Sharp Eyes, 130 BPM streams) and plays it through the real inputs — lane
// keys on desktop, the on-screen lane buttons on phones — so notes stream, receptors flash, beat rings
// pulse and hit sparks fly the whole time; a finished run is retried from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };
const LANE_KEYS = ['d', 'f', 'j', 'k'];

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.RhythmSteps?.getPhase() === 'title', null, { timeout: 20000 });
  await page.click('[data-nav="settings"]');
  await page.waitForSelector('#gfx-controls #set-quality');
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#screen-settings [data-nav="back"]');
  await page.waitForSelector('#screen-title:not(.hidden)');
}

const phase = (page) => page.evaluate(() => window.RhythmSteps.getPhase());

async function begin(page) {
  await page.waitForSelector('#screen-setup:not(.hidden)');
  await page.click('#btn-setup-start');
  await page.waitForFunction(() => window.RhythmSteps.getPhase() === 'active', null, { timeout: 12000 });
}

async function step(page, mobile) {
  const next = await page.evaluate(() => {
    const s = window.RhythmSteps.getSession();
    if (!s || window.RhythmSteps.getPhase() !== 'active') return { phase: window.RhythmSteps.getPhase() };
    const now = s.songTimeMs();
    const n = window.RhythmSteps.getChart().notes.find((x) => x.time > now + 60);
    return n ? { lane: n.lane, time: n.time, now } : { done: true };
  });
  if (next.phase === 'results' || (await page.locator('#screen-results:not(.hidden)').count())) {
    await page.click('#btn-retry');
    return begin(page);
  }
  if (next.phase || next.done) return page.waitForTimeout(300);
  const box = mobile ? await page.locator(`.lane-btn[data-lane="${next.lane}"]`).boundingBox() : null;
  const wait = next.time - next.now - 40;
  if (wait > 0) await page.waitForTimeout(wait);
  if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else { await page.keyboard.down(LANE_KEYS[next.lane]); await page.waitForTimeout(50); await page.keyboard.up(LANE_KEYS[next.lane]); }
}

export async function start(page, { mobile } = {}) {
  await page.click('[data-mode="challenge"]');
  await page.waitForSelector('#screen-challenge:not(.hidden)');
  await page.locator('#challenge-list .btn').nth(4).click(); // Sharp Eyes: dense streams at speed
  await begin(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page, mobile); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); await page.waitForTimeout(200).catch(() => {}); }
    }
  })();
  await page.waitForTimeout(1000);
  if (await phase(page) !== 'active') throw new Error('benchmark run did not start');
}

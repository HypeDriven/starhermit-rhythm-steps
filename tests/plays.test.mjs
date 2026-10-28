// The play-script bot (tools/gen-plays.mjs) and its timing model: every
// chart the game can deal is cleared all-Perfect by presses on the nearest
// fixed step (chords and releases pushed to free frames included), so the
// native scripts' expectations hold; and the scripts in tests/native are the
// generator's current output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { keyRun, touchRun, tickOf, START } from '../tools/gen-plays.mjs';
import { journeyChart, JOURNEY_STAGES, practiceChart, PRACTICE_DIFFICULTIES, challengeChart, CHALLENGES, lessonChart, LESSONS, dailyChart } from '../js/content.js';

test('fixed steps map to the rules ticks the game judges', () => {
  assert.equal(tickOf(0), 0);
  assert.equal(tickOf(60), 1000);
  assert.equal(tickOf(1), 17);
  assert.equal(START, 144, 'the countdown: 4 × 36 steps');
});

test('the bot clears every chart all-Perfect by keys', () => {
  const charts = [
    ...JOURNEY_STAGES.map((_, i) => journeyChart(i)),
    ...PRACTICE_DIFFICULTIES.map((d) => practiceChart(d.key, null, 'neon-causeway')),
    ...CHALLENGES.map((c) => challengeChart(c.key)),
    ...LESSONS.map((l) => lessonChart(l.id)),
    dailyChart('2026-10-28'), dailyChart('2026-10-29'), dailyChart('2026-10-30'),
  ];
  for (const c of charts) {
    const { b } = keyRun(c);
    assert.equal(b.counts.perfect, c.notes.length, c.id);
    assert.equal(b.terminalReason, 'complete', c.id);
    assert.equal(b.counts.earlyReleases, 0, c.id);
  }
});

test('the lesson track by touches is all-Perfect too', () => {
  const c = lessonChart('lesson-tap');
  assert.equal(touchRun(c).b.counts.perfect, c.notes.length);
});

test('the committed play scripts are the generator\'s output', () => {
  const names = ['journey.play', 'practice-holds.play', 'learn-phone.play', 'challenge-fail.play', 'chase.play'];
  const before = names.map((n) => readFileSync(new URL(`native/${n}`, import.meta.url), 'utf8'));
  execFileSync(process.execPath, [new URL('../tools/gen-plays.mjs', import.meta.url).pathname], { stdio: 'ignore' });
  names.forEach((n, i) => assert.equal(readFileSync(new URL(`native/${n}`, import.meta.url), 'utf8'), before[i], n));
});

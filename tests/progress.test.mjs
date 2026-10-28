// The engine save model (js/progress.js): normalizing, merging two devices'
// copies, migrating the browser build's cloud slot and settings, and the
// legacy settings keys. Signed-in paths can't be driven headlessly here, so
// their logic is covered by these unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank, normalize, merge, same, pickOptions, readForeign, isLegacyKey, OPTION_DEFAULTS, OPTION_KEYS } from '../js/progress.js';
import { defaultSave, writeSave } from '../js/persistence.js';

/** The old cloud slot: the whole save document written by writeSave (checksummed), as JSON text. */
function oldSlot(edit) {
  const doc = defaultSave();
  edit(doc);
  const store = new Map();
  writeSave(doc, { setItem: (k, v) => store.set(k, v) });
  return [...store.values()][0];
}

test('a new player starts at stage 1 with nothing earned and no settings in the save', () => {
  const b = blank();
  assert.equal(b.journey.unlocked, 1);
  assert.deepEqual(b.achievements, {});
  assert.equal(b.settings, undefined);
  assert.equal(b.checksum, undefined);
  assert.equal(b.mastery.level, 1);
});

test('normalize repairs broken parts', () => {
  const n = normalize({ journey: { unlocked: 99, stars: 'x' }, mastery: { xp: 400 }, daily: { history: null } });
  assert.equal(n.journey.unlocked, 40);
  assert.deepEqual(n.journey.stars, {});
  assert.equal(n.mastery.level, 3);
  assert.deepEqual(n.daily.history, {});
  assert.deepEqual(normalize('nonsense'), blank());
});

test('two devices merge without losing progress on either side', () => {
  const a = blank(), b = blank();
  a.journey.unlocked = 5; a.journey.stars = { 0: 3, 1: 1 }; a.lessons = { 'lesson-tap': true };
  a.daily.history = { '2026-10-01': { score: 500, grade: 'A' } };
  a.chaseBoards = { 42: [{ name: 'A', score: 10, total: 10, grade: 'D', sessionId: 's1' }] };
  b.journey.unlocked = 3; b.journey.stars = { 1: 2, 2: 3 }; b.achievements = { 'first-light': 5 };
  b.daily.history = { '2026-10-01': { score: 900, grade: 'S' } };
  b.chaseBoards = { 42: [{ name: 'B', score: 20, total: 20, grade: 'C', sessionId: 's2' }, { name: 'A', score: 10, total: 10, grade: 'D', sessionId: 's1' }] };
  b.mastery = { xp: 900, level: 4 };
  const m = merge(a, b);
  assert.equal(m.journey.unlocked, 5);
  assert.deepEqual(m.journey.stars, { 0: 3, 1: 2, 2: 3 });
  assert.equal(m.daily.history['2026-10-01'].score, 900);
  assert.ok(m.lessons['lesson-tap'] && m.achievements['first-light']);
  assert.equal(m.chaseBoards[42].length, 2, 'boards dedupe by session id');
  assert.equal(m.mastery.level, 4);
  assert.ok(same(merge(m, a), m), 'merging again changes nothing');
});

test("the browser build's cloud slot migrates with its options", () => {
  const text = oldSlot((d) => {
    d.journey.unlocked = 7; d.journey.bestScores = { 5: 4200 }; d.stats.sessionsPlayed = 12;
    d.settings.leftHanded = true; d.settings.holdMode = 'toggle'; d.settings.noteSpeed = 1.37; d.settings.volMusic = 0.2;
  });
  const r = readForeign(text);
  assert.equal(r.progress.journey.unlocked, 7);
  assert.equal(r.progress.journey.bestScores[5], 4200);
  assert.equal(r.progress.stats.sessionsPlayed, 12);
  assert.equal(r.progress.settings, undefined);
  assert.deepEqual(r.options, { leftHanded: true, holdMode: 'toggle', timingAssist: 'off', cvdPalette: false, captions: true, haptics: true, cameraSway: true, noteSpeed: 1.4 });
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign('{"hello":1}'), null);
  // a v1 document migrates as the old loader did
  const v1 = JSON.parse(oldSlot((d) => { d.journey.unlocked = 4; }));
  v1.version = 1; delete v1.mastery;
  assert.equal(readForeign(JSON.stringify(v1)).progress.journey.unlocked, 4);
});

test('options keep only well-typed values', () => {
  assert.deepEqual(pickOptions({ leftHanded: 'yes', holdMode: 'sticky', timingAssist: 'wide', noteSpeed: 9, captions: false }),
    { timingAssist: 'wide', noteSpeed: 1.6, captions: false });
  assert.deepEqual(Object.keys(OPTION_DEFAULTS), OPTION_KEYS);
});

test('every settings key the browser build wrote is legacy, the controls are not', () => {
  for (const k of ['volMusic', 'muted', 'gfx', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'noteSpeed', 'telemetryConsent', 'ui.language', 'audio.options', 'graphics.gpu.abc']) assert.ok(isLegacyKey(k), k);
  for (const k of ['keys', 'pauseKey', 'lane1', 'something']) assert.ok(!isLegacyKey(k), k);
});

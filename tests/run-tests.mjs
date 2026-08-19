// Rhythm Steps — test suite (Node, no deps).
// Covers: legal actions, invalid-action reasons, scoring components, terminal
// states, serialization/migration, replay determinism (property), fuzzing of
// malformed commands and generated content, golden sessions, validators,
// tie-break ordering, achievements, and the authoritative server script.
//
// Run: node tests/run-tests.mjs

import { strict as assert } from 'node:assert';
import {
  createGame, applyCommand, advance, legalActions, hashState, serialize,
  scoreBreakdown, compareResults, replayEnvelope, letterGrade,
  WINDOWS, TERMINAL, RULES_VERSION,
} from '../js/rules.js';
import {
  generateChart, validateChart, journeyChart, JOURNEY_STAGES, dailyChart,
  practiceChart, challengeChart, CHALLENGES, PRACTICE_DIFFICULTIES, LESSONS, lessonChart,
} from '../js/content.js';
import { makeRng, dailySeed, hashString } from '../js/rng.js';
import {
  defaultSave, loadSave, writeSave, unlockAchievement, starsForResult, SAVE_VERSION,
} from '../js/persistence.js';
import { handleMessage } from '../server.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// Helpers -------------------------------------------------------------------
function autoPlay(chart, deltaFn = () => 0) {
  const s = createGame(chart);
  const cmds = [];
  for (const n of chart.notes) {
    cmds.push({ id: `t${n.id}`, tick: n.time + deltaFn(n), type: 'tap', lane: n.lane });
    if (n.kind === 'hold') cmds.push({ id: `r${n.id}`, tick: n.time + n.duration, type: 'release', lane: n.lane });
  }
  cmds.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
  for (const c of cmds) applyCommand(s, c);
  advance(s, chart.durationMs + 5000);
  return s;
}
const mockStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};

// --- Legal actions ---------------------------------------------------------
console.log('\n[legal actions]');
test('tap hit perfect at exact note time', () => {
  const chart = generateChart({ id: 't', seed: 1, bpm: 100, beats: 16, density: 0.5 });
  const s = createGame(chart);
  const n = chart.notes[0];
  const r = applyCommand(s, { id: 'a', tick: n.time, type: 'tap', lane: n.lane });
  assert.equal(r.reason, 'hit');
  assert.equal(r.grade, 'perfect');
  assert.equal(s.combo, 1);
});

test('grade boundaries: perfect/great/good windows', () => {
  const chart = generateChart({ id: 't2', seed: 7, bpm: 100, beats: 32, density: 1 });
  for (const [delta, grade] of [[0, 'perfect'], [WINDOWS.perfect, 'perfect'], [WINDOWS.perfect + 1, 'great'], [WINDOWS.great, 'great'], [WINDOWS.great + 1, 'good'], [WINDOWS.good, 'good']]) {
    const s = createGame(chart);
    const n = chart.notes[0];
    const r = applyCommand(s, { id: 'x', tick: n.time + delta, type: 'tap', lane: n.lane });
    assert.equal(r.grade, grade, `delta ${delta} should be ${grade}`);
  }
});

test('late tap beyond window is empty-hit (note already missed by advance)', () => {
  const chart = generateChart({ id: 't3', seed: 3, bpm: 100, beats: 16, density: 0.5 });
  const s = createGame(chart);
  const n = chart.notes[0];
  const r = applyCommand(s, { id: 'x', tick: n.time + WINDOWS.good + 50, type: 'tap', lane: n.lane });
  assert.equal(r.reason, 'empty-hit');
  assert.equal(s.counts.miss, 1, 'note auto-missed on advance');
  assert.equal(s.invalidActions, 1);
});

test('hold lifecycle: hit head, sustain ticks, release completes', () => {
  const chart = generateChart({ id: 't4', seed: 11, bpm: 90, beats: 24, density: 1, holdRatio: 1 });
  const hold = chart.notes.find((n) => n.kind === 'hold');
  assert.ok(hold, 'chart has a hold');
  const s = createGame(chart);
  applyCommand(s, { id: 'h', tick: hold.time, type: 'tap', lane: hold.lane });
  const before = s.score.holdBonus;
  advance(s, hold.time + hold.duration + 10);
  assert.ok(s.score.holdBonus >= before, 'sustain scored');
  const n = s.notes.find((x) => x.id === hold.id);
  assert.equal(n.state, 'hit', 'auto-completed at tail');
});

test('early release breaks combo and reports reason', () => {
  const chart = generateChart({ id: 't5', seed: 11, bpm: 90, beats: 24, density: 1, holdRatio: 1 });
  const hold = chart.notes.find((n) => n.kind === 'hold');
  const s = createGame(chart);
  applyCommand(s, { id: 'h', tick: hold.time, type: 'tap', lane: hold.lane });
  const r = applyCommand(s, { id: 'r', tick: hold.time + 50, type: 'release', lane: hold.lane });
  assert.equal(r.reason, 'early-release');
  assert.equal(s.combo, 0);
  assert.equal(s.counts.earlyReleases, 1);
});

test('release with nothing held is a no-op', () => {
  const chart = generateChart({ id: 't6', seed: 5, bpm: 100, beats: 16, density: 0.5 });
  const s = createGame(chart);
  const r = applyCommand(s, { id: 'r', tick: 100, type: 'release', lane: 0 });
  assert.equal(r.reason, 'nothing-held');
});

test('duplicate command id rejected idempotently', () => {
  const chart = generateChart({ id: 't7', seed: 5, bpm: 100, beats: 16, density: 0.5 });
  const s = createGame(chart);
  const n = chart.notes[0];
  const cmd = { id: 'dup', tick: n.time, type: 'tap', lane: n.lane };
  applyCommand(s, cmd);
  const r = applyCommand(s, cmd);
  assert.equal(r.reason, 'duplicate-ignored');
  assert.equal(s.counts.perfect, 1, 'not double-counted');
});

test('legalActions exposes per-lane actionable notes', () => {
  const chart = generateChart({ id: 't8', seed: 9, bpm: 100, beats: 16, density: 0.6 });
  const s = createGame(chart);
  const n = chart.notes[0];
  advance(s, n.time);
  const legal = legalActions(s);
  assert.equal(legal[n.lane].noteId, n.id);
  assert.equal(legal[n.lane].action, 'tap');
});

// --- Invalid actions --------------------------------------------------------
console.log('\n[invalid actions]');
test('invalid commands return reasons, never throw', () => {
  const chart = generateChart({ id: 'i1', seed: 2, bpm: 100, beats: 16, density: 0.5 });
  const cases = [
    [null, 'game-not-active-or-malformed'],
    [{}, 'malformed'],
    [{ type: 'warp', tick: 0, lane: 0 }, 'unknown-command-type'],
    [{ type: 'tap', tick: 0, lane: 9 }, 'lane-out-of-bounds'],
    [{ type: 'tap', tick: -5, lane: 0 }, 'tick-out-of-bounds'],
    [{ type: 'tap', tick: 1e9, lane: 0 }, 'tick-out-of-bounds'],
  ];
  for (const [cmd, _expect] of cases) {
    const s = createGame(chart);
    const r = applyCommand(s, cmd);
    assert.equal(r.ok === false || r.reason !== 'hit', true);
  }
  const s = createGame(chart);
  assert.equal(applyCommand(s, null).reason, 'malformed-command');
  assert.equal(applyCommand(s, {}).ok, false);
  assert.equal(applyCommand(s, { type: 'warp', tick: 0, lane: 0 }).reason, 'unknown-command-type');
  assert.equal(applyCommand(s, { type: 'tap', tick: 0, lane: 9 }).reason, 'lane-out-of-bounds');
  assert.equal(applyCommand(s, { type: 'tap', tick: -5, lane: 0 }).reason, 'tick-out-of-bounds');
});

test('commands after terminal are rejected', () => {
  const chart = generateChart({ id: 'i2', seed: 2, bpm: 100, beats: 16, density: 0.5 });
  const s = createGame(chart);
  applyCommand(s, { id: 'q', tick: 0, type: 'abort', lane: -1 });
  assert.equal(s.status, 'terminal');
  assert.equal(applyCommand(s, { id: 'z', tick: 100, type: 'tap', lane: 0 }).reason, 'game-not-active');
});

// --- Scoring components ------------------------------------------------------
console.log('\n[scoring]');
test('score components: base + comboBonus + holdBonus = total', () => {
  const chart = journeyChart(12);
  const s = autoPlay(chart);
  const b = scoreBreakdown(s);
  assert.equal(b.total, b.base + b.comboBonus + b.holdBonus);
  assert.ok(b.base > 0 && b.comboBonus > 0, 'combo bonus accrues');
});

test('combo bonus grows with combo', () => {
  const chart = generateChart({ id: 's2', seed: 21, bpm: 120, beats: 40, density: 1 });
  const s = autoPlay(chart);
  const b = scoreBreakdown(s);
  assert.ok(b.comboBonus > chart.notes.length, 'bonus scales past flat rate');
});

test('miss resets combo; maxCombo preserved', () => {
  const chart = generateChart({ id: 's3', seed: 22, bpm: 100, beats: 24, density: 0.7 });
  const s = createGame(chart);
  applyCommand(s, { id: 'a', tick: chart.notes[0].time, type: 'tap', lane: chart.notes[0].lane });
  const n2 = chart.notes.find((n) => n.id !== chart.notes[0].id);
  advance(s, n2.time + 500); // let it miss
  assert.equal(s.combo, 0);
  assert.equal(s.maxCombo, 1);
});

test('tie-break ordering: completion, invalid actions, elapsed, session id', () => {
  const base = { total: 1000, invalidActions: 0, elapsedMs: 60000, sessionId: 'a', terminalReason: 'complete' };
  assert.ok(compareResults(base, { ...base, terminalReason: 'failed' }) < 0);
  assert.ok(compareResults(base, { ...base, invalidActions: 1 }) < 0);
  assert.ok(compareResults(base, { ...base, elapsedMs: 61000 }) < 0);
  assert.ok(compareResults(base, { ...base, sessionId: 'b' }) < 0);
  assert.ok(compareResults({ ...base, total: 900 }, base) > 0);
});

test('letter grades across accuracy range', () => {
  const chart = journeyChart(0);
  assert.equal(letterGrade(autoPlay(chart)), 'SSS');
  const sloppy = autoPlay(chart, (n) => ((n.id * 53) % 120) - 60);
  assert.ok(['SS', 'S', 'A', 'B'].includes(letterGrade(sloppy)), `got ${letterGrade(sloppy)}`);
});

// --- Terminal states ----------------------------------------------------------
console.log('\n[terminal states]');
test('complete when all notes resolved past duration', () => {
  const s = autoPlay(journeyChart(1));
  assert.equal(s.status, 'terminal');
  assert.equal(s.terminalReason, TERMINAL.COMPLETE);
});

test('abort is terminal with reason', () => {
  const s = createGame(journeyChart(0));
  applyCommand(s, { id: 'q', tick: 10, type: 'abort', lane: -1 });
  assert.equal(s.terminalReason, TERMINAL.ABORTED);
});

test('fail mode: health depletion ends the run', () => {
  const chart = generateChart({ id: 'f1', seed: 30, bpm: 140, beats: 64, density: 1 });
  const s = createGame(chart, { failEnabled: true });
  advance(s, chart.durationMs + 5000); // miss everything
  assert.equal(s.terminalReason, TERMINAL.FAILED);
  assert.equal(letterGrade(s), 'F');
});

// --- Serialization / migration -------------------------------------------------
console.log('\n[serialization]');
test('serialize is stable; hash is deterministic', () => {
  const s = autoPlay(journeyChart(2));
  assert.equal(serialize(s), serialize(s));
  assert.equal(hashState(s), hashState(s));
});

test('save migration v1 → v2 and checksum verification', () => {
  const storage = mockStorage();
  const v1 = { ...defaultSave(), version: 1 };
  delete v1.mastery; delete v1.chaseBoards;
  v1.checksum = 0;
  storage.setItem('rhythm-steps:save', JSON.stringify(v1));
  const loaded = loadSave(storage);
  assert.equal(loaded.version, SAVE_VERSION);
  assert.ok(loaded.mastery && loaded.chaseBoards);
});

test('corrupted save resets to default safely', () => {
  const storage = mockStorage();
  storage.setItem('rhythm-steps:save', '{"version":2,"checksum":123,"broken');
  const loaded = loadSave(storage);
  assert.equal(loaded.version, SAVE_VERSION);
  const storage2 = mockStorage();
  const doc = defaultSave();
  writeSave(doc, storage2);
  const tampered = JSON.parse(storage2.getItem('rhythm-steps:save'));
  tampered.stats.totalScore = 99999999; // tamper without fixing checksum
  storage2.setItem('rhythm-steps:save', JSON.stringify(tampered));
  assert.equal(loadSave(storage2).stats.totalScore, 0, 'tampered save rejected');
});

// --- Replay determinism (property tests) ----------------------------------------
console.log('\n[replay determinism]');
test('property: same version+seed+commands → identical hashes (30 random runs)', () => {
  const rng = makeRng(4242);
  for (let i = 0; i < 30; i++) {
    const chart = generateChart({
      id: `p${i}`, seed: rng.int(1, 1e9), bpm: rng.int(90, 150), beats: rng.int(24, 64),
      density: 0.4 + rng.next() * 0.5, holdRatio: rng.next() * 0.4, chordRatio: rng.next() * 0.3,
    });
    const s = createGame(chart);
    for (const n of chart.notes) {
      const delta = rng.int(-200, 300);
      applyCommand(s, { id: `t${n.id}`, tick: Math.max(0, n.time + delta), type: 'tap', lane: n.lane });
      if (n.kind === 'hold' && rng.chance(0.8)) {
        applyCommand(s, { id: `r${n.id}`, tick: n.time + Math.floor(n.duration * rng.next()), type: 'release', lane: n.lane });
      }
    }
    advance(s, chart.durationMs + 5000);
    const r = replayEnvelope(chart, { rulesVersion: RULES_VERSION, commands: s.commandLog });
    assert.ok(r.ok);
    assert.equal(r.hash, hashState(s), `run ${i} hash mismatch`);
  }
});

test('golden: easy / medium / hard perfect runs hit expected grades', () => {
  const cases = [[journeyChart(0), 'SSS'], [journeyChart(15), 'SSS'], [journeyChart(39), 'SSS']];
  for (const [chart, grade] of cases) {
    const s = autoPlay(chart);
    assert.equal(s.terminalReason, 'complete');
    assert.equal(letterGrade(s), grade);
    assert.equal(scoreBreakdown(s).total, chart.par, 'perfect run reaches par');
  }
});

test('golden: interrupted (aborted) session replays identically', () => {
  const chart = journeyChart(5);
  const s = createGame(chart);
  const half = chart.notes.slice(0, Math.floor(chart.notes.length / 2));
  for (const n of half) applyCommand(s, { id: `t${n.id}`, tick: n.time, type: 'tap', lane: n.lane });
  applyCommand(s, { id: 'abort', tick: half[half.length - 1].time + 10, type: 'abort', lane: -1 });
  const r = replayEnvelope(chart, { rulesVersion: RULES_VERSION, commands: s.commandLog });
  assert.equal(r.hash, hashState(s));
  assert.equal(r.state.terminalReason, 'aborted');
});

test('golden: all-miss session completes with zero score', () => {
  const chart = journeyChart(3);
  const s = createGame(chart);
  advance(s, chart.durationMs + 5000);
  const b = scoreBreakdown(s);
  assert.equal(s.terminalReason, 'complete');
  assert.equal(b.total, 0);
  assert.equal(b.counts.miss, chart.notes.length);
});

// --- Content validation + fuzz ---------------------------------------------------
console.log('\n[content]');
test('all 40 journey stages validate and are playable', () => {
  assert.equal(JOURNEY_STAGES.length, 40);
  for (let i = 0; i < 40; i++) {
    const chart = journeyChart(i);
    const v = validateChart(chart);
    assert.ok(v.ok, `stage ${i}: ${v.errors.join(',')}`);
    assert.ok(chart.notes.length > 0);
  }
});

test('all challenges, practice difficulties, lessons validate', () => {
  for (const c of CHALLENGES) assert.ok(validateChart(challengeChart(c.key)).ok, c.key);
  for (const d of PRACTICE_DIFFICULTIES) assert.ok(validateChart(practiceChart(d.key)).ok, d.key);
  for (const l of LESSONS) assert.ok(validateChart(lessonChart(l.id)).ok, l.id);
});

test('daily seed immutable per UTC date; chart regenerates identically', () => {
  const a = dailyChart('2026-08-18');
  const b = dailyChart('2026-08-18');
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.notes, b.notes);
  assert.equal(dailySeed('2026-08-18'), dailySeed('2026-08-18'));
  assert.notEqual(dailySeed('2026-08-18'), dailySeed('2026-08-19'));
});

test('fuzz: 200 random generator parameter sets never hang or produce invalid charts', () => {
  const rng = makeRng(999);
  for (let i = 0; i < 200; i++) {
    const chart = generateChart({
      id: `fz${i}`, seed: rng.int(0, 2 ** 31), bpm: rng.int(60, 240), beats: rng.int(8, 96),
      density: rng.next(), holdRatio: rng.next() * 0.6, chordRatio: rng.next() * 0.5,
      streamRatio: rng.next() * 0.6, minGapBeats: 0.25 + rng.next(),
    });
    assert.ok(validateChart(chart).ok);
    assert.ok(chart.durationMs > 0 && chart.durationMs <= 600000);
    for (const n of chart.notes) assert.ok(Number.isFinite(n.time), 'no NaN note times');
  }
});

test('fuzz: 500 malformed commands never throw, hang, or corrupt state', () => {
  const rng = makeRng(31337);
  const chart = journeyChart(4);
  const s = createGame(chart);
  for (let i = 0; i < 500; i++) {
    const cmd = {
      id: rng.chance(0.5) ? `f${rng.int(0, 50)}` : undefined,
      tick: rng.int(-1000, chart.durationMs + 10000),
      type: rng.pick(['tap', 'release', 'abort', 'warp', null, 42]),
      lane: rng.int(-5, 12),
    };
    applyCommand(s, cmd);
    if (s.status !== 'active') break;
  }
  advance(s, chart.durationMs + 5000);
  assert.ok(Number.isFinite(s.score.total));
  const h = hashState(s);
  assert.ok(typeof h === 'string' && h.length === 8);
});

test('validator rejects broken charts', () => {
  assert.ok(!validateChart(null).ok);
  assert.ok(!validateChart({}).ok);
  assert.ok(!validateChart({ id: 'x', seed: 1, bpm: 500, notes: [], durationMs: 1000 }).ok);
  assert.ok(!validateChart({ id: 'x', seed: 1, bpm: 100, notes: [{ time: 0, lane: 9, kind: 'tap' }], durationMs: 1000 }).ok);
  assert.ok(!validateChart({ id: 'x', seed: 1, bpm: 100, notes: [{ time: 0, lane: 0, kind: 'tap' }, { time: 10, lane: 0, kind: 'tap' }], durationMs: 1000 }).ok, 'overlap');
});

// --- Achievements ---------------------------------------------------------------
console.log('\n[achievements]');
test('achievement unlocks are idempotent; unknown keys rejected', () => {
  const save = defaultSave();
  assert.ok(unlockAchievement(save, 'first-light'));
  assert.ok(!unlockAchievement(save, 'first-light'));
  assert.ok(!unlockAchievement(save, 'not-a-key'));
});

test('stars: 0 for fail, up to 3 for clean accurate run', () => {
  const perfect = scoreBreakdown(autoPlay(journeyChart(0)));
  assert.equal(starsForResult(perfect), 3);
  assert.equal(starsForResult({ terminalReason: 'failed' }), 0);
});

// --- Authoritative server ---------------------------------------------------------
console.log('\n[server]');
const serverCtx = () => {
  const store = new Map();
  return { identity: 'tester', now: () => Date.now(), store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) } };
};

test('server accepts a valid daily envelope and rejects tampering', () => {
  const chart = dailyChart('2026-08-18');
  const s = autoPlay(chart);
  const env = {
    rulesVersion: RULES_VERSION, contentVersion: chart.version, chartId: chart.id,
    seed: chart.seed, commands: s.commandLog, terminal: { hash: hashState(s) },
  };
  const ok = handleMessage(serverCtx(), { kind: 'validate-score', envelope: env });
  assert.ok(ok.ok && ok.accepted, JSON.stringify(ok));
  const bad = handleMessage(serverCtx(), { kind: 'validate-score', envelope: { ...env, terminal: { hash: '00000000' } } });
  assert.equal(bad.error, 'hash-mismatch');
  const stale = handleMessage(serverCtx(), { kind: 'validate-score', envelope: { ...env, rulesVersion: 999 } });
  assert.equal(stale.error, 'stale-version');
});

test('server rejects malformed, out-of-order, oversized, unknown messages', () => {
  const ctx = serverCtx();
  assert.equal(handleMessage(ctx, null).error, 'malformed-message');
  assert.equal(handleMessage(ctx, { kind: 'nope' }).error, 'unknown-kind');
  assert.equal(handleMessage(ctx, { kind: 'validate-score', envelope: {} }).error, 'stale-version');
  const chart = dailyChart('2026-08-18');
  const env = { rulesVersion: RULES_VERSION, contentVersion: chart.version, chartId: chart.id, seed: chart.seed, commands: [
    { id: 'b', tick: 500, type: 'tap', lane: 0 }, { id: 'a', tick: 100, type: 'tap', lane: 0 },
  ], terminal: { hash: 'x' } };
  assert.equal(handleMessage(ctx, { kind: 'validate-score', envelope: env }).error, 'commands-out-of-order');
});

test('server achievement delivery is idempotent and rate limiting kicks in', () => {
  const ctx = serverCtx();
  assert.ok(handleMessage(ctx, { kind: 'unlock-achievement', key: 'first-light' }).unlocked);
  assert.ok(handleMessage(ctx, { kind: 'unlock-achievement', key: 'first-light' }).already);
  assert.equal(handleMessage(ctx, { kind: 'unlock-achievement', key: 'hax' }).error, 'unknown-achievement');
  const chart = dailyChart('2026-08-18');
  const s = autoPlay(chart);
  const env = { rulesVersion: RULES_VERSION, contentVersion: chart.version, chartId: chart.id, seed: chart.seed, commands: s.commandLog, terminal: { hash: hashState(s) } };
  let limited = false;
  for (let i = 0; i < 7; i++) {
    const r = handleMessage(ctx, { kind: 'validate-score', envelope: env });
    if (r.error === 'rate-limited') { limited = true; break; }
  }
  assert.ok(limited, 'rate limit triggers after 5 submissions/min');
});

// --- RNG ---------------------------------------------------------------------------
console.log('\n[rng]');
test('rng is seeded and serializable; streams are independent', () => {
  const a = makeRng(42), b = makeRng(42);
  const seqA = [a.next(), a.next(), a.next()];
  const stateB = b.getState();
  b.next(); b.next(); b.next();
  assert.equal(b.next() === makeRng(42).next() , false); // consumed
  const c = makeRng(42);
  c.setState(stateB);
  // c should now reproduce b's full sequence from start
  assert.equal(c.next(), seqA[0]);
  assert.equal(hashString('x') >>> 0, hashString('x'));
});

// ------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

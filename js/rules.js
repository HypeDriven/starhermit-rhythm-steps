// Rhythm Steps — rules engine.
// Pure deterministic state transitions, independent from rendering.
// Exposes: legal-action queries, deterministic resolution, serializable state,
// a monotonically increasing tick, and a terminal-state reason.
// No DOM, no rendering imports — safe to run in Node for tests and for the
// authoritative validation script (server.js).

import { hashString } from './rng.js';

export const RULES_VERSION = 1;
export const LANES = 4;

// Calibrated timing windows (milliseconds, absolute delta from note time).
export const WINDOWS = Object.freeze({
  perfect: 45,
  great: 90,
  good: 135,
});
export const MISS_WINDOW = WINDOWS.good; // beyond this an un-hit note is missed
export const HOLD_RELEASE_GRACE = 120; // releasing this early still completes the hold
export const HOLD_TICK_MS = 100; // hold sustain scores every 100 ms

export const GRADE_SCORE = Object.freeze({ perfect: 300, great: 200, good: 100 });
export const MISS_HEALTH = 12;         // health lost per miss (fail-enabled modes)
export const EMPTY_HIT_HEALTH = 2;

export const TERMINAL = Object.freeze({
  COMPLETE: 'complete', // track finished
  FAILED: 'failed',     // health depleted
  ABORTED: 'aborted',   // player quit (not ranked)
});

let nextCommandSeq = 0; // presentation-only uniqueness helper; ids also carry tick

export function makeCommandId(tick, lane, type) {
  nextCommandSeq = (nextCommandSeq + 1) >>> 0;
  return `c${tick}:${lane}:${type}:${nextCommandSeq}`;
}

function cloneNote(n) {
  return {
    id: n.id, time: n.time, lane: n.lane, kind: n.kind, duration: n.duration,
    state: n.state, grade: n.grade, hitDelta: n.hitDelta,
    holdScoredMs: n.holdScoredMs, released: n.released,
  };
}

// ---------------------------------------------------------------------------
// Chart shape (produced by content.js, consumed here):
// { id, version, seed, bpm, durationMs, notes: [{id,time,lane,kind,duration}], ... }
// ---------------------------------------------------------------------------

export function createGame(chart, options = {}) {
  if (!chart || !Array.isArray(chart.notes)) throw new Error('invalid chart');
  const notes = chart.notes.map((n, i) => ({
    id: n.id != null ? n.id : i,
    time: n.time | 0,
    lane: n.lane | 0,
    kind: n.kind === 'hold' ? 'hold' : 'tap',
    duration: n.kind === 'hold' ? Math.max(HOLD_TICK_MS, n.duration | 0) : 0,
    state: 'pending', // pending | hit | holding | missed | released
    grade: null,
    hitDelta: null,
    holdScoredMs: 0,
    released: false,
  }));
  notes.sort((a, b) => a.time - b.time || a.lane - b.lane || a.id - b.id);

  return {
    rulesVersion: RULES_VERSION,
    chartId: chart.id,
    chartVersion: chart.version,
    seed: chart.seed >>> 0,
    bpm: chart.bpm,
    durationMs: chart.durationMs | 0,
    tick: 0, // authoritative song position in ms; monotonically increasing
    status: 'active',
    terminalReason: null,
    failEnabled: !!options.failEnabled,
    health: 100,
    notes,
    combo: 0,
    maxCombo: 0,
    score: { base: 0, comboBonus: 0, holdBonus: 0, total: 0 },
    counts: { perfect: 0, great: 0, good: 0, miss: 0, emptyHits: 0, earlyReleases: 0 },
    invalidActions: 0,
    startedAtTick: 0,
    finishedAtTick: null,
    commandLog: [], // ordered authoritative inputs (replay source of truth)
  };
}

// ---------------------------------------------------------------------------
// Legal-action queries — tutorials and hints call this same API.
// Returns, per lane, the nearest actionable note and the current window.
// ---------------------------------------------------------------------------
export function legalActions(state) {
  const out = [];
  for (let lane = 0; lane < LANES; lane++) {
    let best = null;
    for (const n of state.notes) {
      if (n.lane !== lane) continue;
      if (n.state === 'pending') {
        const delta = state.tick - n.time;
        if (delta <= MISS_WINDOW && delta >= -MISS_WINDOW * 4) {
          best = { noteId: n.id, action: 'tap', kind: n.kind, time: n.time, delta };
          break;
        }
        if (delta < -MISS_WINDOW * 4) break; // sorted; nothing closer
      } else if (n.state === 'holding') {
        best = { noteId: n.id, action: 'release', kind: 'hold', time: n.time + n.duration, delta: state.tick - (n.time + n.duration) };
        break;
      }
    }
    out.push(best);
  }
  return out;
}

function gradeForDelta(absDelta) {
  if (absDelta <= WINDOWS.perfect) return 'perfect';
  if (absDelta <= WINDOWS.great) return 'great';
  if (absDelta <= WINDOWS.good) return 'good';
  return null;
}

function comboBonusFor(combo) {
  // +2 per hit per 10 combo, capped at +100.
  return Math.min(100, Math.floor(combo / 10) * 2);
}

function recomputeTotal(state) {
  state.score.total = state.score.base + state.score.comboBonus + state.score.holdBonus;
}

// ---------------------------------------------------------------------------
// applyCommand — the only way to mutate rules state. Returns a result object;
// never throws on bad input (fuzz-safe), reports invalid reasons instead.
// Duplicate command ids are rejected idempotently.
// ---------------------------------------------------------------------------
export function applyCommand(state, command) {
  if (state.status !== 'active') {
    return { ok: false, reason: 'game-not-active' };
  }
  if (!command || typeof command !== 'object') {
    state.invalidActions++;
    return { ok: false, reason: 'malformed-command' };
  }
  const { type, lane } = command;
  const tick = command.tick | 0;
  if (command.id && state.commandLog.some((c) => c.id === command.id)) {
    return { ok: true, reason: 'duplicate-ignored', idempotent: true };
  }
  if (type !== 'tap' && type !== 'release' && type !== 'abort') {
    state.invalidActions++;
    return { ok: false, reason: 'unknown-command-type' };
  }
  if (type !== 'abort' && (!(lane >= 0 && lane < LANES))) {
    state.invalidActions++;
    return { ok: false, reason: 'lane-out-of-bounds' };
  }
  if (tick < 0 || tick > state.durationMs + 5000) {
    state.invalidActions++;
    return { ok: false, reason: 'tick-out-of-bounds' };
  }

  // Advance simulation to the command's tick first (authoritative ordering).
  advance(state, tick);
  if (state.status !== 'active') return { ok: false, reason: 'game-not-active' };

  const logged = { id: command.id || makeCommandId(tick, lane, type), tick, type, lane };
  state.commandLog.push(logged);

  if (type === 'abort') {
    state.status = 'terminal';
    state.terminalReason = TERMINAL.ABORTED;
    state.finishedAtTick = state.tick;
    return { ok: true, reason: 'aborted' };
  }

  if (type === 'tap') return resolveTap(state, lane, tick);
  return resolveRelease(state, lane, tick);
}

function resolveTap(state, lane, tick) {
  // Find nearest pending note in this lane within the window.
  let target = null;
  let bestAbs = Infinity;
  for (const n of state.notes) {
    if (n.lane !== lane || n.state !== 'pending') continue;
    const delta = tick - n.time;
    if (delta < -MISS_WINDOW) break; // sorted by time; later notes are farther
    const abs = Math.abs(delta);
    if (abs <= MISS_WINDOW && abs < bestAbs) { target = n; bestAbs = abs; }
  }
  if (!target) {
    state.counts.emptyHits++;
    state.invalidActions++;
    if (state.failEnabled) applyHealth(state, -EMPTY_HIT_HEALTH);
    return { ok: true, reason: 'empty-hit', grade: null };
  }
  const delta = tick - target.time;
  const grade = gradeForDelta(Math.abs(delta));
  target.grade = grade;
  target.hitDelta = delta;
  if (target.kind === 'hold') {
    target.state = 'holding';
  } else {
    target.state = 'hit';
  }
  state.counts[grade]++;
  state.combo++;
  if (state.combo > state.maxCombo) state.maxCombo = state.combo;
  state.score.base += GRADE_SCORE[grade];
  state.score.comboBonus += comboBonusFor(state.combo);
  recomputeTotal(state);
  return { ok: true, reason: 'hit', grade, noteId: target.id, kind: target.kind, delta };
}

function resolveRelease(state, lane, tick) {
  let target = null;
  for (const n of state.notes) {
    if (n.lane === lane && n.state === 'holding') { target = n; break; }
  }
  if (!target) {
    // Releasing with nothing held is a no-op, not an error (touch noise).
    return { ok: true, reason: 'nothing-held' };
  }
  const tailTime = target.time + target.duration;
  const remaining = tailTime - tick;
  target.released = true;
  if (remaining > HOLD_RELEASE_GRACE) {
    target.state = 'released';
    state.counts.earlyReleases++;
    state.combo = 0;
    if (state.failEnabled) applyHealth(state, -MISS_HEALTH / 2);
    recomputeTotal(state);
    return { ok: true, reason: 'early-release', noteId: target.id, remaining };
  }
  // Close enough: complete the hold and award the remaining sustain.
  const extra = Math.max(0, Math.floor((target.duration - target.holdScoredMs) / HOLD_TICK_MS));
  state.score.holdBonus += extra * 10;
  target.holdScoredMs = target.duration;
  target.state = 'hit';
  recomputeTotal(state);
  return { ok: true, reason: 'hold-complete', noteId: target.id };
}

function applyHealth(state, delta) {
  state.health = Math.max(0, Math.min(100, state.health + delta));
  if (state.failEnabled && state.health <= 0 && state.status === 'active') {
    state.status = 'terminal';
    state.terminalReason = TERMINAL.FAILED;
    state.finishedAtTick = state.tick;
  }
}

// ---------------------------------------------------------------------------
// advance — deterministic time progression. Auto-misses expired notes,
// awards hold sustain ticks, detects track completion.
// ---------------------------------------------------------------------------
export function advance(state, toTick) {
  const target = Math.min(Math.max(toTick | 0, state.tick), state.durationMs + 5000);
  if (state.status !== 'active') { state.tick = Math.max(state.tick, Math.min(toTick | 0, state.tick)); return state; }

  for (const n of state.notes) {
    if (n.state === 'pending' && target > n.time + MISS_WINDOW) {
      n.state = 'missed';
      n.grade = 'miss';
      state.counts.miss++;
      state.combo = 0;
      if (state.failEnabled) applyHealth(state, -MISS_HEALTH);
      if (state.status !== 'active') { state.tick = target; return state; }
    } else if (n.state === 'holding') {
      const tail = n.time + n.duration;
      const heldMs = Math.max(0, Math.min(target, tail) - n.time);
      const newScored = Math.floor(heldMs / HOLD_TICK_MS) * HOLD_TICK_MS;
      if (newScored > n.holdScoredMs) {
        state.score.holdBonus += Math.floor((newScored - n.holdScoredMs) / HOLD_TICK_MS) * 10;
        n.holdScoredMs = newScored;
      }
      if (target >= tail) {
        // Reached the tail still held: auto-complete.
        const extra = Math.max(0, Math.floor((n.duration - n.holdScoredMs) / HOLD_TICK_MS));
        if (extra > 0) { state.score.holdBonus += extra * 10; n.holdScoredMs = n.duration; }
        n.state = 'hit';
      }
    }
  }
  recomputeTotal(state);
  state.tick = target;

  if (state.status === 'active' && state.tick >= state.durationMs) {
    let unresolved = false;
    for (const n of state.notes) {
      if (n.state === 'pending' || n.state === 'holding') { unresolved = true; break; }
    }
    if (!unresolved) {
      state.status = 'terminal';
      state.terminalReason = TERMINAL.COMPLETE;
      // Normalize the end tick so replayed sessions hash identically
      // regardless of how far past the end the driver advanced.
      state.finishedAtTick = state.durationMs;
      state.tick = state.durationMs;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Accuracy / grades / breakdown (results screen shows components, not one total)
// ---------------------------------------------------------------------------
export function accuracy(state) {
  const { perfect, great, good, miss } = state.counts;
  const total = perfect + great + good + miss;
  if (total === 0) return 0;
  const weighted = perfect * 1 + great * 0.7 + good * 0.4;
  return weighted / total;
}

export function letterGrade(state) {
  const acc = accuracy(state);
  if (state.terminalReason === TERMINAL.FAILED) return 'F';
  if (state.counts.miss === 0 && state.counts.good === 0 && state.counts.great === 0 && state.counts.perfect > 0) return 'SSS';
  if (acc >= 0.97) return 'SS';
  if (acc >= 0.93) return 'S';
  if (acc >= 0.85) return 'A';
  if (acc >= 0.75) return 'B';
  if (acc >= 0.6) return 'C';
  return 'D';
}

export function scoreBreakdown(state) {
  return {
    base: state.score.base,
    comboBonus: state.score.comboBonus,
    holdBonus: state.score.holdBonus,
    total: state.score.total,
    maxCombo: state.maxCombo,
    counts: { ...state.counts },
    accuracy: accuracy(state),
    grade: letterGrade(state),
    terminalReason: state.terminalReason,
    elapsedMs: state.finishedAtTick != null ? state.finishedAtTick : state.tick,
    invalidActions: state.invalidActions,
  };
}

// Tie-break ordering: primary objective completion, fewer invalid actions,
// lower authoritative elapsed time, then stable session identifier.
export function compareResults(a, b) {
  const doneA = a.terminalReason === TERMINAL.COMPLETE ? 1 : 0;
  const doneB = b.terminalReason === TERMINAL.COMPLETE ? 1 : 0;
  if (doneA !== doneB) return doneB - doneA;
  if (a.total !== b.total) return b.total - a.total;
  if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
}

// Normalize a score-chase board entry to the fields compareResults reads, so
// legacy locally-saved entries that lack tie-break fields still order sanely.
export function chaseEntry(e) {
  return {
    total: e.total ?? e.score ?? 0,
    invalidActions: e.invalidActions ?? 0,
    elapsedMs: e.elapsedMs ?? 0,
    terminalReason: e.terminalReason ?? TERMINAL.COMPLETE,
    sessionId: e.sessionId ?? '',
  };
}

// ---------------------------------------------------------------------------
// Serialization + deterministic hashing (replay envelope state hashes)
// ---------------------------------------------------------------------------
export function serialize(state) {
  return JSON.stringify({
    rulesVersion: state.rulesVersion,
    chartId: state.chartId,
    chartVersion: state.chartVersion,
    seed: state.seed,
    tick: state.tick,
    status: state.status,
    terminalReason: state.terminalReason,
    health: Math.round(state.health * 100) / 100,
    notes: state.notes.map((n) => [n.id, n.state, n.grade, n.hitDelta, n.holdScoredMs, n.released ? 1 : 0]),
    combo: state.combo,
    maxCombo: state.maxCombo,
    score: state.score,
    counts: state.counts,
    invalidActions: state.invalidActions,
    finishedAtTick: state.finishedAtTick,
  });
}

export function hashState(state) {
  return hashString(serialize(state)).toString(16).padStart(8, '0');
}

export function deserialize(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (d.rulesVersion !== RULES_VERSION) throw new Error(`unsupported rules version ${d.rulesVersion}`);
  return d; // snapshots are consumed read-only by renderers
}

// Replay: rebuild a game from an envelope and verify terminal hash.
export function replayEnvelope(chart, envelope) {
  if (!envelope || envelope.rulesVersion !== RULES_VERSION) {
    return { ok: false, reason: 'unsupported-envelope' };
  }
  const state = createGame(chart, { failEnabled: !!envelope.failEnabled });
  const seen = new Set();
  for (const cmd of envelope.commands) {
    if (seen.has(cmd.id)) continue; // idempotent duplicate rejection
    seen.add(cmd.id);
    applyCommand(state, cmd);
  }
  advance(state, state.durationMs + 5000);
  return { ok: true, state, hash: hashState(state), breakdown: scoreBreakdown(state) };
}

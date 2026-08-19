// Session: drives one playthrough. Owns the authoritative song clock, sends
// validated commands to the rules engine, records the replay envelope, and
// emits logical events for render/UI/audio. No rendering here.

import {
  createGame, applyCommand, advance, hashState, scoreBreakdown,
  legalActions, makeCommandId, RULES_VERSION,
} from './rules.js';
import { audio } from './audio.js';
import { hashString } from './rng.js';

export const BUILD_VERSION = '1.0.0';

export class GameSession {
  constructor({ chart, mode = 'practice', failEnabled = false, assists = {}, onEvent = null }) {
    this.chart = chart;
    this.mode = mode;
    this.assists = { timingAssist: 'off', ...assists };
    this.onEvent = onEvent || (() => {});
    this.state = createGame(chart, { failEnabled });
    this.sessionId = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.clockOffsetMs = 0;      // performance clock start
    this.pausedAccumMs = 0;
    this.pauseStart = null;
    this.running = false;
    this.finished = false;
    this.envelope = {
      schemaVersion: 1,
      buildVersion: BUILD_VERSION,
      rulesVersion: RULES_VERSION,
      contentVersion: chart.version,
      chartId: chart.id,
      seed: chart.seed,
      initialHash: hashState(this.state),
      assists: this.assists,
      mode,
      commands: [],
      stateHashes: [], // periodic hashes for anti-tamper spot checks
      terminal: null,
    };
    this._lastHashAt = 0;
    this._lastHoldTickCount = 0;
    this._prevHolding = new Set();
  }

  // Authoritative song position in ms. Prefers the audio clock (sample-accurate);
  // falls back to a pausable performance clock when audio is unavailable.
  songTimeMs() {
    if (!this.running) return this.state.tick;
    if (this.pauseStart != null) return this._pausedSongMs;
    const fromAudio = audio.songTimeMs();
    if (fromAudio != null) return Math.round(fromAudio);
    return Math.round(performance.now() - this.clockOffsetMs - this.pausedAccumMs);
  }

  start() {
    this.running = true;
    this.clockOffsetMs = performance.now();
    this.pausedAccumMs = 0;
    audio.setSfxSeed(this.chart.seed);
  }

  pause() {
    if (!this.running || this.pauseStart != null || this.finished) return;
    this._pausedSongMs = this.songTimeMs();
    this.pauseStart = performance.now();
    audio.suspendAll();
  }

  resume() {
    if (this.pauseStart == null) return;
    this.pausedAccumMs += performance.now() - this.pauseStart;
    this.pauseStart = null;
    audio.resumeAll();
  }

  get paused() { return this.pauseStart != null; }

  // Timing assist widens windows by pulling the command tick toward the note
  // time. The transformed command is what gets logged — replay stays exact.
  _assistTick(lane, rawTick) {
    if (this.assists.timingAssist !== 'wide') return rawTick;
    let best = null, bestAbs = Infinity;
    for (const n of this.state.notes) {
      if (n.lane !== lane || n.state !== 'pending') continue;
      const d = Math.abs(rawTick - n.time);
      if (d < bestAbs) { bestAbs = d; best = n; }
      if (n.time - rawTick > 400) break;
    }
    if (!best || bestAbs > 240) return rawTick;
    return Math.round(best.time + (rawTick - best.time) / 1.5);
  }

  tap(lane) {
    if (this.finished || this.paused) return;
    const raw = this.songTimeMs();
    const tick = this._assistTick(lane, raw);
    const cmd = { id: makeCommandId(tick, lane, 'tap'), tick, type: 'tap', lane };
    const res = applyCommand(this.state, cmd);
    this._record(cmd, res);
    if (res.reason === 'hit') {
      this.onEvent({ type: 'hit', lane, grade: res.grade, kind: res.kind, noteId: res.noteId, delta: res.delta, combo: this.state.combo, tick });
      if (res.kind === 'hold') this._prevHolding.add(res.noteId);
    } else if (res.reason === 'empty-hit') {
      this.onEvent({ type: 'empty-hit', lane, tick });
    }
  }

  release(lane) {
    if (this.finished || this.paused) return;
    const tick = this.songTimeMs();
    const cmd = { id: makeCommandId(tick, lane, 'release'), tick, type: 'release', lane };
    const res = applyCommand(this.state, cmd);
    if (res.reason === 'hold-complete') {
      this._record(cmd, res);
      this._prevHolding.delete(res.noteId);
      this.onEvent({ type: 'hold-complete', lane, noteId: res.noteId, tick });
    } else if (res.reason === 'early-release') {
      this._record(cmd, res);
      this._prevHolding.delete(res.noteId);
      this.onEvent({ type: 'early-release', lane, noteId: res.noteId, tick });
    }
    // 'nothing-held' is touch noise: not logged, keeps replays lean.
  }

  _record(cmd, res) {
    if (res.ok && !res.idempotent && !['empty-hit', 'nothing-held'].includes(res.reason)) {
      this.envelope.commands.push(cmd);
    } else if (res.reason === 'empty-hit') {
      this.envelope.commands.push(cmd); // empty hits affect scoring; keep them
    }
    if (res.reason === 'aborted') this._finalize();
  }

  abort() {
    if (this.finished) return;
    const tick = this.songTimeMs();
    applyCommand(this.state, { id: makeCommandId(tick, -1, 'abort'), tick, type: 'abort', lane: -1 });
    this._finalize();
  }

  // Called every frame by the host loop.
  update() {
    if (!this.running || this.finished || this.paused) return;
    const t = this.songTimeMs();
    const prevMiss = this.state.counts.miss;
    const prevHoldBonus = this.state.score.holdBonus;
    advance(this.state, t);

    // Emit auto events caused by time progression.
    if (this.state.counts.miss > prevMiss) {
      for (const n of this.state.notes) {
        if (n.state === 'missed' && !n._reported) { n._reported = true; this.onEvent({ type: 'miss', lane: n.lane, noteId: n.id, tick: t }); }
      }
    }
    if (this.state.score.holdBonus > prevHoldBonus) {
      this._lastHoldTickCount++;
      if (this._lastHoldTickCount % 4 === 0) this.onEvent({ type: 'hold-tick', tick: t });
    }
    // Holds that auto-completed at the tail.
    for (const id of [...this._prevHolding]) {
      const n = this.state.notes.find((x) => x.id === id);
      if (n && n.state === 'hit') {
        this._prevHolding.delete(id);
        this.onEvent({ type: 'hold-complete', lane: n.lane, noteId: n.id, tick: t });
      }
    }

    if (t - this._lastHashAt >= 1000) {
      this._lastHashAt = t;
      this.envelope.stateHashes.push({ tick: this.state.tick, hash: hashState(this.state) });
    }

    if (this.state.status === 'terminal') this._finalize();
  }

  _finalize() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    audio.stopMusic();
    const breakdown = scoreBreakdown(this.state);
    breakdown.sessionId = this.sessionId;
    this.envelope.terminal = {
      reason: this.state.terminalReason,
      hash: hashState(this.state),
      breakdown,
      finishedAtTick: this.state.finishedAtTick,
    };
    this.onEvent({ type: 'terminal', breakdown, envelope: this.envelope });
  }

  // Live snapshot for render/UI. Rendering consumes this read-only.
  snapshot() {
    return {
      tick: this.state.tick,
      durationMs: this.chart.durationMs,
      notes: this.state.notes,
      combo: this.state.combo,
      maxCombo: this.state.maxCombo,
      score: this.state.score,
      counts: this.state.counts,
      health: this.state.health,
      failEnabled: this.state.failEnabled,
      status: this.state.status,
      legal: legalActions(this.state),
      bpm: this.chart.bpm,
      running: this.running && !this.paused,
    };
  }
}

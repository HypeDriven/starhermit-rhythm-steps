// One playthrough, as the browser build's js/session.js drove it: commands to
// the rules engine, the replay envelope, and the logical events for render,
// UI and audio. The difference is the clock: the browser build read the song
// position from the AudioContext (falling back to performance.now()); here
// the song position is the runtime's fixed steps (main.ts counts them), so a
// run judges every press against the same tick on every machine, in play
// scripts and checks alike, and pauses or slow frames never move it. The
// music follows that clock (audio.ts), not the other way round.
import { Rules, type Breakdown, type Chart, type Command, type CommandResult, type RulesState } from "./game.ts";

export const BUILD_VERSION = "1.0.0";
export type SessionEvent =
  | { type: "hit"; lane: number; grade: "perfect" | "great" | "good"; kind: string; noteId: number; delta: number; combo: number; tick: number }
  | { type: "empty-hit"; lane: number; tick: number }
  | { type: "hold-complete"; lane: number; noteId: number; tick: number }
  | { type: "early-release"; lane: number; noteId: number; tick: number }
  | { type: "miss"; lane: number; noteId: number; tick: number }
  | { type: "hold-tick"; tick: number }
  | { type: "terminal"; breakdown: Breakdown };

let sessionCounter = 0;

export class Session {
  readonly chart: Chart;
  readonly mode: string;
  readonly state: RulesState;
  readonly sessionId: string;
  readonly assists: { timingAssist: string };
  finished = false;
  private onEvent: (e: SessionEvent) => void;
  private reported = new Set<number>();
  private holding = new Set<number>();
  private holdTicks = 0;
  readonly commands: Command[] = [];

  constructor(chart: Chart, mode: string, opts: { failEnabled: boolean; timingAssist: string }, onEvent: (e: SessionEvent) => void) {
    this.chart = chart;
    this.mode = mode;
    this.assists = { timingAssist: opts.timingAssist };
    this.onEvent = onEvent;
    this.state = Rules.createGame(chart, { failEnabled: opts.failEnabled });
    // unique per run (seed boards merge across devices by it); never read by the rules
    this.sessionId = `s${Date.now().toString(36)}${(++sessionCounter).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  /** Timing assist (Wide): pulls the press toward the nearest note, 1.5× the windows (the logged tick is the pulled one). */
  private assistTick(lane: number, raw: number): number {
    if (this.assists.timingAssist !== "wide") return raw;
    let best = null as null | { time: number }, bestAbs = Infinity;
    for (const n of this.state.notes) {
      if (n.lane !== lane || n.state !== "pending") continue;
      const d = Math.abs(raw - n.time);
      if (d < bestAbs) { bestAbs = d; best = n; }
      if (n.time - raw > 400) break;
    }
    if (!best || bestAbs > 240) return raw;
    return Math.round(best.time + (raw - best.time) / 1.5);
  }

  private record(cmd: Command, res: CommandResult): void {
    if ((res.ok && !res.idempotent && res.reason !== "nothing-held") || res.reason === "empty-hit") this.commands.push(cmd);
  }

  tap(lane: number, rawTick: number): void {
    if (this.finished) return;
    const tick = this.assistTick(lane, rawTick);
    const cmd: Command = { id: Rules.makeCommandId(tick, lane, "tap"), tick, type: "tap", lane };
    const res = Rules.applyCommand(this.state, cmd);
    this.record(cmd, res);
    if (res.reason === "hit") {
      this.onEvent({ type: "hit", lane, grade: res.grade!, kind: res.kind!, noteId: res.noteId!, delta: res.delta!, combo: this.state.combo, tick });
      if (res.kind === "hold") this.holding.add(res.noteId!);
    } else if (res.reason === "empty-hit") this.onEvent({ type: "empty-hit", lane, tick });
    this.afterCommand(tick);
  }

  release(lane: number, tick: number): void {
    if (this.finished) return;
    const cmd: Command = { id: Rules.makeCommandId(tick, lane, "release"), tick, type: "release", lane };
    const res = Rules.applyCommand(this.state, cmd);
    if (res.reason === "hold-complete" || res.reason === "early-release") {
      this.record(cmd, res);
      this.holding.delete(res.noteId!);
      this.onEvent({ type: res.reason, lane, noteId: res.noteId!, tick });
    }
    this.afterCommand(tick);
  }

  abort(tick: number): void {
    if (this.finished) return;
    Rules.applyCommand(this.state, { id: Rules.makeCommandId(tick, -1, "abort"), tick, type: "abort", lane: -1 });
    this.finalize();
  }

  /** A command advances the rules to its tick too: report what that did (misses), then the end. */
  private afterCommand(tick: number): void {
    this.reportAuto(tick, null);
    if (this.state.status === "terminal") this.finalize();
  }

  private reportAuto(tick: number, prevHold: number | null): void {
    for (const n of this.state.notes) {
      if (n.state === "missed" && !this.reported.has(n.id)) {
        this.reported.add(n.id);
        this.onEvent({ type: "miss", lane: n.lane, noteId: n.id, tick });
      }
    }
    if (prevHold !== null && this.state.score.holdBonus > prevHold) {
      this.holdTicks++;
      if (this.holdTicks % 4 === 0) this.onEvent({ type: "hold-tick", tick });
    }
    for (const id of [...this.holding]) {
      const n = this.state.notes.find((x) => x.id === id);
      if (n && n.state === "hit") {
        this.holding.delete(id);
        this.onEvent({ type: "hold-complete", lane: n.lane, noteId: n.id, tick });
      }
    }
  }

  /** One fixed step: the song has reached `tick`. */
  update(tick: number): void {
    if (this.finished) return;
    const prevHold = this.state.score.holdBonus;
    Rules.advance(this.state, tick);
    this.reportAuto(tick, prevHold);
    if (this.state.status === "terminal") this.finalize();
  }

  private finalize(): void {
    if (this.finished) return;
    this.finished = true;
    const breakdown = Rules.scoreBreakdown(this.state);
    breakdown.sessionId = this.sessionId;
    this.onEvent({ type: "terminal", breakdown });
  }
}

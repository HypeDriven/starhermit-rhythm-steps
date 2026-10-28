// The browser build's pure game modules, imported unchanged (allowJs) and
// typed here with the shapes this client reads: the deterministic rules
// (js/rules.js: notes, taps and releases judged against the song tick,
// misses, holds, scoring, the terminal reasons, replay), the versioned
// content (js/content.js: 40 Journey stages, the Daily from a UTC date,
// Practice difficulties, five Challenges, Score Chase seeds, three lessons,
// the five themes), the save model (js/persistence.js: achievements, stars,
// mastery XP; js/progress.js: what this client stores and merges), and the
// rendered music (js/music.js).
import * as RulesJs from "../js/rules.js";
import * as ContentJs from "../js/content.js";
import * as PersistJs from "../js/persistence.js";
import * as ProgressJs from "../js/progress.js";
import * as MusicJs from "../js/music.js";

export type Grade = "perfect" | "great" | "good";
export interface Note {
  id: number; time: number; lane: number; kind: "tap" | "hold"; duration: number;
  state: "pending" | "hit" | "holding" | "missed" | "released"; grade: Grade | "miss" | null;
  hitDelta: number | null; holdScoredMs: number; released: boolean;
}
export interface Counts { perfect: number; great: number; good: number; miss: number; emptyHits: number; earlyReleases: number }
export interface Score { base: number; comboBonus: number; holdBonus: number; total: number }
export interface RulesState {
  tick: number; status: "active" | "terminal"; terminalReason: string | null; failEnabled: boolean; health: number;
  notes: Note[]; combo: number; maxCombo: number; score: Score; counts: Counts; invalidActions: number; finishedAtTick: number | null;
  durationMs: number;
}
export interface Breakdown extends Score {
  maxCombo: number; counts: Counts; accuracy: number; grade: string; terminalReason: string; elapsedMs: number; invalidActions: number;
  sessionId?: string;
}
export interface Chart {
  id: string; version: number; seed: number; bpm: number; beats: number; notes: { id: number; time: number; lane: number; kind: string; duration: number }[];
  durationMs: number; goals: { complete: boolean; minAccuracy: number; maxMisses: number | null; scoreTarget: number | null };
  mechanics: string[]; theme: string; par: number; displayName?: string; mastery?: boolean;
  challenge?: { key: string; name: string; description: string; modifiers: Record<string, number | boolean> };
}
export interface Stage { index: number; id: string; name: string; seed: number; mechanics: string[]; mastery: boolean; theme: string; goals?: { minAccuracy?: number } }
export interface Difficulty { key: string; label: string; params: { bpm: number } }
export interface ChallengeDef { key: string; name: string; description: string; modifiers: { failEnabled?: boolean; minAccuracy?: number; scoreTargetRatio?: number; maxMisses?: number } }
export interface Lesson { id: string; title: string; steps: { text: string; demo?: boolean; require?: { action: string; count: number } }[] }
export interface Theme {
  name: string; sky: number; fog: number; fogDensity: number; lane: number; laneEdge: number; receptor: number;
  note: number; hold: number; accent: number; env: number; ambient: string; keyLight: number;
}
export interface Achievement { key: string; name: string; description: string }
export interface ChaseEntry { name: string; score: number; total: number; grade: string; sessionId: string; terminalReason: string; invalidActions: number; elapsedMs: number }
/** The engine save: the browser build's save document without its settings. */
export interface Progress {
  version: number;
  profile: { displayName: string; avatarHue: number; guest: boolean; accountLinked: boolean };
  journey: { unlocked: number; stars: Record<string, number>; bestScores: Record<string, number> };
  daily: { lastPlayed: string | null; history: Record<string, { score: number; grade: string }> };
  achievements: Record<string, number>;
  lessons: Record<string, boolean>;
  mastery: { xp: number; level: number };
  chaseBoards: Record<string, ChaseEntry[]>;
  stats: { sessionsPlayed: number; totalScore: number; bestCombo: number; firstPlayDone: boolean; holdsCompleted?: number; earlyReleases?: number; daysPlayed?: Record<string, boolean> };
}
export interface Options {
  leftHanded: boolean; holdMode: "hold" | "toggle"; timingAssist: "off" | "wide"; cvdPalette: boolean;
  captions: boolean; haptics: boolean; cameraSway: boolean; noteSpeed: number;
}
export type Command = { id: string; tick: number; type: "tap" | "release" | "abort"; lane: number };
export interface CommandResult { ok: boolean; reason: string; grade?: Grade; noteId?: number; kind?: string; delta?: number; idempotent?: boolean }
export interface Legal { noteId: number; action: string; kind: string; time: number; delta: number }

interface RulesApi {
  createGame(chart: Chart, options?: { failEnabled?: boolean }): RulesState;
  applyCommand(state: RulesState, cmd: Command): CommandResult;
  advance(state: RulesState, tick: number): RulesState;
  scoreBreakdown(state: RulesState): Breakdown;
  hashState(state: RulesState): string;
  legalActions(state: RulesState): (Legal | null)[];
  makeCommandId(tick: number, lane: number, type: string): string;
  compareResults(a: object, b: object): number;
  chaseEntry(e: object): object;
  RULES_VERSION: number;
  WINDOWS: { perfect: number; great: number; good: number };
}
interface ContentApi {
  journeyChart(i: number): Chart;
  JOURNEY_STAGES: Stage[];
  dailyChart(date: string): Chart;
  dailyInfo(date: string): { seed: number; difficultyBand: number; theme: string };
  practiceChart(key: string, seed: number | null, theme: string): Chart;
  PRACTICE_DIFFICULTIES: Difficulty[];
  challengeChart(key: string): Chart;
  CHALLENGES: ChallengeDef[];
  scoreChaseChart(seed: number, difficulty: string): Chart;
  lessonChart(id: string): Chart;
  LESSONS: Lesson[];
  THEMES: Record<string, Theme>;
  CVD_PALETTE: { note: number; hold: number; accent: number; receptor: number; laneEdge: number };
  getTheme(key: string): Theme;
}
interface PersistApi {
  ACHIEVEMENTS: Achievement[];
  unlockAchievement(save: Progress, key: string): boolean;
  awardMasteryXp(save: Progress, xp: number): boolean;
  starsForResult(b: Breakdown): number;
  markPlayedToday(save: Progress, date: string): number;
}
interface ProgressApi {
  OPTION_DEFAULTS: Options;
  OPTION_KEYS: (keyof Options)[];
  blank(): Progress;
  normalize(raw: unknown): Progress;
  merge(a: unknown, b: unknown): Progress;
  same(a: unknown, b: unknown): boolean;
  pickOptions(raw: unknown): Partial<Options>;
  readForeign(text: string | null | undefined): { progress: Progress; options: Partial<Options> } | null;
  isLegacyKey(key: string): boolean;
}
export interface StemRenderer {
  compose: { loopMs: number; beatMs: number; stepMs: number };
  length: number; rate: number;
  stems: Record<string, Float32Array>;
  step(budget?: number): boolean;
  readonly done: boolean;
}
interface MusicApi {
  STEMS: string[];
  stemRenderer(chart: Chart, rate?: number): StemRenderer;
  layerGains(intensity: number): Record<string, number>;
  ambience(kind: string, rate?: number, seed?: number): Float32Array;
}

export const Rules = RulesJs as unknown as RulesApi;
export const Content = ContentJs as unknown as ContentApi;
export const Persist = PersistJs as unknown as PersistApi;
export const ProgressModel = ProgressJs as unknown as ProgressApi;
export const Music = MusicJs as unknown as MusicApi;

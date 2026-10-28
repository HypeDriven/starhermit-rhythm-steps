// Rhythm Steps on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), the content
// (js/content.js) and the save model (js/persistence.js) are the browser
// build's, unchanged; this module is what js/main.js did around them — the
// game flow (title → mode screens → setup → 3-2-1-GO countdown → the track
// ⇄ pause → results → progression), input (the four lane actions from keys
// and pads, presses on the lane buttons and on the causeway's lanes, the
// hold style, pause), sounds and effects per rules event, Learn's lesson
// steps, achievements, mastery XP, stars, the Daily history, the Score Chase
// seed boards, posting a finished run to the high-score board, and the
// lifecycle (a hidden window pauses the run, as visibilitychange did).
// Screens are drawn by screens.ts (starhermit:ui), the causeway by render.ts
// (starhermit:scene), sound by audio.ts.
//
// Time is the runtime's fixed steps at 60 Hz: the song position is the step
// count (one step = 1000/60 ms, rounded to the rules' whole milliseconds),
// so presses are judged against the same tick on every machine, pauses and
// slow frames never move it, and play scripts replay exactly. A press is
// judged at the song position of the last step (input arrives at the start
// of a frame, before its steps). The countdown counts the same steps (36 a
// number, the old 600 ms), and the music follows the step clock (audio.ts).
// The causeway is drawn between steps by the frame's interpolation.
import "./i18n.ts";
import { clipboard, frame, onFixedUpdate, onFocus, onRender, onResume, onStart, onSuspend, onUpdate, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, Persist, Rules, type Breakdown, type Chart, type Lesson } from "./game.ts";
import { N, S, T, type Vars } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, laneRects, pauseRect } from "./screens.ts";
import { Session, type SessionEvent } from "./session.ts";
import { applyContrast, initStyles } from "./style.ts";

export const STEP_HZ = 60;
export const COUNTDOWN_STEPS = 36;
export const tickOf = (step: number): number => Math.round((step * 1000) / STEP_HZ);

export type Screen = "title" | "setup" | "journey" | "practice" | "challenge" | "learn" | "chase" | "results" | "settings" | "help" | "profile";
export type Mode = "journey" | "daily" | "practice" | "challenge" | "chase" | "learn";
export type Phase = "title" | "countdown" | "active" | "paused" | "results";
type Text = string | (() => string);
export const txt = (v: Text): string => (typeof v === "function" ? v() : v);

export interface SetupInfo { title: () => string; description: () => string; rules: () => string[]; durationMs: number; ranked: boolean; assists: () => string }
export interface ResultsInfo {
  breakdown: Breakdown; headline: () => string; canNext: boolean; achievements: string[]; xpText: () => string; detail: () => string;
}
interface Pending { chart: Chart; mode: Mode; context: Context; opts: RunOpts }
export interface Context { stageIndex?: number; date?: string; difficultyKey?: string; challengeKey?: string; seed?: number; lessonId?: string }
interface RunOpts { failEnabled?: boolean; lesson?: Lesson }

export const app = {
  /** The screen shown (null: the playfield with its HUD). */
  screen: "title" as Screen | null,
  /** Settings or Help opened over the pause dialog. */
  overlay: null as "settings" | "help" | null,
  phase: "title" as Phase,
  navStack: [] as Screen[],
  /** Frame the screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  setup: null as SetupInfo | null,
  pending: null as Pending | null,
  chart: null as Chart | null,
  mode: null as Mode | null,
  context: {} as Context,
  opts: {} as RunOpts,
  session: null as Session | null,
  /** Fixed steps since the song started (the song position). */
  step: 0,
  countdownStep: 0,
  countdownText: null as string | null,
  lesson: null as { lesson: Lesson; stepIndex: number; count: number } | null,
  lessonText: null as null | { text: () => string; progress: string },
  lessonHideAt: -1,
  results: null as ResultsInfo | null,
  lb: null as platform.Posted | "posting" | null,
  judgment: null as null | { grade: string; extra: string; frame: number },
  caption: null as null | { text: string; frame: number },
  toasts: [] as { text: () => string; until: number }[],
  accountNote: null as (() => string) | null,
  /** Score Chase inputs. */
  chaseSeed: "",
  chaseDifficulty: 2,
  practiceTheme: 0,
  board: null as platform.BoardRow[] | "none" | "loading" | null,
  confirmReset: false,
  held: [false, false, false, false],
};

// ------------------------------------------------------------------ helpers
let announced = "";
/** The screen reader's live region (ui.announce): at most one a frame, the newest wins (flushed in onRender). */
export function announce(text: string): void { if (text) announced = text; }
export function click(kind: "move" | "confirm" | "back" | "error" = "confirm"): void { audio.playUi(kind); }
export function toast(text: () => string, seconds = 2.6): void {
  app.toasts.push({ text, until: frame().time + seconds });
  if (app.toasts.length > 3) app.toasts.shift();
}
export const options = (): typeof platform.options => platform.options;
export function today(): string { return new Date(platform.nowMs()).toISOString().slice(0, 10); }
export function progress(): ReturnType<typeof platform.progress> { return platform.progress(); }
export function playerName(): string {
  return platform.signedIn() ? platform.displayName() || T("Player") : progress().profile.displayName || T("Guest");
}

// ------------------------------------------------------------------ navigation
const FIRST: Partial<Record<Screen, string>> = {
  title: "btn-play", setup: "btn-setup-start", journey: "stage-1", practice: "practice-0", challenge: "challenge-0", learn: "lesson-0",
  chase: "chase-seed", results: "btn-retry", settings: "set-noteSpeed", help: "btn-back", profile: "btn-back",
};
/** A screen (null: the playfield), focusing its first control except on touch devices (a later Enter must not press it). */
export function show(screen: Screen | null, push = true): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.confirmReset = false;
  app.focusNext = screen && !touchFirst() ? FIRST[screen] ?? null : null;
  ui.setFocus(null);
  if (screen && push) {
    app.navStack = app.navStack.filter((n) => n !== screen);
    app.navStack.push(screen);
    if (app.navStack.length > 8) app.navStack.shift();
  }
  if (screen === "chase") refreshBoard();
}
export function touchFirst(): boolean {
  const f = frame();
  const sc = ui.preferences().scale || 1;
  const w = f.width / sc, h = f.height / sc;
  return (w <= 700 && h >= w) || (w > h && h <= 500);
}
/** Back (the Back buttons, Escape on a screen): the overlay over pause first, else the previous screen. */
export function navBack(): void {
  click("back");
  if (app.overlay) { app.overlay = null; app.openedFrame = frame().frame; return; }
  app.navStack.pop();
  const prev = app.navStack[app.navStack.length - 1] ?? "title";
  show(prev, false);
}
export function openOverlay(which: "settings" | "help"): void { click("move"); app.overlay = which; app.openedFrame = frame().frame; }
export function goTitle(): void { app.navStack = ["title"]; show("title", false); }

// ------------------------------------------------------------------ modes and setup
const MECHANIC_NAMES: Record<string, string> = { tap: N("tap"), hold: N("hold"), chord: N("chord"), stream: N("stream") };
function level(key: string): string {
  const d = Content.PRACTICE_DIFFICULTIES.find((x) => x.key === key);
  return d ? T(d.label) : key;
}
/** The player-facing title of a run. */
export function chartTitle(mode: Mode, c: Context): string {
  if (mode === "journey") return T(Content.JOURNEY_STAGES[c.stageIndex!]!.name);
  if (mode === "daily") return T("Daily — {date}", { date: c.date! });
  if (mode === "practice") return T("Practice — {level}", { level: level(c.difficultyKey!) });
  if (mode === "challenge") { const ch = Content.CHALLENGES.find((x) => x.key === c.challengeKey); return T("Challenge — {name}", { name: ch ? T(ch.name) : "" }); }
  if (mode === "chase") return T("Score Chase — {level}", { level: level(c.difficultyKey!) });
  const l = Content.LESSONS.find((x) => x.id === c.lessonId);
  return l ? T(l.title) : "";
}
function setupRules(chart: Chart, extra: (() => string) | null): () => string[] {
  return () => {
    const rules = [
      T("{notes} notes at {bpm} BPM across 4 lanes.", { notes: chart.notes.length, bpm: chart.bpm }),
      T("Tap notes on the line; hold long notes head-to-tail."),
      T("Grades: Perfect ±45ms, Great ±90ms, Good ±135ms."),
      T("Combo raises the score bonus; a miss resets it."),
    ];
    if (chart.goals?.minAccuracy) rules.push(T("Goal: accuracy ≥ {n}%.", { n: Math.round(chart.goals.minAccuracy * 100) }));
    if (chart.goals?.scoreTarget) rules.push(T("Goal: score ≥ {n}.", { n: chart.goals.scoreTarget.toLocaleString("en-US") }));
    if (extra) rules.push(extra());
    return rules;
  };
}
const assistSummary = (): string => (options().timingAssist === "wide" ? T("Wide timing windows (kept off competitive boards)") : T("None"));
function showSetup(p: Pending, setup: Omit<SetupInfo, "rules" | "durationMs" | "ranked" | "assists">, extra: (() => string) | null): void {
  app.pending = p;
  app.setup = { ...setup, rules: setupRules(p.chart, extra), durationMs: p.chart.durationMs, ranked: false, assists: assistSummary };
  show("setup");
}

export function quickPlay(): void {
  click();
  const next = Math.min(progress().journey.unlocked - 1, Content.JOURNEY_STAGES.length - 1);
  startJourneyStage(Math.max(0, next));
}
export function openMode(mode: Mode): void {
  click();
  if (mode === "daily") startDaily();
  else show(mode as Screen);
}
export function startJourneyStage(index: number): void {
  const chart = Content.journeyChart(index);
  const s = Content.JOURNEY_STAGES[index]!;
  showSetup({ chart, mode: "journey", context: { stageIndex: index }, opts: {} }, {
    title: () => T("Stage {n}: {name}", { n: index + 1, name: T(s.name) }),
    description: () => (s.mastery ? T("Mastery stage.") + " " : "") + T("Mechanics: {list}.", { list: s.mechanics.map((m) => T(MECHANIC_NAMES[m] ?? m)).join(", ") }),
  }, s.goals?.minAccuracy ? () => T("Hold accuracy ≥ {n}%.", { n: Math.round(s.goals!.minAccuracy! * 100) }) : null);
}
export function startDaily(): void {
  const date = today();
  const chart = Content.dailyChart(date);
  showSetup({ chart, mode: "daily", context: { date }, opts: {} }, {
    title: () => chartTitle("daily", { date }),
    description: () => T("One shared seed and ruleset for everyone, per UTC day. Your best score is recorded and cloud-synced."),
  }, () => T("The platform board is read-only; your personal best is kept in your save."));
}
export function startPractice(difficultyKey: string): void {
  const themeKey = Object.keys(Content.THEMES)[app.practiceTheme] ?? "neon-causeway";
  const chart = Content.practiceChart(difficultyKey, null, themeKey);
  showSetup({ chart, mode: "practice", context: { difficultyKey }, opts: {} }, {
    title: () => chartTitle("practice", { difficultyKey }),
    description: () => T("Unranked practice. No effect on ratings; restart freely."),
  }, null);
}
export function startChallenge(key: string): void {
  const chart = Content.challengeChart(key);
  const c = Content.CHALLENGES.find((x) => x.key === key)!;
  showSetup({ chart, mode: "challenge", context: { challengeKey: key }, opts: { failEnabled: !!c.modifiers.failEnabled } }, {
    title: () => chartTitle("challenge", { challengeKey: key }),
    description: () => T(c.description),
  }, c.modifiers.failEnabled ? () => T("Health is on: misses and stray taps drain it. Zero health ends the run.") : null);
}
export function startChase(): void {
  const seed = parseInt(app.chaseSeed, 10);
  if (!Number.isFinite(seed)) { toast(() => T("Enter a numeric seed")); click("error"); return; }
  const difficultyKey = Content.PRACTICE_DIFFICULTIES[app.chaseDifficulty]!.key;
  const s = seed >>> 0;
  click();
  const chart = Content.scoreChaseChart(s, difficultyKey);
  showSetup({ chart, mode: "chase", context: { seed: s, difficultyKey }, opts: {} }, {
    title: () => chartTitle("chase", { difficultyKey }),
    description: () => T("Seed {seed}. Anyone with this seed plays the identical chart.", { seed: s }),
  }, () => T("Scores for this seed stay on your local and cloud-saved board."));
}
export function randomSeed(): void { click("move"); app.chaseSeed = String(Math.floor(Math.random() * 1e9)); }
export function startLesson(lessonId: string): void {
  click();
  const chart = Content.lessonChart(lessonId);
  const lesson = Content.LESSONS.find((l) => l.id === lessonId)!;
  beginSession(chart, "learn", { lessonId }, { lesson });
}
export function confirmSetup(): void {
  const p = app.pending;
  if (!p) return;
  click();
  app.pending = null;
  beginSession(p.chart, p.mode, p.context, p.opts);
}

// ------------------------------------------------------------------ the run
function objectiveFor(chart: Chart, mode: Mode): () => string {
  if (mode === "journey") {
    const g = chart.goals;
    return g?.minAccuracy ? () => T("Clear with ≥ {n}% accuracy", { n: Math.round(g.minAccuracy * 100) }) : () => T("Finish the track");
  }
  if (mode === "daily") return () => T("Daily ranked run — one shot counts");
  if (mode === "challenge") return chart.challenge?.description ? () => T(chart.challenge!.description) : () => T("Complete the challenge");
  if (mode === "learn") return () => T("Follow the lesson");
  if (mode === "chase") return () => T("Set the score for this seed");
  return () => T("Practice run");
}
export let objective: () => string = () => "";

function beginSession(chart: Chart, mode: Mode, context: Context, opts: RunOpts): void {
  teardown();
  app.chart = chart; app.mode = mode; app.context = context; app.opts = opts;
  const theme = Content.getTheme(chart.theme);
  render.setSeed(chart.seed);
  render.setTheme(theme, options().cvdPalette);
  objective = objectiveFor(chart, mode);
  announce(T("{title}. Get ready.", { title: chartTitle(mode, context) }));
  if (mode === "learn" && opts.lesson) {
    app.lesson = { lesson: opts.lesson, stepIndex: 0, count: 0 };
    const text = opts.lesson.steps[0]!.text;
    app.lessonText = { text: () => T(text), progress: lessonProgressText() };
    announce(T(text));
  }
  app.session = new Session(chart, mode, { failEnabled: !!opts.failEnabled, timingAssist: options().timingAssist }, handleEvent);
  app.step = 0;
  app.countdownStep = 0;
  app.countdownText = "3";
  app.phase = "countdown";
  app.results = null;
  app.lb = null;
  app.screen = null;
  app.overlay = null;
  app.navStack = [];
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  audio.prepareMusic(chart);
  audio.setAmbience(theme.ambient);
  audio.playCountdown(3);
}
function teardown(): void {
  app.session = null;
  app.lesson = null;
  app.lessonText = null;
  app.lessonHideAt = -1;
  app.countdownText = null;
  app.judgment = null;
  audio.stopMusic();
  audio.setAmbience(null);
  releaseAllLanes(false);
}
export function restartTrack(): void {
  if (!app.chart || !app.mode) return;
  click();
  beginSession(app.chart, app.mode, { ...app.context }, { ...app.opts });
}
export function leaveGame(): void {
  click("back");
  const s = app.session;
  if (s && !s.finished && (app.phase === "active" || app.phase === "paused")) {
    leaving = true;
    s.abort(tickOf(app.step));
    leaving = false;
  }
  teardown();
  app.phase = "title";
  goTitle();
}
let leaving = false;
export function nextStage(): void {
  const next = (app.context.stageIndex ?? -1) + 1;
  if (next < Content.JOURNEY_STAGES.length) { click(); startJourneyStage(next); } else goTitle();
}

export function pauseGame(): void {
  if (!app.session || app.phase !== "active") return;
  app.phase = "paused";
  app.overlay = null;
  releaseAllLanes(false);
  audio.stopMusic();
  app.openedFrame = frame().frame;
  if (!touchFirst()) app.focusNext = "btn-resume";
  announce(T("Paused"));
}
export function resumeGame(): void {
  if (!app.session || app.phase !== "paused") return;
  app.phase = "active";
  app.overlay = null;
  ui.setFocus(null);
  audio.startMusic(tickOf(app.step));
  announce(T("Resumed"));
}

// ------------------------------------------------------------------ session events
function handleEvent(e: SessionEvent): void {
  if (e.type === "terminal") { if (!leaving) onTerminal(e.breakdown); return; }
  render.event(e);
  switch (e.type) {
    case "hit":
      audio.playHit(e.grade, e.combo);
      judgment(e.grade);
      haptic(12);
      lessonProgress("hit");
      break;
    case "hold-complete":
      judgment("perfect", N("hold"));
      lessonProgress("hold-complete");
      progress().stats.holdsCompleted = (progress().stats.holdsCompleted ?? 0) + 1;
      break;
    case "early-release":
      audio.playMiss();
      judgment("miss", N("early"));
      progress().stats.earlyReleases = (progress().stats.earlyReleases ?? 0) + 1;
      break;
    case "miss":
      audio.playMiss();
      judgment("miss");
      haptic(100);
      announce(T("Miss"));
      break;
    case "empty-hit": audio.playEmptyHit(); break;
    case "hold-tick": audio.playHoldTick(); break;
  }
}
function judgment(grade: string, extra = ""): void { app.judgment = { grade, extra, frame: frame().frame }; }
function haptic(ms: number): void { if (options().haptics) { try { vibrate(ms); } catch { /* none */ } } }

function lessonProgressText(): string {
  const l = app.lesson;
  if (!l) return "";
  const step = l.lesson.steps[l.stepIndex];
  return step?.require ? `${l.count}/${step.require.count}` : "";
}
function lessonProgress(action: string): void {
  const l = app.lesson;
  if (!l) return;
  const step = l.lesson.steps[l.stepIndex]!;
  if (!step.require || step.require.action !== action) {
    if (step.require?.action === "combo" && action === "hit" && app.session) l.count = Math.max(l.count, app.session.state.combo);
    else return;
  } else l.count++;
  if (step.require && l.count >= step.require.count) {
    l.stepIndex++;
    l.count = 0;
    if (l.stepIndex >= l.lesson.steps.length) {
      app.lessonText = { text: () => T("Lesson complete! Finish the track."), progress: "" };
      announce(T("Lesson complete! Finish the track."));
      progress().lessons[l.lesson.id] = true;
      platform.saveNow();
      app.lessonHideAt = app.step + Math.round(2.2 * STEP_HZ);
      app.lesson = null;
      return;
    }
    audio.playUi("confirm");
  }
  const next = l.lesson.steps[Math.min(l.stepIndex, l.lesson.steps.length - 1)]!;
  app.lessonText = { text: () => T(next.text), progress: lessonProgressText() };
  announce(T(next.text));
}

// ------------------------------------------------------------------ results and progression
const ACH_NAME = (key: string): string => Persist.ACHIEVEMENTS.find((a) => a.key === key)?.name ?? key;
function onTerminal(b: Breakdown): void {
  app.phase = "results";
  audio.stopMusic();
  audio.setAmbience(null);
  audio.playResultFanfare(b.grade);
  releaseAllLanes(false);
  const p = progress();
  const mode = app.mode!, ctx = { ...app.context }, chart = app.chart!;
  const completed = b.terminalReason === "complete";
  const unlocked: string[] = [];
  const tryUnlock = (key: string): void => { if (Persist.unlockAchievement(p, key)) unlocked.push(key); };
  if (completed) {
    tryUnlock("first-light");
    if (b.maxCombo >= 50) tryUnlock("streak-50");
    if ((p.stats.holdsCompleted ?? 0) >= 25 && !((p.stats.earlyReleases ?? 0) > 0)) tryUnlock("hold-mastery");
  }
  const days = Persist.markPlayedToday(p, today());
  if (days >= 7) tryUnlock("long-road");
  const xp = Math.round(b.total / 50) + (completed ? 25 : 0);
  const leveled = Persist.awardMasteryXp(p, xp);
  const newLevel = p.mastery.level;
  const xpText = (): string => (leveled ? T("+{xp} mastery XP — level {level}!", { xp, level: newLevel }) : T("+{xp} mastery XP", { xp }));
  p.stats.sessionsPlayed++;
  p.stats.totalScore += b.total;
  p.stats.bestCombo = Math.max(p.stats.bestCombo, b.maxCombo);

  let headline: () => string = () => "";
  let canNext = false;
  let detail: () => string = () => "";
  if (mode === "journey") {
    const idx = ctx.stageIndex!;
    const minAcc = chart.goals?.minAccuracy || 0;
    const passed = completed && b.accuracy >= minAcc;
    if (passed) {
      const stars = Persist.starsForResult(b);
      p.journey.stars[idx] = Math.max(p.journey.stars[idx] ?? 0, stars);
      p.journey.bestScores[idx] = Math.max(p.journey.bestScores[idx] ?? 0, b.total);
      if (idx + 1 >= p.journey.unlocked) p.journey.unlocked = Math.min(Content.JOURNEY_STAGES.length, idx + 2);
      headline = () => T("{title} cleared — {stars}", { title: chartTitle("journey", ctx), stars: "★".repeat(stars) + "☆".repeat(3 - stars) });
      canNext = idx + 1 < Content.JOURNEY_STAGES.length;
      if (idx === Content.JOURNEY_STAGES.length - 1) tryUnlock("summit-clear");
    } else {
      const acc = (b.accuracy * 100).toFixed(1);
      headline = completed && b.accuracy < minAcc
        ? () => T("Accuracy {n}% — goal is {goal}%", { n: acc, goal: Math.round(minAcc * 100) })
        : () => T("Track failed — try again");
    }
  } else if (mode === "daily") {
    const prev = p.daily.history[ctx.date!];
    if (completed && (!prev || b.total > prev.score)) p.daily.history[ctx.date!] = { score: b.total, grade: b.grade };
    headline = completed ? () => T("Daily run complete") : () => T("Daily run ended");
    detail = () => T("Personal best recorded in your save.");
  } else if (mode === "chase") {
    const key = String(ctx.seed);
    const board = p.chaseBoards[key] ?? (p.chaseBoards[key] = []);
    board.push({ name: playerName(), score: b.total, total: b.total, grade: b.grade, sessionId: b.sessionId ?? "", terminalReason: b.terminalReason, invalidActions: b.invalidActions, elapsedMs: b.elapsedMs });
    board.sort((x, y) => Rules.compareResults(Rules.chaseEntry(x), Rules.chaseEntry(y)));
    p.chaseBoards[key] = board.slice(0, 20);
    headline = completed ? () => T("Score posted to your seed board") : () => T("Run ended");
  } else if (mode === "challenge") {
    const met = completed && b.accuracy >= (chart.goals?.minAccuracy || 0) && b.total >= (chart.goals?.scoreTarget || 0);
    headline = met ? () => T("Challenge complete!") : completed ? () => T("Finished — goal not met") : () => T("Challenge failed");
  } else if (mode === "learn") {
    headline = completed ? () => T("Lesson track complete") : () => T("Lesson ended");
  } else {
    headline = completed ? () => T("Practice complete") : () => T("Practice ended");
  }
  if (mode === "learn" && ctx.lessonId && completed) p.lessons[ctx.lessonId] = true;
  platform.saveNow();
  app.results = { breakdown: b, headline, canNext, achievements: unlocked.map(ACH_NAME), xpText, detail };
  app.session = null;
  app.lesson = null;
  app.lessonText = null;
  app.navStack = ["title"];
  show("results");
  announce(T("Results. Grade {grade}. Total {n} points. {headline}", { grade: b.grade, n: b.total, headline: headline() }));
  // signed in: every completed run except lessons posts its total to the high-score board
  if (completed && mode !== "learn" && platform.signedIn()) {
    app.lb = "posting";
    const mine = app.results;
    void platform.postScore(b.total).then((r) => { if (app.results === mine) app.lb = r; });
  }
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
function refreshBoard(): void {
  app.board = null;
  app.board = "loading";
  void platform.boardTop(10).then((rows) => { app.board = rows && rows.length ? rows : "none"; });
}

// ------------------------------------------------------------------ account and data
export function copyInvite(): void {
  click();
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(() => S("inviteCopied")); }
  catch { toast(() => S("inviteLink", { url: link }), 8); }
}
export function signIn(): void { click(); void requestSignIn().catch(() => undefined); }
export function setGuestName(name: string): void {
  const p = progress();
  const next = name.slice(0, 24);
  if (p.profile.displayName === next) return;
  p.profile.displayName = next;
  platform.saveNow();
}
export function resetProgress(): void {
  const p = progress();
  Object.assign(p, platform.blankProgress());
  platform.saveNow();
  toast(() => T("Progress reset"));
  goTitle();
}

// ------------------------------------------------------------------ input
/** A lane pressed (keys, pads, the lane buttons, the causeway). */
export function laneDown(lane: number): void {
  if (app.held[lane]) return;
  if (app.phase !== "active" || !app.session) { render.pressLane(lane, true); render.pressLane(lane, false); return; }
  const tick = tickOf(app.step);
  if (options().holdMode === "toggle" && toggled[lane]) {
    toggled[lane] = false;
    render.pressLane(lane, false);
    app.session.release(lane, tick);
    return;
  }
  app.held[lane] = true;
  render.pressLane(lane, true);
  if (options().holdMode === "toggle") toggled[lane] = true;
  app.session.tap(lane, tick);
}
/** A lane let go. */
export function laneUp(lane: number): void {
  if (!app.held[lane]) return;
  app.held[lane] = false;
  if (options().holdMode === "toggle" && toggled[lane]) return; // toggle releases on the second press
  render.pressLane(lane, false);
  if (app.phase === "active" && app.session) app.session.release(lane, tickOf(app.step));
}
const toggled = [false, false, false, false];
function releaseAllLanes(judge: boolean): void {
  for (let l = 0; l < 4; l++) {
    if (judge) laneUp(l);
    app.held[l] = false;
    toggled[l] = false;
  }
  laneSources.clear();
  render.releaseAll();
}
const LANE_ACTIONS = ["lane1", "lane2", "lane3", "lane4"];
/** Each lane's holders (an action, a finger, the mouse): the lane is up when none holds it. */
const laneSources = new Map<string, number>();
function sourceDown(source: string, lane: number): void {
  if (laneSources.has(source)) return;
  laneSources.set(source, lane);
  laneDown(lane);
}
function sourceUp(source: string): void {
  const lane = laneSources.get(source);
  if (lane === undefined) return;
  laneSources.delete(source);
  if (![...laneSources.values()].includes(lane)) laneUp(lane);
}
onAction((e) => {
  const lane = LANE_ACTIONS.indexOf(e.action);
  if (lane >= 0) {
    if (!e.pressed) { sourceUp(`action:${e.action}:${e.slot}`); return; }
    if (app.phase !== "active" || app.screen !== null) return;
    ui.setFocus(null); // game keys must not also walk or activate the UI focus over the HUD
    sourceDown(`action:${e.action}:${e.slot}`, lane);
    return;
  }
  if (e.action === "pause" && e.pressed) {
    if (ui.capturingKeys() || frame().frame === app.openedFrame) return;
    if (app.overlay) { navBack(); return; }
    if (app.phase === "active") { pauseGame(); return; }
    if (app.phase === "paused") { click("back"); resumeGame(); return; }
    if (app.phase === "countdown") { leaveGame(); return; }
    if (app.screen && app.screen !== "title") { if (app.confirmReset) app.confirmReset = false; else navBack(); }
  }
});
/** The lane a window point presses: a lane button (last frame's rectangles), else a lane of the causeway; null elsewhere. */
function laneAtPoint(x: number, y: number): number | null {
  if (app.phase !== "active" || app.screen !== null) return null;
  const pr = pauseRect();
  if (pr && x >= pr.x && y >= pr.y && x <= pr.x + pr.width && y <= pr.y + pr.height) return null;
  const rects = laneRects();
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r && x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height) return i;
  }
  return render.laneAt(x, y);
}
let lastTouch = -1e9;
/** Frame of the last pointer press on a lane (its release activates the lane button widget too). */
export const pointerPressFrame = [-1e9, -1e9, -1e9, -1e9];
onTouch((e) => {
  lastTouch = frame().time;
  if (e.control) return;
  const src = `touch:${e.id}`;
  if (e.phase === "start") {
    const lane = laneAtPoint(e.x, e.y);
    if (lane === null) return;
    pointerPressFrame[lane] = frame().frame;
    ui.setFocus(null);
    sourceDown(src, lane);
  } else if (e.phase === "end" || e.phase === "cancel") sourceUp(src);
});
onPointerButton((e) => {
  if (e.button !== 0 || frame().time - lastTouch < 0.6) return;
  if (e.pressed) {
    const lane = laneAtPoint(e.x, e.y);
    if (lane === null) return;
    pointerPressFrame[lane] = frame().frame;
    sourceDown("mouse", lane);
  } else sourceUp("mouse");
});
/** A lane button activated by keys or assistive technology (not a pointer press): a quick tap. */
export function laneButtonActivated(lane: number): void {
  if (frame().frame - pointerPressFrame[lane]! < 90) return;
  laneDown(lane);
  laneUp(lane);
}
onFocus((focused) => { if (!focused) { for (const s of [...laneSources.keys()]) sourceUp(s); } });

// ------------------------------------------------------------------ captions
audio.setCaptionHandler((key: string, vars?: Vars) => {
  if (!options().captions) return;
  app.caption = { text: T(key, vars ?? null), frame: frame().frame };
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void {
  render.setOptions({ reducedMotion: ui.preferences().reducedMotion, cameraSway: options().cameraSway, noteSpeed: options().noteSpeed, mirror: options().leftHanded });
  if (app.chart) render.setTheme(Content.getTheme(app.chart.theme), options().cvdPalette);
}

onStart(() => {
  setFixedRate(STEP_HZ);
  initStyles();
  platform.initPlatform();
  applyLook();
  render.setSeed(1);
  render.setTheme(Content.getTheme("neon-causeway"), options().cvdPalette);
  applyOptions();
  app.navStack = ["title"];
  show("title", false);
});
platform.onOptionsChange(applyOptions);
platform.onPlayer((on) => { if (!on) app.accountNote = () => S("signedOut"); else app.accountNote = null; });
onSessionEnded(() => { app.accountNote = () => S("signedOut"); }); // keep playing locally
let hidden = false;
onSuspend(() => {
  hidden = true;
  platform.flush();
  pauseGame();
  audio.setSuspended(true);
});
onResume(() => {
  hidden = false;
  audio.setSuspended(false);
});

onFixedUpdate(() => {
  if (hidden) return;
  if (app.phase === "countdown") {
    app.countdownStep++;
    if (app.countdownStep % COUNTDOWN_STEPS === 0) {
      const n = 3 - app.countdownStep / COUNTDOWN_STEPS;
      if (n > 0) { app.countdownText = String(n); audio.playCountdown(n); }
      else if (n === 0) { app.countdownText = T("GO"); audio.playCountdown(0); }
      else {
        app.countdownText = null;
        app.phase = "active";
        app.step = 0;
        audio.startMusic(0);
      }
    }
  } else if (app.phase === "active" && app.session) {
    app.step++;
    app.session.update(tickOf(app.step));
    if (app.lessonHideAt >= 0 && app.step >= app.lessonHideAt) { app.lessonText = null; app.lessonHideAt = -1; }
  }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyContrast(ui.preferences().highContrast);
  const rm = ui.preferences().reducedMotion;
  if (rm !== lastReduced) { lastReduced = rm; applyOptions(); }
  if (app.session && app.phase === "active") audio.setIntensity(Math.min(1, app.session.state.combo / 60));
  audio.update();
});
let lastReduced = false;
onRender((alpha) => {
  const f = frame();
  app.toasts = app.toasts.filter((t) => t.until > f.time);
  const s = app.session;
  const a = app.phase === "active" ? Math.min(1, Math.max(0, alpha)) : 0;
  const songMs = tickOf(app.step) + (app.phase === "active" ? a * (1000 / STEP_HZ) : 0);
  if (app.phase === "active") audio.setSongPosition(songMs);
  const view = s && (app.phase === "active" || app.phase === "paused" || app.phase === "countdown")
    ? { notes: s.state.notes, tick: app.phase === "countdown" ? 0 : songMs, bpm: s.chart.bpm, running: app.phase === "active" }
    : null;
  render.update(view, frameDt, f.width, f.height);
  drawScreens();
  if (announced) {
    try { ui.announce(announced.slice(0, 500)); } catch { /* the reader is busy */ }
    announced = "";
  }
});


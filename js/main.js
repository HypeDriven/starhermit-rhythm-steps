// Bootstrap + controller: wires rules, session, render, ui, audio, platform.
// Owns the frame loop, input routing, game-state transitions, and progression.

import { GameSession } from './session.js';
import { Renderer3D, webglAvailable, detectedPreset } from './render3d.js';
import { initGraphicsPanel, buildGraphicsPanel } from './gfx-ui.js';
import { Renderer2D } from './render2d.js';
import { audio } from './audio.js';
import * as ui from './ui.js';
import * as platform from './platform.js';
import {
  loadSave, writeSave, defaultSave, unlockAchievement, awardMasteryXp,
  starsForResult, markPlayedToday, ACHIEVEMENTS, parseSaveDoc, DEFAULT_SETTINGS,
} from './persistence.js';
import {
  journeyChart, JOURNEY_STAGES, dailyChart, practiceChart, challengeChart,
  scoreChaseChart, lessonChart, LESSONS, getTheme, CVD_PALETTE, CHALLENGES,
} from './content.js';
import { compareResults, chaseEntry } from './rules.js';

// Game-state model: boot → title → profile-ready → mode-select → preparing →
// tutorial/countdown → active ↔ paused → resolving → results → progression.
let save = null;
let renderer = null;
let session = null;
let currentChart = null;
let currentMode = null;      // 'journey' | 'daily' | 'practice' | 'challenge' | 'chase' | 'learn'
let currentContext = {};     // { stageIndex, difficultyKey, challengeKey, seed, lessonId }
let currentOpts = {};        // session modifiers (failEnabled, lesson) — reused on restart
let pendingSetup = null;     // setup screen confirmation payload
let phase = 'boot';
let lessonState = null;
let countdownTimer = null;
let usingFallback = false;
let lastFrame = 0;
let hudThrottle = 0;
const heldLanes = new Set();
const gamepadLaneState = [false, false, false, false];
let gamepadNavCooldown = 0;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Persist locally and mirror to the hosted cloud-save slot (debounced; the
// flush happens on pagehide/visibilitychange inside the platform adapter).
function persistSave() {
  writeSave(save);
  platform.scheduleCloudPush(save);
  platform.mirrorSettings(save.settings, DEFAULT_SETTINGS);
}

// Lane keys are KeyboardEvent.code values; older saves stored e.key letters.
function normalizeKeys(s) {
  const def = DEFAULT_SETTINGS.keys;
  const codes = (Array.isArray(s.keys) ? s.keys : def).map((k, i) => platform.keyToCode(k) || def[i]);
  s.keys = codes.length === 4 && new Set(codes).size === 4 ? codes : def.slice();
}

function boot() {
  platform.detectHost(); // reads + strips the launch fragment first
  save = loadSave();
  normalizeKeys(save.settings);
  applySettingsSideEffects();
  platform.setTelemetryConsent(!!save.settings.telemetryConsent);
  platform.setSyncStatusHandler(ui.setSyncStatus);
  platform.syncTime().then(() => renderTitleStatuses());
  initHosted();
  createRenderer();

  ui.initUI(controller);
  initGraphicsPanel(controller);
  ui.setLaneKeyLabels(save.settings.keys);
  ui.setAccount();
  platform.onAuth((a) => {
    if (!a.signedIn) ui.toast(ui.shText('signedOut'));
    ui.setAccount();
  });
  bindGlobalInput();
  bindLaneButtons();
  bindViewportLifecycle();

  phase = 'title';
  ui.showScreen('title');
  renderer.resize(); // size the playfield canvas to the viewport from boot
  window.addEventListener('beforeunload', () => { writeSave(save); platform.flushCloud(); });
  requestAnimationFrame(frame);
  platform.telemetry('start', { hosted: platform.isHosted() });
}

// Hosted identity: the account nickname from the platform profile replaces
// the local guest name (read-only in the UI); "Player "+id8 fallback lives
// in the platform adapter. Returns true when the save changed.
function applyHostedProfile(name) {
  if (!name) return false;
  const p = save.profile;
  if (p.displayName === name && p.accountLinked && !p.guest) return false;
  p.displayName = name;
  p.accountLinked = true;
  p.guest = false;
  return true;
}

// Hosted start-up, in order: cloud mirror (the remote doc wins when it is at
// least as new as the local cache; a newer local doc is pushed back up), then
// the per-player settings KV (platform wins), then keyboard bindings.
// localStorage remains the offline cache throughout. Standalone this only
// resolves the local bindings (no network).
async function initHosted() {
  if (platform.isHosted()) {
    // The profile is fetched in parallel but applied only after the cloud
    // doc has been compared: writing the nickname first would bump the local
    // updatedAt and make a newer cloud save lose to the stale local one.
    const profile = platform.loadProfile().catch(() => null);
    const r = await platform.cloudLoad();
    const remote = r.ok && r.doc ? parseSaveDoc(r.doc) : null;
    const useRemote = remote && (remote.updatedAt || 0) >= (save.updatedAt || 0);
    if (useRemote) {
      save = remote;
      normalizeKeys(save.settings);
    }
    const renamed = applyHostedProfile(await profile);
    writeSave(save);
    if (!useRemote || renamed) platform.scheduleCloudPush(save); // empty slot, newer local doc, or a new account name
    if (await platform.loadSettings(save.settings, DEFAULT_SETTINGS)) writeSave(save);
  }
  await platform.loadBindings(save.settings.keys);
  const b = platform.getBindings();
  save.settings.keys = platform.LANE_ACTIONS.map((a, i) => (b[a] && b[a][0]) || save.settings.keys[i]);
  if (!platform.isHosted()) return;
  applySettingsSideEffects();
  ui.refreshSettingsPanel();
  buildGraphicsPanel();
  ui.setLaneKeyLabels(save.settings.keys);
  ui.refreshHelpCards();
  renderTitleStatuses();
}

function createRenderer() {
  const host = document.getElementById('canvas-host');
  if (renderer) { renderer.dispose(); renderer = null; host.innerHTML = ''; }
  const theme = currentChart ? getTheme(save.settings.themeOverride || currentChart.theme) : getTheme('neon-causeway');
  const opts = {
    theme,
    cvdPalette: save.settings.cvdPalette,
    cvdColors: CVD_PALETTE,
    reducedMotion: save.settings.reducedMotion,
    cameraSway: save.settings.cameraSway,
    noteSpeed: save.settings.noteSpeed,
    // Left-handed layout reverses the on-screen lane buttons; the rendered
    // lanes mirror with them so column order always matches.
    mirrorLanes: !!save.settings.leftHanded,
    gfx: save.settings.gfx,
    seed: currentChart ? currentChart.seed : 1,
    onLaneInput: handleLanePointer,
    onContextLost: () => {
      ui.toast('Graphics context lost — rebuilding…');
      setTimeout(() => { createRenderer(); }, 250); // GPU resources rebuilt from retained descriptors
    },
  };
  if (webglAvailable()) {
    try { renderer = new Renderer3D(host, opts); usingFallback = false; lastGfxJson = JSON.stringify(save.settings.gfx || {}); }
    catch (e) { console.warn('3D init failed, using 2D', e); renderer = new Renderer2D(host, opts); usingFallback = true; }
  } else {
    renderer = new Renderer2D(host, opts);
    usingFallback = true;
  }
}

let lastGfxJson = null;

// Apply graphics settings live; only a canvas-MSAA change needs a new context.
function applyGraphics() {
  const json = JSON.stringify(save.settings.gfx || {});
  if (!renderer || !renderer.is3D || json === lastGfxJson) return;
  lastGfxJson = json;
  if (renderer.setGraphics(save.settings.gfx)) {
    createRenderer();
    renderer.resize();
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function applySettingsSideEffects() {
  const s = save.settings;
  document.body.classList.toggle('high-contrast', !!s.highContrast);
  document.body.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('left-handed', !!s.leftHanded);
  audio.applySettings(s);
  audio.captionsEnabled = !!s.captions;
  platform.setTelemetryConsent(!!s.telemetryConsent);
  if (renderer && renderer.is3D && !!renderer.mirrorLanes !== !!s.leftHanded) {
    createRenderer(); // lane geometry is built once; mirroring needs a rebuild
    renderer.resize();
  }
  if (renderer) {
    renderer.setMirrorLanes?.(!!s.leftHanded);
    renderer.setReducedMotion?.(!!s.reducedMotion);
    renderer.setNoteSpeed?.(s.noteSpeed || 1);
    applyGraphics();
    if (currentChart) renderer.setTheme(getTheme(save.settings.themeOverride || currentChart.theme), !!s.cvdPalette);
  }
}

// ---------------------------------------------------------------------------
// Controller exposed to the UI layer
// ---------------------------------------------------------------------------
const controller = {
  getSave: () => save,
  utcToday: () => platform.nowUtcDateString(),
  usingFallbackRenderer: () => usingFallback,
  uiSound(kind) { audio.init(); audio.playUi(kind); },

  getGfx: () => save.settings.gfx || {},
  detectedPreset: () => (renderer && renderer.is3D ? renderer.detected : detectedPreset()),
  graphicsInfo: () => (renderer && renderer.is3D ? renderer.graphicsInfo() : null),
  setGfx(next) {
    save.settings.gfx = { ...next };
    applyGraphics();
    persistSave();
    platform.telemetry('settings-change');
  },

  applySetting(key, value) {
    save.settings[key] = value;
    applySettingsSideEffects();
    ui.setLaneKeyLabels(save.settings.keys);
    ui.refreshHelpCards();
    persistSave();
    platform.telemetry('settings-change');
  },

  rebindKey(lane, key) {
    // key is a KeyboardEvent.code. Prevent duplicate bindings (swap).
    const existing = save.settings.keys.indexOf(key);
    if (existing >= 0 && existing !== lane) save.settings.keys[existing] = save.settings.keys[lane];
    save.settings.keys[lane] = key;
    platform.setLocalBindings(save.settings.keys);
    platform.saveLaneBindings(save.settings.keys); // controls API when signed in
    persistSave();
    ui.setLaneKeyLabels(save.settings.keys);
    ui.refreshHelpCards();
  },

  resetKeys() {
    save.settings.keys = DEFAULT_SETTINGS.keys.slice();
    platform.setLocalBindings(save.settings.keys);
    platform.resetControls();
    persistSave();
    ui.setLaneKeyLabels(save.settings.keys);
    ui.refreshHelpCards();
  },
  canSignIn: () => platform.canSignIn(),
  isSignedIn: () => platform.isHosted(),
  signIn: () => platform.signIn(),
  async invite() {
    const url = platform.inviteLink();
    if (!url) return;
    try { await navigator.clipboard.writeText(url); ui.toast(ui.shText('inviteCopied')); }
    catch { ui.toast(ui.shText('inviteLink', { url }), 8000); }
  },
  avatarUrl: () => platform.avatarUrl(),
  pauseKeys: () => platform.getBindings().pause || ['Escape'],

  updateProfile({ displayName }) {
    if (save.profile.accountLinked) { ui.toast('Name comes from your StarHermit account'); return; }
    save.profile.displayName = displayName;
    persistSave();
    ui.toast('Profile updated');
  },

  resetSave() {
    save = defaultSave();
    platform.setLocalBindings(save.settings.keys);
    persistSave();
    applySettingsSideEffects();
    ui.refreshSettingsPanel();
    buildGraphicsPanel();
    ui.setLaneKeyLabels(save.settings.keys);
    ui.toast('Progress reset');
    ui.showScreen('title');
  },

  quickPlay() {
    // Returning player reaches the playfield in at most two deliberate actions.
    const next = Math.min(save.journey.unlocked - 1, JOURNEY_STAGES.length - 1);
    controller.startJourneyStage(Math.max(0, next));
  },

  openMode(mode) {
    audio.init();
    if (mode === 'journey') ui.showScreen('journey');
    else if (mode === 'practice') ui.showScreen('practice');
    else if (mode === 'challenge') ui.showScreen('challenge');
    else if (mode === 'learn') ui.showScreen('learn');
    else if (mode === 'chase') ui.showScreen('chase');
    else if (mode === 'daily') controller.startDaily();
  },

  confirmSetup() {
    if (!pendingSetup) return;
    const { chart, mode, context, opts } = pendingSetup;
    pendingSetup = null;
    beginSession(chart, mode, context, opts);
  },

  startJourneyStage(index) {
    const chart = journeyChart(index);
    const s = JOURNEY_STAGES[index];
    pendingSetup = { chart, mode: 'journey', context: { stageIndex: index }, opts: {} };
    ui.showSetup({
      title: `Stage ${index + 1}: ${s.name}`,
      description: `${s.mastery ? 'Mastery stage. ' : ''}Mechanics: ${s.mechanics.join(', ')}.`,
      rules: setupRules(chart, s.goals?.minAccuracy ? `Hold accuracy ≥ ${Math.round(s.goals.minAccuracy * 100)}%.` : null),
      durationMs: chart.durationMs,
      ranked: false,
      assists: assistSummary(),
    });
  },

  startDaily() {
    const today = platform.nowUtcDateString();
    const chart = dailyChart(today);
    pendingSetup = { chart, mode: 'daily', context: { date: today }, opts: {} };
    ui.showSetup({
      title: `Daily — ${today}`,
      description: 'One shared seed and ruleset for everyone, per UTC day. Your best score is recorded and cloud-synced.',
      rules: setupRules(chart, 'The platform board is read-only; your personal best is kept in your save.'),
      durationMs: chart.durationMs,
      ranked: false,
      assists: assistSummary(true),
    });
  },

  startPractice(difficultyKey, themeKey) {
    const chart = practiceChart(difficultyKey, null, themeKey || 'neon-causeway');
    pendingSetup = { chart, mode: 'practice', context: { difficultyKey }, opts: {} };
    ui.showSetup({
      title: chart.displayName,
      description: 'Unranked practice. No effect on ratings; restart freely.',
      rules: setupRules(chart, null),
      durationMs: chart.durationMs,
      ranked: false,
      assists: assistSummary(),
    });
  },

  startChallenge(key) {
    const chart = challengeChart(key);
    const c = CHALLENGES.find((x) => x.key === key);
    const opts = { failEnabled: !!c.modifiers.failEnabled };
    pendingSetup = { chart, mode: 'challenge', context: { challengeKey: key }, opts };
    ui.showSetup({
      title: `Challenge — ${c.name}`,
      description: c.description,
      rules: setupRules(chart, c.modifiers.failEnabled ? 'Health is on: misses and stray taps drain it. Zero health ends the run.' : null),
      durationMs: chart.durationMs,
      ranked: false,
      assists: assistSummary(),
    });
  },

  startChase(seed, difficultyKey) {
    const chart = scoreChaseChart(seed, difficultyKey);
    pendingSetup = { chart, mode: 'chase', context: { seed, difficultyKey }, opts: {} };
    ui.showSetup({
      title: chart.displayName,
      description: `Seed ${seed}. Anyone with this seed plays the identical chart.`,
      rules: setupRules(chart, 'Scores for this seed stay on your local and cloud-saved board.'),
      durationMs: chart.durationMs,
      ranked: false,
      assists: assistSummary(true),
    });
  },

  startLesson(lessonId) {
    const chart = lessonChart(lessonId);
    const lesson = LESSONS.find((l) => l.id === lessonId);
    beginSession(chart, 'learn', { lessonId }, { lesson });
  },

  pauseGame() { pauseGame(); },
  resumeGame() { resumeGame(); },

  restartTrack() {
    if (!currentChart) return;
    // Restarts must reproduce the run exactly: challenge modifiers (health) and
    // the active lesson are carried over, not silently dropped.
    const chart = currentChart, mode = currentMode, context = { ...currentContext }, opts = { ...currentOpts };
    ui.showPause(false);
    teardownSession();
    beginSession(chart, mode, context, opts);
    platform.telemetry('retry');
  },

  retry() { controller.restartTrack(); },

  leaveGame() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (session && !session.finished && phase === 'active') session.abort();
    teardownSession();
    phase = 'title';
    ui.showScreen('title');
  },

  nextStage() {
    const next = (currentContext.stageIndex ?? -1) + 1;
    if (next < JOURNEY_STAGES.length) controller.startJourneyStage(next);
    else ui.showScreen('title');
  },
};

function setupRules(chart, extra) {
  const rules = [
    `${chart.notes.length} notes at ${chart.bpm} BPM across 4 lanes.`,
    'Tap notes on the line; hold long notes head-to-tail.',
    'Grades: Perfect ±45ms, Great ±90ms, Good ±135ms.',
    'Combo raises the score bonus; a miss resets it.',
  ];
  if (chart.goals?.minAccuracy) rules.push(`Goal: accuracy ≥ ${Math.round(chart.goals.minAccuracy * 100)}%.`);
  if (chart.goals?.scoreTarget) rules.push(`Goal: score ≥ ${chart.goals.scoreTarget.toLocaleString()}.`);
  if (extra) rules.push(extra);
  return rules;
}

function assistSummary(rankedMode = false) {
  const a = save.settings.timingAssist;
  if (a === 'wide') return 'Wide timing windows (kept off competitive boards)';
  return 'None';
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
function beginSession(chart, mode, context, opts = {}) {
  currentChart = chart;
  currentMode = mode;
  currentContext = context;
  currentOpts = opts;
  phase = 'preparing';

  createRenderer(); // reseed environment per chart
  renderer.setTheme(getTheme(save.settings.themeOverride || chart.theme), !!save.settings.cvdPalette);
  ui.showPlayfield();
  renderer.resize(); // playfield was hidden at creation; size it now that it's visible
  ui.setObjective(objectiveFor(chart, mode, context));
  ui.announce(`${chart.displayName}. Get ready.`);

  if (mode === 'learn' && opts.lesson) {
    lessonState = { lesson: opts.lesson, stepIndex: 0, count: 0 };
    ui.lessonStep(opts.lesson.steps[0].text, lessonProgressText());
    platform.telemetry('tutorial-step', { step: 0 });
  } else {
    lessonState = null;
  }

  session = new GameSession({
    chart, mode,
    failEnabled: !!opts.failEnabled,
    assists: { timingAssist: save.settings.timingAssist },
    onEvent: handleSessionEvent,
  });

  // Countdown → tutorial/countdown → active.
  phase = 'countdown';
  let n = 3;
  ui.countdown(String(n));
  audio.init();
  audio.playCountdown(n);
  audio.startAmbience(getTheme(chart.theme).ambient);
  countdownTimer = setInterval(() => {
    n--;
    if (n > 0) { ui.countdown(String(n)); audio.playCountdown(n); }
    else if (n === 0) { ui.countdown('GO'); audio.playCountdown(0); }
    else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      ui.countdown(null);
      audio.startMusic(chart);
      session.start();
      phase = 'active';
      platform.telemetry('start', { mode: 1 });
    }
  }, 600);
}

function objectiveFor(chart, mode, context) {
  if (mode === 'journey') {
    const g = chart.goals;
    return g?.minAccuracy ? `Clear with ≥ ${Math.round(g.minAccuracy * 100)}% accuracy` : 'Finish the track';
  }
  if (mode === 'daily') return 'Daily ranked run — one shot counts';
  if (mode === 'challenge') return chart.challenge?.description || 'Complete the challenge';
  if (mode === 'learn') return 'Follow the lesson';
  if (mode === 'chase') return 'Set the score for this seed';
  return 'Practice run';
}

function teardownSession() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (session && !session.finished && session.running) session.abort();
  session = null;
  lessonState = null;
  audio.stopMusic();
  audio.stopAmbience();
  ui.hideLesson();
  ui.countdown(null);
  ui.showPause(false);
  heldLanes.clear();
}

// ---------------------------------------------------------------------------
// Session events → audio / renderer / UI
// ---------------------------------------------------------------------------
function handleSessionEvent(evt) {
  if (evt.type === 'terminal') { onTerminal(evt.breakdown); return; }
  renderer?.event(evt);
  switch (evt.type) {
    case 'hit':
      audio.playHit(evt.grade, evt.combo);
      ui.judgment(evt.grade);
      haptic(12);
      lessonProgress('hit');
      break;
    case 'hold-complete':
      ui.judgment('perfect', 'hold');
      lessonProgress('hold-complete');
      save.stats.holdsCompleted = (save.stats.holdsCompleted || 0) + 1;
      break;
    case 'early-release':
      audio.playMiss();
      ui.judgment('miss', 'early');
      save.stats.earlyReleases = (save.stats.earlyReleases || 0) + 1;
      break;
    case 'miss':
      audio.playMiss();
      ui.judgment('miss');
      haptic([30, 40, 30]);
      ui.announce('Miss');
      break;
    case 'empty-hit':
      audio.playEmptyHit();
      break;
    case 'hold-tick':
      audio.playHoldTick();
      break;
  }
}

function haptic(pattern) {
  if (save.settings.haptics && navigator.vibrate) navigator.vibrate(pattern);
}

// ---------------------------------------------------------------------------
// Learn mode progression (uses the same legal-action events as play)
// ---------------------------------------------------------------------------
function lessonProgressText() {
  if (!lessonState) return '';
  const step = lessonState.lesson.steps[lessonState.stepIndex];
  return step.require ? `${lessonState.count}/${step.require.count}` : '';
}

function lessonProgress(action) {
  if (!lessonState) return;
  const { lesson } = lessonState;
  const step = lesson.steps[lessonState.stepIndex];
  if (!step.require || step.require.action !== action) {
    if (step.require?.action === 'combo' && action === 'hit' && session) {
      lessonState.count = Math.max(lessonState.count, session.state.combo);
    } else return;
  } else {
    lessonState.count++;
  }
  if (step.require && lessonState.count >= step.require.count) {
    lessonState.stepIndex++;
    lessonState.count = 0;
    platform.telemetry('tutorial-step', { step: lessonState.stepIndex });
    if (lessonState.stepIndex >= lesson.steps.length) {
      ui.lessonStep('Lesson complete! Finish the track.', '');
      save.lessons[lesson.id] = true;
      persistSave();
      setTimeout(() => ui.hideLesson(), 2200);
      lessonState = null;
      return;
    }
    audio.playUi('confirm');
  }
  const next = lesson.steps[Math.min(lessonState.stepIndex, lesson.steps.length - 1)];
  ui.lessonStep(next.text, lessonProgressText());
}

// ---------------------------------------------------------------------------
// Terminal → results → progression
// ---------------------------------------------------------------------------
function onTerminal(breakdown) {
  phase = 'results';
  audio.playResultFanfare(breakdown.grade);
  platform.telemetry('round-end', { score: breakdown.total, completed: breakdown.terminalReason === 'complete' });

  const completed = breakdown.terminalReason === 'complete';
  const unlockedAch = [];
  const tryUnlock = (key) => {
    // Achievements are local (part of the cloud-saved doc) — a pure browser
    // game has no server-authoritative unlock path.
    if (unlockAchievement(save, key)) {
      unlockedAch.push(ACHIEVEMENTS.find((a) => a.key === key));
    }
  };

  let headline = '';
  let canNext = false;
  let detail = '';

  if (completed) {
    tryUnlock('first-light');
    if (breakdown.maxCombo >= 50) tryUnlock('streak-50');
    if ((save.stats.holdsCompleted || 0) >= 25 && !(save.stats.earlyReleases > 0)) tryUnlock('hold-mastery');
  }
  const days = markPlayedToday(save, platform.nowUtcDateString());
  if (days >= 7) tryUnlock('long-road');

  // Mastery XP: score-derived, plus completion bonus.
  const xp = Math.round(breakdown.total / 50) + (completed ? 25 : 0);
  const leveled = awardMasteryXp(save, xp);
  const xpText = `+${xp} mastery XP${leveled ? ` — level ${save.mastery.level}!` : ''}`;

  save.stats.sessionsPlayed++;
  save.stats.totalScore += breakdown.total;
  save.stats.bestCombo = Math.max(save.stats.bestCombo, breakdown.maxCombo);

  if (currentMode === 'journey') {
    const idx = currentContext.stageIndex;
    const minAcc = currentChart.goals?.minAccuracy || 0;
    const passed = completed && breakdown.accuracy >= minAcc;
    if (passed) {
      const stars = starsForResult(breakdown);
      save.journey.stars[idx] = Math.max(save.journey.stars[idx] || 0, stars);
      save.journey.bestScores[idx] = Math.max(save.journey.bestScores[idx] || 0, breakdown.total);
      if (idx + 1 >= save.journey.unlocked) save.journey.unlocked = Math.min(JOURNEY_STAGES.length, idx + 2);
      headline = `${currentChart.displayName} cleared — ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`;
      canNext = idx + 1 < JOURNEY_STAGES.length;
      if (idx === JOURNEY_STAGES.length - 1) tryUnlock('summit-clear');
    } else {
      headline = completed && breakdown.accuracy < minAcc
        ? `Accuracy ${(breakdown.accuracy * 100).toFixed(1)}% — goal is ${Math.round(minAcc * 100)}%`
        : 'Track failed — try again';
    }
  } else if (currentMode === 'daily') {
    const date = currentContext.date;
    const prev = save.daily.history[date];
    if (completed && (!prev || breakdown.total > prev.score)) {
      save.daily.history[date] = { score: breakdown.total, grade: breakdown.grade };
    }
    headline = completed ? 'Daily run complete' : 'Daily run ended';
    detail = 'Personal best recorded in your save.';
  } else if (currentMode === 'chase') {
    const key = `${currentContext.seed}`;
    const board = save.chaseBoards[key] || (save.chaseBoards[key] = []);
    board.push({ name: save.profile.displayName, score: breakdown.total, total: breakdown.total, grade: breakdown.grade, sessionId: breakdown.sessionId, terminalReason: breakdown.terminalReason, invalidActions: breakdown.invalidActions, elapsedMs: breakdown.elapsedMs });
    board.sort((a, b) => compareResults(chaseEntry(a), chaseEntry(b)));
    save.chaseBoards[key] = board.slice(0, 20);
    headline = completed ? 'Score posted to your seed board' : 'Run ended';
  } else if (currentMode === 'challenge') {
    const goalMet = completed &&
      breakdown.accuracy >= (currentChart.goals?.minAccuracy || 0) &&
      breakdown.total >= (currentChart.goals?.scoreTarget || 0);
    headline = goalMet ? 'Challenge complete!' : completed ? 'Finished — goal not met' : 'Challenge failed';
  } else if (currentMode === 'learn') {
    headline = completed ? 'Lesson track complete' : 'Lesson ended';
  } else {
    headline = completed ? 'Practice complete' : 'Practice ended';
  }

  if (currentMode === 'learn' && currentContext.lessonId && completed) {
    save.lessons[currentContext.lessonId] = true;
  }

  persistSave();
  ui.showResults(breakdown, { headline, canNext, achievements: unlockedAch, xpText, detail });
  // Signed in: every completed run except lessons posts its total to the
  // StarHermit high-score board.
  if (completed && currentMode !== 'learn' && platform.isHosted()) {
    ui.showLeaderboardPosting(platform.submitScore(breakdown.total));
  }
  session = null;
}

// ---------------------------------------------------------------------------
// Input routing
// ---------------------------------------------------------------------------
function handleLanePointer(lane, phase_) {
  if (!session || phase !== 'active') return;
  if (phase_ === 'down') laneDown(lane);
  else laneUp(lane);
}

function laneDown(lane) {
  audio.init();
  renderer?.pressLane(lane, true);
  ui.laneButtonState(lane, true);
  if (!session || phase !== 'active' || session.paused) return;
  if (save.settings.holdMode === 'toggle' && heldLanes.has(lane)) {
    heldLanes.delete(lane);
    session.release(lane);
    renderer?.pressLane(lane, false);
    ui.laneButtonState(lane, false);
    return;
  }
  heldLanes.add(lane);
  session.tap(lane);
}

function laneUp(lane) {
  renderer?.pressLane(lane, false);
  ui.laneButtonState(lane, false);
  if (!session || session.paused) { heldLanes.delete(lane); return; }
  if (save.settings.holdMode === 'toggle') return; // toggle releases on second tap
  if (heldLanes.delete(lane)) session.release(lane);
}

function bindLaneButtons() {
  document.querySelectorAll('.lane-btn').forEach((btn) => {
    const lane = parseInt(btn.dataset.lane, 10);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      laneDown(lane);
    });
    btn.addEventListener('pointerup', () => laneUp(lane));
    btn.addEventListener('pointercancel', () => laneUp(lane));
    btn.addEventListener('lostpointercapture', () => laneUp(lane));
    // Prevent the button from taking keyboard focus on click (keeps Space/Enter safe).
    btn.addEventListener('click', (e) => e.preventDefault());
  });
}

const pressedKeys = new Set();

function bindGlobalInput() {
  // Keydown is routed by KeyboardEvent.code through the player's bindings
  // (control.* in starhermit.txt; platform overrides when signed in).
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return; // action identifiers guard double commits; ignore OS repeat
    const code = e.code;
    const action = platform.actionFor(code);

    // Pause / cancel (Escape always backs out of menus).
    if (action === 'pause' || code === 'Escape') {
      // Settings/help opened over the pause menu close first — Escape must not
      // resume play while a panel is still covering the playfield.
      if (ui.overlayScreenVisible()) { ui.navBack(); e.preventDefault(); return; }
      if (phase === 'active') { pauseGame(); e.preventDefault(); return; }
      if (phase === 'paused') { resumeGame(); e.preventDefault(); return; }
      if (phase === 'countdown') { controller.leaveGame(); e.preventDefault(); return; }
      if (ui.anyScreenVisible()) { ui.navBack(); return; }
    }

    if (phase !== 'active' || !session || session.paused) return;

    const lane = platform.LANE_ACTIONS.indexOf(action);
    if (lane >= 0 && !pressedKeys.has(code)) {
      pressedKeys.add(code);
      e.preventDefault();
      laneDown(lane);
    }
  });

  document.addEventListener('keyup', (e) => {
    const code = e.code;
    if (!pressedKeys.delete(code)) return;
    const lane = platform.LANE_ACTIONS.indexOf(platform.actionFor(code));
    if (lane >= 0) laneUp(lane);
  });

  // Never lose held notes when the window blurs mid-hold.
  window.addEventListener('blur', () => {
    for (const lane of [...heldLanes]) laneUp(lane);
    pressedKeys.clear();
  });
}

function pauseGame() {
  if (!session || phase !== 'active') return;
  phase = 'paused';
  session.pause();
  // Drop input state: the pause dialog swallows the pointer/key release that
  // would otherwise clear it, which would leave lanes stuck lit.
  for (const lane of [...heldLanes]) { heldLanes.delete(lane); renderer?.pressLane(lane, false); ui.laneButtonState(lane, false); }
  pressedKeys.clear();
  audio.stopMusic(); // solo simulation pauses; music restarts on resume at song position
  ui.showPause(true);
  ui.announce('Paused');
}

function resumeGame() {
  if (!session || phase !== 'paused') return;
  ui.showPause(false);
  // Re-anchor music to the exact paused song position.
  audio.resumeAll();
  audio.startMusic(currentChart, { startAtMs: session.songTimeMs() });
  session.resume();
  phase = 'active';
  ui.announce('Resumed');
}

function bindViewportLifecycle() {
  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderer?.resize(), 60); // no input loss, no round restart
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (visualViewport) visualViewport.addEventListener('resize', onResize);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (phase === 'active') pauseGame(); // backgrounding pauses solo simulation
      audio.suspendAll();
    } else {
      if (phase !== 'paused') audio.resumeAll();
    }
  });
}

// ---------------------------------------------------------------------------
// Gamepad: lanes + pause in play; focus navigation in menus.
// ---------------------------------------------------------------------------
function pollGamepad(dtMs) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && [...pads].find((p) => p && p.connected);
  if (!gp) return;
  gamepadNavCooldown = Math.max(0, gamepadNavCooldown - dtMs);

  const pressed = (i) => !!gp.buttons[i]?.pressed;

  if (phase === 'active' && session && !session.paused) {
    // Face buttons 0-3 and dpad 12-15 map to lanes.
    const map = [pressed(0) || pressed(12), pressed(1) || pressed(13), pressed(2) || pressed(14), pressed(3) || pressed(15)];
    map.forEach((down, lane) => {
      if (down && !gamepadLaneState[lane]) laneDown(lane);
      if (!down && gamepadLaneState[lane]) laneUp(lane);
      gamepadLaneState[lane] = down;
    });
    if (pressed(9)) pauseGame();
  } else if (gamepadNavCooldown <= 0) {
    // Menu navigation: dpad up/down moves DOM focus, A confirms, B goes back.
    const focusables = [...document.querySelectorAll('.screen:not(.hidden) button, .overlay:not(.hidden) button, .screen:not(.hidden) input, .screen:not(.hidden) select')]
      .filter((el) => !el.disabled);
    if (pressed(12) || pressed(13)) {
      const idx = focusables.indexOf(document.activeElement);
      const next = focusables[(idx + (pressed(13) ? 1 : focusables.length - 1)) % focusables.length];
      next?.focus();
      gamepadNavCooldown = 180;
    } else if (pressed(0) && document.activeElement?.click) {
      document.activeElement.click();
      gamepadNavCooldown = 220;
    } else if (pressed(1)) {
      ui.navBack();
      gamepadNavCooldown = 220;
    } else if (pressed(9) && phase === 'paused') {
      resumeGame();
      gamepadNavCooldown = 220;
    }
  }
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = lastFrame ? now - lastFrame : 16;
  lastFrame = now;

  // Zero-render heartbeat when hidden (rAF already throttles to ~0).
  if (document.hidden) return;

  const active = session; // local ref: update() may finalize and clear `session`
  if (active && phase === 'active') {
    active.update();
    const snap = active.snapshot();
    renderer?.update(snap, dt);
    audio.setIntensity(Math.min(1, snap.combo / 60));
    hudThrottle -= dt;
    if (hudThrottle <= 0) { hudThrottle = 120; ui.updateHud(snap); }
  } else {
    renderer?.update(active ? active.snapshot() : null, dt);
  }
  pollGamepad(dt);
}

function renderTitleStatuses() {
  // Refresh daily/journey status after time sync — only if title is current.
  const title = document.getElementById('screen-title');
  if (title && !title.classList.contains('hidden')) ui.showScreen('title');
}

// ---------------------------------------------------------------------------
// Audio captions → visual cue line
// ---------------------------------------------------------------------------
audio.onCaption = (text) => ui.caption(text);

boot();

// Debug/test handle (read-only views; no rules mutation path).
window.RhythmSteps = {
  getPhase: () => phase,
  getSession: () => session,
  getSave: () => save,
  getChart: () => currentChart,
  getRenderer: () => renderer,
};

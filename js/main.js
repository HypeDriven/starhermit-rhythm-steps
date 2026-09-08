// Bootstrap + controller: wires rules, session, render, ui, audio, platform.
// Owns the frame loop, input routing, game-state transitions, and progression.

import { GameSession } from './session.js';
import { Renderer3D, webglAvailable } from './render3d.js';
import { Renderer2D } from './render2d.js';
import { audio } from './audio.js';
import * as ui from './ui.js';
import * as platform from './platform.js';
import {
  loadSave, writeSave, defaultSave, unlockAchievement, awardMasteryXp,
  starsForResult, markPlayedToday, ACHIEVEMENTS,
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
function boot() {
  save = loadSave();
  applySettingsSideEffects();
  platform.detectHost();
  platform.setTelemetryConsent(!!save.settings.telemetryConsent);
  platform.syncTime().then(() => renderTitleStatuses());
  createRenderer();

  ui.initUI(controller);
  ui.setLaneKeyLabels(save.settings.keys);
  bindGlobalInput();
  bindLaneButtons();
  bindViewportLifecycle();

  phase = 'title';
  ui.showScreen('title');
  renderer.resize(); // size the playfield canvas to the viewport from boot
  platform.startActivity();
  window.addEventListener('beforeunload', () => { platform.endActivity(); writeSave(save); });
  requestAnimationFrame(frame);
  platform.telemetry('start', { hosted: platform.isHosted() });
}

function createRenderer() {
  const host = document.getElementById('canvas-host');
  if (renderer) { renderer.dispose(); renderer = null; host.innerHTML = ''; }
  const theme = currentChart ? getTheme(save.settings.themeOverride || currentChart.theme) : getTheme('neon-causeway');
  const quality = resolveQualityTier();
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
    quality,
    seed: currentChart ? currentChart.seed : 1,
    onLaneInput: handleLanePointer,
    onContextLost: () => {
      ui.toast('Graphics context lost — rebuilding…');
      setTimeout(() => { createRenderer(); }, 250); // GPU resources rebuilt from retained descriptors
    },
  };
  if (webglAvailable()) {
    try { renderer = new Renderer3D(host, opts); usingFallback = false; }
    catch (e) { console.warn('3D init failed, using 2D', e); renderer = new Renderer2D(host, opts); usingFallback = true; }
  } else {
    renderer = new Renderer2D(host, opts);
    usingFallback = true;
  }
}

function resolveQualityTier() {
  const t = save.settings.qualityTier;
  if (t !== 'auto') return t;
  // Capability detection: coarse pointer or small screen → medium; low cores → low.
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 4 && matchMedia('(pointer: coarse)').matches) return 'low';
  if (matchMedia('(pointer: coarse)').matches) return 'medium';
  return 'high';
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
    renderer.setQuality?.(resolveQualityTier());
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

  applySetting(key, value) {
    save.settings[key] = value;
    applySettingsSideEffects();
    ui.setLaneKeyLabels(save.settings.keys);
    ui.refreshHelpCards();
    writeSave(save);
    platform.telemetry('settings-change');
  },

  rebindKey(lane, key) {
    // Prevent duplicate bindings.
    const existing = save.settings.keys.indexOf(key);
    if (existing >= 0 && existing !== lane) save.settings.keys[existing] = save.settings.keys[lane];
    save.settings.keys[lane] = key;
    writeSave(save);
    ui.setLaneKeyLabels(save.settings.keys);
    ui.refreshHelpCards();
  },

  updateProfile({ displayName }) {
    save.profile.displayName = displayName;
    writeSave(save);
    ui.toast('Profile updated');
  },

  resetSave() {
    save = defaultSave();
    writeSave(save);
    applySettingsSideEffects();
    ui.refreshSettingsPanel();
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
      description: 'One shared seed and ruleset for everyone, per UTC day. Your best run is ranked.',
      rules: setupRules(chart, 'Ranked submission includes the replay for validation.'),
      durationMs: chart.durationMs,
      ranked: true,
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
      rules: setupRules(chart, 'Scores for this seed appear on the shared board.'),
      durationMs: chart.durationMs,
      ranked: true,
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
  if (a === 'wide') return rankedMode ? 'Wide timing windows (submission labeled assisted)' : 'Wide timing windows';
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
      platform.startHeartbeat();
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
  platform.stopHeartbeat();
  ui.hideLesson();
  ui.countdown(null);
  ui.showPause(false);
  heldLanes.clear();
}

// ---------------------------------------------------------------------------
// Session events → audio / renderer / UI
// ---------------------------------------------------------------------------
function handleSessionEvent(evt) {
  if (evt.type === 'terminal') { onTerminal(evt.breakdown, evt.envelope); return; }
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
      writeSave(save);
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
function onTerminal(breakdown, envelope) {
  phase = 'results';
  platform.stopHeartbeat();
  audio.playResultFanfare(breakdown.grade);
  platform.telemetry('round-end', { score: breakdown.total, completed: breakdown.terminalReason === 'complete' });

  const completed = breakdown.terminalReason === 'complete';
  const unlockedAch = [];
  const tryUnlock = (key) => {
    if (unlockAchievement(save, key)) {
      unlockedAch.push(ACHIEVEMENTS.find((a) => a.key === key));
      platform.deliverAchievement(key);
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
    detail = 'Your replay was recorded for validation.';
    if (completed && breakdown.total > 0 && save.settings.timingAssist !== 'wide') {
      platform.submitScore(envelope).then((r) => {
        if (r.ok) ui.toast('Daily score submitted');
        else if (r.error !== 'not-hosted') ui.toast(`Submission: ${r.error}`);
      });
    }
  } else if (currentMode === 'chase') {
    const key = `${currentContext.seed}`;
    const board = save.chaseBoards[key] || (save.chaseBoards[key] = []);
    board.push({ name: save.profile.displayName, score: breakdown.total, total: breakdown.total, grade: breakdown.grade, sessionId: breakdown.sessionId, terminalReason: breakdown.terminalReason, invalidActions: breakdown.invalidActions, elapsedMs: breakdown.elapsedMs });
    board.sort((a, b) => compareResults(chaseEntry(a), chaseEntry(b)));
    save.chaseBoards[key] = board.slice(0, 20);
    headline = completed ? 'Score posted to the seed board' : 'Run ended';
    if (completed && save.settings.timingAssist !== 'wide') platform.submitScore(envelope);
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

  writeSave(save);
  platform.cloudPush(JSON.parse(JSON.stringify(save))); // fire-and-forget; conflicts handled on pull
  ui.showResults(breakdown, { headline, canNext, achievements: unlockedAch, xpText, detail });
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
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return; // action identifiers guard double commits; ignore OS repeat
    const key = e.key.toLowerCase();

    // Pause / cancel.
    if (key === (save.settings.pauseKey || 'escape') || key === 'escape') {
      // Settings/help opened over the pause menu close first — Escape must not
      // resume play while a panel is still covering the playfield.
      if (ui.overlayScreenVisible()) { ui.navBack(); e.preventDefault(); return; }
      if (phase === 'active') { pauseGame(); e.preventDefault(); return; }
      if (phase === 'paused') { resumeGame(); e.preventDefault(); return; }
      if (phase === 'countdown') { controller.leaveGame(); e.preventDefault(); return; }
      if (ui.anyScreenVisible()) { ui.navBack(); return; }
    }

    if (phase !== 'active' || !session || session.paused) return;

    const lane = save.settings.keys.indexOf(key);
    if (lane >= 0 && !pressedKeys.has(key)) {
      pressedKeys.add(key);
      e.preventDefault();
      laneDown(lane);
    }
  });

  document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (!pressedKeys.delete(key)) return;
    const lane = save.settings.keys.indexOf(key);
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

// Content: versioned charts, journey progression, daily seeds, practice,
// challenge variants, validators, and presentation themes.
// All generation is deterministic from (id, seed, version).

import { makeRng, hashString, dailySeed, streamSeed } from './rng.js';
import { LANES, RULES_VERSION } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Chart generator. Difficulty is measured from pattern depth, branching,
// time pressure, motor precision, and recovery — not merely bigger numbers.
// ---------------------------------------------------------------------------
// params: { bpm, beats, density (0-1 notes per beat), holdRatio, chordRatio,
//           streamRatio (consecutive same-lane runs), swing, minGapBeats }
export function generateChart({ id, seed, bpm, beats, density, holdRatio = 0, chordRatio = 0, streamRatio = 0, minGapBeats = 0.5, goals = {}, mechanics = [], theme = 'neon-causeway', par = null }) {
  const rng = makeRng(streamSeed(seed, 'chart'));
  const beatMs = 60000 / bpm;
  const notes = [];
  let lastTimePerLane = new Array(LANES).fill(-Infinity);
  let prevLane = -1;
  let noteId = 0;
  const minGapMs = minGapBeats * beatMs;
  const leadInMs = beatMs * 4; // one bar of count-in before the first note

  for (let beat = 0; beat < beats; beat++) {
    if (!rng.chance(density)) continue;
    // Quantize to the beat grid (eighth notes at higher density).
    const sub = density > 0.75 && rng.chance(0.4) ? 0.5 : 0;
    const time = Math.round(leadInMs + (beat + sub) * beatMs);
    let lane;
    if (streamRatio > 0 && prevLane >= 0 && rng.chance(streamRatio)) {
      lane = prevLane; // controlled same-lane stream (motor precision)
    } else {
      const candidates = [];
      for (let l = 0; l < LANES; l++) {
        if (l !== prevLane && time - lastTimePerLane[l] >= minGapMs) candidates.push(l);
      }
      lane = candidates.length ? rng.pick(candidates) : rng.int(0, LANES - 1);
    }
    if (time - lastTimePerLane[lane] < minGapMs) continue;

    let kind = 'tap';
    let duration = 0;
    if (holdRatio > 0 && rng.chance(holdRatio)) {
      kind = 'hold';
      duration = Math.round(beatMs * rng.pick([1, 1.5, 2, 3]));
    }
    notes.push({ id: noteId++, time, lane, kind, duration });
    lastTimePerLane[lane] = kind === 'hold' ? time + duration : time;
    prevLane = lane;

    // Chords: simultaneous note on a second lane (never same lane).
    if (chordRatio > 0 && rng.chance(chordRatio)) {
      const others = [];
      for (let l = 0; l < LANES; l++) if (l !== lane && time - lastTimePerLane[l] >= minGapMs) others.push(l);
      if (others.length) {
        const l2 = rng.pick(others);
        notes.push({ id: noteId++, time, lane: l2, kind: 'tap', duration: 0 });
        lastTimePerLane[l2] = time;
      }
    }
  }
  // A chart must always contain at least one playable note.
  if (notes.length === 0) {
    notes.push({ id: noteId++, time: Math.round(leadInMs), lane: rng.int(0, LANES - 1), kind: 'tap', duration: 0 });
  }
  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);

  const last = notes.length ? notes[notes.length - 1] : { time: leadInMs, duration: 0 };
  const durationMs = last.time + (last.duration || 0) + Math.round(beatMs * 2);

  const chart = {
    id, version: CONTENT_VERSION, rulesVersion: RULES_VERSION,
    seed: seed >>> 0, bpm, beats, notes, durationMs,
    goals: { complete: true, minAccuracy: goals.minAccuracy ?? 0, maxMisses: goals.maxMisses ?? null, scoreTarget: goals.scoreTarget ?? null },
    mechanics, theme,
    par: par || estimatePar(notes),
  };
  const v = validateChart(chart);
  if (!v.ok) throw new Error(`generated chart failed validation: ${v.errors.join('; ')}`);
  return chart;
}

function estimatePar(notes) {
  // Par = perfect-run score estimate, used for score targets.
  let base = 0, hold = 0, combo = 0, comboBonus = 0;
  for (const n of notes) {
    base += 300;
    combo++;
    comboBonus += Math.min(100, Math.floor(combo / 10) * 2);
    if (n.kind === 'hold') hold += Math.floor(n.duration / 100) * 10;
  }
  return base + comboBonus + hold;
}

// ---------------------------------------------------------------------------
// Validators — prove basic legality, reachable goals, bounded duration,
// absence of soft locks.
// ---------------------------------------------------------------------------
export function validateChart(chart) {
  const errors = [];
  if (!chart || typeof chart !== 'object') return { ok: false, errors: ['not-an-object'] };
  if (typeof chart.id !== 'string' || !chart.id) errors.push('missing-id');
  if (!(chart.seed >>> 0) && chart.seed !== 0) errors.push('missing-seed');
  if (!(chart.bpm >= 40 && chart.bpm <= 300)) errors.push('bpm-out-of-range');
  if (!Array.isArray(chart.notes)) errors.push('notes-not-array');
  else {
    let prevTime = -Infinity;
    const laneBusyUntil = new Array(LANES).fill(-Infinity);
    for (const n of chart.notes) {
      if (!(n.time >= 0) || !Number.isFinite(n.time)) { errors.push('bad-note-time'); break; }
      if (n.lane < 0 || n.lane >= LANES) { errors.push('lane-out-of-range'); break; }
      if (n.time < prevTime) { errors.push('notes-not-sorted'); break; }
      if (n.kind !== 'tap' && n.kind !== 'hold') { errors.push('bad-note-kind'); break; }
      if (n.kind === 'hold' && !(n.duration >= 100)) { errors.push('bad-hold-duration'); break; }
      // No overlapping notes on the same lane (would soft-lock inputs).
      if (n.time < laneBusyUntil[n.lane]) { errors.push('overlapping-lane-notes'); break; }
      laneBusyUntil[n.lane] = n.time + (n.duration || 0) + 30;
      prevTime = n.time;
    }
    if (chart.notes.length === 0) errors.push('empty-chart');
  }
  if (!(chart.durationMs > 0 && chart.durationMs <= 10 * 60 * 1000)) errors.push('duration-unbounded');
  if (chart.goals) {
    if (chart.goals.minAccuracy != null && (chart.goals.minAccuracy < 0 || chart.goals.minAccuracy > 1)) errors.push('bad-accuracy-goal');
    if (chart.goals.scoreTarget != null && chart.par && chart.goals.scoreTarget > chart.par) errors.push('unreachable-score-goal');
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Journey: 40 authored stages. One new concept in isolation, combine with a
// known concept, then a mastery test before the next mechanic. Every 8th
// stage is a mastery stage.
// ---------------------------------------------------------------------------
const STAGE_THEMES = ['neon-causeway', 'tideglass', 'ember-line', 'verdant-pulse', 'umbra-hall'];

function stage(i, name, params, mechanics, extra = {}) {
  return {
    index: i,
    id: `journey-${String(i + 1).padStart(2, '0')}`,
    name,
    seed: hashString(`rhythm-steps:journey:v${CONTENT_VERSION}:${i}`),
    params, mechanics,
    mastery: (i + 1) % 8 === 0,
    theme: STAGE_THEMES[Math.floor(i / 8) % STAGE_THEMES.length],
    ...extra,
  };
}

export const JOURNEY_STAGES = (() => {
  const S = [];
  // Block 1 (1-8): single taps on the beat.
  S.push(stage(0, 'First Light', { bpm: 90, beats: 32, density: 0.45 }, ['tap']));
  S.push(stage(1, 'Steady Walk', { bpm: 95, beats: 40, density: 0.5 }, ['tap']));
  S.push(stage(2, 'Crossing Lanes', { bpm: 100, beats: 44, density: 0.55 }, ['tap']));
  S.push(stage(3, 'Off the Cuff', { bpm: 100, beats: 48, density: 0.6 }, ['tap']));
  S.push(stage(4, 'Quickstep', { bpm: 108, beats: 48, density: 0.6, minGapBeats: 0.5 }, ['tap']));
  S.push(stage(5, 'Lantern Row', { bpm: 112, beats: 56, density: 0.62 }, ['tap']));
  S.push(stage(6, 'Causeway Run', { bpm: 115, beats: 60, density: 0.65 }, ['tap']));
  S.push(stage(7, 'Mastery: Beacon', { bpm: 118, beats: 64, density: 0.68 }, ['tap'], { goals: { minAccuracy: 0.85 } }));
  // Block 2 (9-16): holds introduced, then combined.
  S.push(stage(8, 'Hold the Line', { bpm: 95, beats: 40, density: 0.45, holdRatio: 0.25 }, ['tap', 'hold']));
  S.push(stage(9, 'Long Glow', { bpm: 98, beats: 44, density: 0.5, holdRatio: 0.3 }, ['tap', 'hold']));
  S.push(stage(10, 'Tap and Sustain', { bpm: 104, beats: 48, density: 0.55, holdRatio: 0.25 }, ['tap', 'hold']));
  S.push(stage(11, 'Suspended', { bpm: 108, beats: 52, density: 0.55, holdRatio: 0.35 }, ['tap', 'hold']));
  S.push(stage(12, 'Weave', { bpm: 112, beats: 56, density: 0.6, holdRatio: 0.28 }, ['tap', 'hold']));
  S.push(stage(13, 'Slow River', { bpm: 92, beats: 48, density: 0.5, holdRatio: 0.45 }, ['tap', 'hold']));
  S.push(stage(14, 'Currents', { bpm: 116, beats: 60, density: 0.62, holdRatio: 0.3 }, ['tap', 'hold']));
  S.push(stage(15, 'Mastery: Reservoir', { bpm: 118, beats: 64, density: 0.65, holdRatio: 0.32 }, ['tap', 'hold'], { goals: { minAccuracy: 0.87 } }));
  // Block 3 (17-24): chords (two-lane simultaneous).
  S.push(stage(16, 'Twin Sparks', { bpm: 96, beats: 40, density: 0.5, chordRatio: 0.2 }, ['tap', 'chord']));
  S.push(stage(17, 'Double Step', { bpm: 100, beats: 44, density: 0.52, chordRatio: 0.25 }, ['tap', 'chord']));
  S.push(stage(18, 'Anchor Points', { bpm: 104, beats: 48, density: 0.55, chordRatio: 0.2, holdRatio: 0.15 }, ['tap', 'hold', 'chord']));
  S.push(stage(19, 'Parallel', { bpm: 108, beats: 52, density: 0.58, chordRatio: 0.28 }, ['tap', 'chord']));
  S.push(stage(20, 'Bright Arches', { bpm: 112, beats: 56, density: 0.6, chordRatio: 0.3 }, ['tap', 'hold', 'chord']));
  S.push(stage(21, 'Chorus Line', { bpm: 116, beats: 60, density: 0.62, chordRatio: 0.3 }, ['tap', 'chord']));
  S.push(stage(22, 'Twin Rivers', { bpm: 118, beats: 60, density: 0.62, chordRatio: 0.32, holdRatio: 0.2 }, ['tap', 'hold', 'chord']));
  S.push(stage(23, 'Mastery: Confluence', { bpm: 120, beats: 64, density: 0.65, chordRatio: 0.3, holdRatio: 0.22 }, ['tap', 'hold', 'chord'], { goals: { minAccuracy: 0.88 } }));
  // Block 4 (25-32): streams (same-lane runs) and eighth notes.
  S.push(stage(24, 'Drumline', { bpm: 108, beats: 44, density: 0.6, streamRatio: 0.3, minGapBeats: 0.5 }, ['tap', 'stream']));
  S.push(stage(25, 'Hammerfall', { bpm: 112, beats: 48, density: 0.62, streamRatio: 0.35, minGapBeats: 0.5 }, ['tap', 'stream']));
  S.push(stage(26, 'Eighth Wonder', { bpm: 116, beats: 52, density: 0.78, streamRatio: 0.25, minGapBeats: 0.5 }, ['tap', 'stream']));
  S.push(stage(27, 'Percussion Garden', { bpm: 118, beats: 56, density: 0.75, streamRatio: 0.3, chordRatio: 0.15 }, ['tap', 'stream', 'chord']));
  S.push(stage(28, 'Rapid Transit', { bpm: 122, beats: 60, density: 0.78, streamRatio: 0.32 }, ['tap', 'stream']));
  S.push(stage(29, 'Cascade', { bpm: 124, beats: 60, density: 0.8, streamRatio: 0.3, holdRatio: 0.15 }, ['tap', 'hold', 'stream']));
  S.push(stage(30, 'Overdrive Alley', { bpm: 126, beats: 64, density: 0.8, streamRatio: 0.35, chordRatio: 0.2 }, ['tap', 'stream', 'chord']));
  S.push(stage(31, 'Mastery: Avalanche', { bpm: 128, beats: 64, density: 0.82, streamRatio: 0.35, chordRatio: 0.22, holdRatio: 0.15 }, ['tap', 'hold', 'stream', 'chord'], { goals: { minAccuracy: 0.9 } }));
  // Block 5 (33-40): everything combined at rising tempo.
  S.push(stage(32, 'Grand Causeway', { bpm: 124, beats: 64, density: 0.7, holdRatio: 0.2, chordRatio: 0.2, streamRatio: 0.2 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(33, 'Night Parade', { bpm: 126, beats: 68, density: 0.72, holdRatio: 0.22, chordRatio: 0.22, streamRatio: 0.22 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(34, 'Signal Fire', { bpm: 128, beats: 68, density: 0.75, holdRatio: 0.22, chordRatio: 0.24, streamRatio: 0.25 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(35, 'Tide and Ember', { bpm: 130, beats: 72, density: 0.76, holdRatio: 0.24, chordRatio: 0.24, streamRatio: 0.26 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(36, 'Umbra Crossing', { bpm: 132, beats: 72, density: 0.78, holdRatio: 0.24, chordRatio: 0.25, streamRatio: 0.28 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(37, 'High Noon Circuit', { bpm: 134, beats: 76, density: 0.8, holdRatio: 0.25, chordRatio: 0.25, streamRatio: 0.3 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(38, 'Starfield Sprint', { bpm: 138, beats: 80, density: 0.82, holdRatio: 0.25, chordRatio: 0.26, streamRatio: 0.3 }, ['tap', 'hold', 'chord', 'stream']));
  S.push(stage(39, 'Mastery: Summit of Light', { bpm: 140, beats: 84, density: 0.85, holdRatio: 0.26, chordRatio: 0.28, streamRatio: 0.32 }, ['tap', 'hold', 'chord', 'stream'], { goals: { minAccuracy: 0.92 } }));
  return S;
})();

const journeyCache = new Map();
export function journeyChart(index) {
  if (journeyCache.has(index)) return journeyCache.get(index);
  const s = JOURNEY_STAGES[index];
  if (!s) return null;
  const chart = generateChart({
    id: s.id, seed: s.seed, ...s.params,
    goals: s.goals || {}, mechanics: s.mechanics, theme: s.theme,
  });
  chart.displayName = s.name;
  chart.mastery = s.mastery;
  journeyCache.set(index, chart);
  return chart;
}

// ---------------------------------------------------------------------------
// Daily: one shared seed and ruleset per UTC day, synchronized to platform time.
// ---------------------------------------------------------------------------
export function dailyInfo(utcDateString) {
  const seed = dailySeed(utcDateString);
  const dayHash = hashString(utcDateString);
  const difficultyBand = dayHash % 3; // rotates easy/medium/hard by day
  const params = [
    { bpm: 105, beats: 56, density: 0.6, holdRatio: 0.2, chordRatio: 0.1 },
    { bpm: 118, beats: 64, density: 0.68, holdRatio: 0.22, chordRatio: 0.18, streamRatio: 0.15 },
    { bpm: 128, beats: 72, density: 0.75, holdRatio: 0.24, chordRatio: 0.22, streamRatio: 0.25 },
  ][difficultyBand];
  return {
    date: utcDateString, seed, rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION,
    difficultyBand, params, theme: STAGE_THEMES[dayHash % STAGE_THEMES.length],
    ranked: true,
  };
}

export function dailyChart(utcDateString) {
  const info = dailyInfo(utcDateString);
  const chart = generateChart({
    id: `daily-${utcDateString}`, seed: info.seed, ...info.params,
    mechanics: ['tap', 'hold', 'chord', 'stream'], theme: info.theme,
  });
  chart.displayName = `Daily — ${utcDateString}`;
  chart.ranked = true;
  return chart;
}

// ---------------------------------------------------------------------------
// Practice: selectable difficulty, unranked.
// ---------------------------------------------------------------------------
export const PRACTICE_DIFFICULTIES = [
  { key: 'calm', label: 'Calm', params: { bpm: 95, beats: 40, density: 0.5, holdRatio: 0.15 } },
  { key: 'steady', label: 'Steady', params: { bpm: 108, beats: 48, density: 0.6, holdRatio: 0.2, chordRatio: 0.1 } },
  { key: 'brisk', label: 'Brisk', params: { bpm: 118, beats: 56, density: 0.68, holdRatio: 0.22, chordRatio: 0.16, streamRatio: 0.15 } },
  { key: 'intense', label: 'Intense', params: { bpm: 128, beats: 64, density: 0.75, holdRatio: 0.24, chordRatio: 0.2, streamRatio: 0.25 } },
  { key: 'relentless', label: 'Relentless', params: { bpm: 138, beats: 72, density: 0.82, holdRatio: 0.25, chordRatio: 0.25, streamRatio: 0.3 } },
];

export function practiceChart(difficultyKey, customSeed = null, theme = 'neon-causeway') {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.key === difficultyKey) || PRACTICE_DIFFICULTIES[1];
  const seed = customSeed != null ? customSeed >>> 0 : hashString(`practice:${difficultyKey}:${Date.now ? 0 : 0}`) ^ 0x5eed;
  const chart = generateChart({
    id: `practice-${difficultyKey}`, seed, ...d.params,
    mechanics: ['tap', 'hold', 'chord', 'stream'], theme,
  });
  chart.displayName = `Practice — ${d.label}`;
  chart.ranked = false;
  return chart;
}

// ---------------------------------------------------------------------------
// Challenge: constrained goals — speed targets, move limits, altered layouts.
// ---------------------------------------------------------------------------
export const CHALLENGES = [
  { key: 'full-combo', name: 'Unbroken', description: 'Finish with zero misses. One miss ends the run.', modifiers: { failEnabled: true, maxMisses: 0 }, params: { bpm: 112, beats: 56, density: 0.62, holdRatio: 0.2, chordRatio: 0.12 } },
  { key: 'speed-target', name: 'Redline 140', description: 'A 140 BPM speed target. Hold accuracy above 80%.', modifiers: { minAccuracy: 0.8 }, params: { bpm: 140, beats: 64, density: 0.7, streamRatio: 0.3 } },
  { key: 'survival', name: 'Thin Ice', description: 'Health drain is on. Misses cost dearly; empty taps chip away.', modifiers: { failEnabled: true }, params: { bpm: 120, beats: 64, density: 0.7, holdRatio: 0.2, chordRatio: 0.18 } },
  { key: 'hold-heavy', name: 'Longform', description: 'Sustains everywhere. Release discipline is the goal.', modifiers: { minAccuracy: 0.85 }, params: { bpm: 100, beats: 52, density: 0.55, holdRatio: 0.5 } },
  { key: 'sharp-eyes', name: 'Sharp Eyes', description: 'Dense streams at speed with a score target.', modifiers: { scoreTargetRatio: 0.55 }, params: { bpm: 130, beats: 72, density: 0.85, streamRatio: 0.35, chordRatio: 0.2 } },
];

export function challengeChart(key) {
  const c = CHALLENGES.find((x) => x.key === key) || CHALLENGES[0];
  const seed = hashString(`rhythm-steps:challenge:v${CONTENT_VERSION}:${key}`);
  const goals = {};
  if (c.modifiers.minAccuracy) goals.minAccuracy = c.modifiers.minAccuracy;
  const chart = generateChart({
    id: `challenge-${key}`, seed, ...c.params,
    goals, mechanics: ['tap', 'hold', 'chord', 'stream'], theme: 'umbra-hall',
  });
  chart.displayName = `Challenge — ${c.name}`;
  chart.challenge = { key: c.key, name: c.name, description: c.description, modifiers: c.modifiers };
  if (c.modifiers.scoreTargetRatio) chart.goals.scoreTarget = Math.round(chart.par * c.modifiers.scoreTargetRatio);
  return chart;
}

// ---------------------------------------------------------------------------
// Score chase: shareable seeded charts for asynchronous comparison.
// ---------------------------------------------------------------------------
export function scoreChaseChart(seed, difficultyKey = 'brisk') {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.key === difficultyKey) || PRACTICE_DIFFICULTIES[2];
  const chart = generateChart({
    id: `chase-${seed.toString(16)}-${difficultyKey}`, seed: seed >>> 0, ...d.params,
    mechanics: ['tap', 'hold', 'chord', 'stream'], theme: 'tideglass',
  });
  chart.displayName = `Score Chase — ${d.label}`;
  chart.ranked = true;
  return chart;
}

// ---------------------------------------------------------------------------
// Themes: five visual themes. Presentation only — never change rules.
// ---------------------------------------------------------------------------
export const THEMES = {
  'neon-causeway': {
    name: 'Neon Causeway',
    sky: 0x05070f, fog: 0x0a1024, fogDensity: 0.016,
    lane: 0x101a38, laneEdge: 0x35e0ff, receptor: 0x35e0ff,
    note: 0x59f2ff, hold: 0x8affc1, accent: 0xff5ea8, env: 0x1a2b5c,
    ambient: 'deep', keyLight: 0xbfd8ff,
  },
  'tideglass': {
    name: 'Tideglass',
    sky: 0x041014, fog: 0x07262c, fogDensity: 0.014,
    lane: 0x0a2e33, laneEdge: 0x46ffd9, receptor: 0x46ffd9,
    note: 0x7dffe9, hold: 0xd4ff7a, accent: 0xffb347, env: 0x0e3f46,
    ambient: 'water', keyLight: 0xcffff2,
  },
  'ember-line': {
    name: 'Ember Line',
    sky: 0x120705, fog: 0x261008, fogDensity: 0.015,
    lane: 0x2e1408, laneEdge: 0xffa03c, receptor: 0xffa03c,
    note: 0xffc46b, hold: 0xff7a59, accent: 0x7df9ff, env: 0x4a2410,
    ambient: 'fire', keyLight: 0xffe0b8,
  },
  'verdant-pulse': {
    name: 'Verdant Pulse',
    sky: 0x061006, fog: 0x0c240d, fogDensity: 0.017,
    lane: 0x123312, laneEdge: 0x8dff5e, receptor: 0x8dff5e,
    note: 0xb6ff8a, hold: 0x5ee8ff, accent: 0xffe45e, env: 0x1d4a1e,
    ambient: 'forest', keyLight: 0xe2ffd0,
  },
  'umbra-hall': {
    name: 'Umbra Hall',
    sky: 0x0b0614, fog: 0x180d2e, fogDensity: 0.015,
    lane: 0x241442, laneEdge: 0xc05eff, receptor: 0xc05eff,
    note: 0xd98cff, hold: 0x5effe0, accent: 0xffd25e, env: 0x352058,
    ambient: 'hall', keyLight: 0xe6d4ff,
  },
};

// Color-vision-safe palette override (accessibility): distinct hues + shapes.
export const CVD_PALETTE = {
  note: 0xf0e442, hold: 0x0072b2, accent: 0xe69f00, receptor: 0x56b4e9, laneEdge: 0x56b4e9,
};

// ---------------------------------------------------------------------------
// Learn mode lessons (interactive; each introduces one rule and requires the
// player to perform the action using the same legal-action API as play).
// ---------------------------------------------------------------------------
export const LESSONS = [
  {
    id: 'lesson-tap', title: 'Tap on the line',
    steps: [
      { text: 'Notes travel down the lanes toward the glowing line.', demo: true },
      { text: 'Press the lane key (D F J K) or tap the lane exactly when a note reaches the line.', require: { action: 'hit', count: 3 } },
      { text: 'Closer timing means a better grade: Perfect, Great, or Good.', require: { action: 'hit', count: 2 } },
    ],
    chartParams: { bpm: 80, beats: 24, density: 0.5 },
  },
  {
    id: 'lesson-hold', title: 'Hold the glow',
    steps: [
      { text: 'Long notes must be HELD. Press when the head reaches the line...', demo: true },
      { text: '...and keep holding until the tail ends, then release.', require: { action: 'hold-complete', count: 2 } },
      { text: 'Releasing too early breaks your combo. Hold two more.', require: { action: 'hold-complete', count: 2 } },
    ],
    chartParams: { bpm: 80, beats: 24, density: 0.45, holdRatio: 0.6 },
  },
  {
    id: 'lesson-combo', title: 'Keep the streak',
    steps: [
      { text: 'Consecutive hits build a combo. Combo adds bonus points.', demo: true },
      { text: 'A miss resets the combo to zero. Finish this phrase without missing.', require: { action: 'combo', count: 8 } },
    ],
    chartParams: { bpm: 88, beats: 32, density: 0.6, holdRatio: 0.15 },
  },
];

export function lessonChart(lessonId) {
  const l = LESSONS.find((x) => x.id === lessonId) || LESSONS[0];
  const chart = generateChart({
    id: lessonId, seed: hashString(`rhythm-steps:lesson:v${CONTENT_VERSION}:${lessonId}`),
    ...l.chartParams, mechanics: ['tap', 'hold'], theme: 'neon-causeway',
  });
  chart.displayName = l.title;
  return chart;
}

export function getTheme(key) {
  return THEMES[key] || THEMES['neon-causeway'];
}

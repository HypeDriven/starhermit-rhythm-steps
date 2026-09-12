// Persistence: versioned, checksummed local save document.
// Never stores credentials or tokens. Conflicts are resolved by the caller
// preserving both snapshots and asking the player (see platform.js cloud save).

import { hashString } from './rng.js';

export const SAVE_VERSION = 2;
const STORAGE_KEY = 'rhythm-steps:save';

export const DEFAULT_SETTINGS = {
  // audio buses (0..1)
  volMusic: 0.8, volEffects: 0.9, volAmbience: 0.5, volVoice: 0.8, muted: false,
  // graphics
  qualityTier: 'auto', // auto | high | medium | low
  reducedMotion: false,
  bloom: true,
  // accessibility
  highContrast: false, cvdPalette: false, largeText: false, leftHanded: false,
  holdMode: 'hold', // hold | toggle
  timingAssist: 'off', // off | wide (1.5x windows)
  haptics: true,
  captions: true,
  cameraSway: true,
  // controls (desktop bindings; touch stays responsive UI)
  keys: ['d', 'f', 'j', 'k'],
  pauseKey: 'escape',
  // gameplay prefs
  noteSpeed: 1.0, // scroll speed multiplier (0.6..1.6) — cosmetic, lead time constant
  themeOverride: null,
  tutorialDone: {},
};

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    updatedAt: 0, // last local write time (ms) — cloud conflict ordering
    profile: { displayName: 'Guest', avatarHue: 200, guest: true, accountLinked: false },
    settings: { ...DEFAULT_SETTINGS },
    journey: { unlocked: 1, stars: {}, bestScores: {} }, // stars: stageIndex -> 0..3
    daily: { lastPlayed: null, history: {} },             // date -> {score, grade}
    achievements: {},                                     // key -> unlock timestamp
    lessons: {},                                          // lessonId -> true
    mastery: { xp: 0, level: 1 },
    chaseBoards: {},                                      // chartId -> [{name, score, grade, sessionId}]
    stats: { sessionsPlayed: 0, totalScore: 0, bestCombo: 0, firstPlayDone: false },
    checksum: 0,
  };
}

function checksum(doc) {
  const clone = { ...doc, checksum: 0 };
  return hashString(JSON.stringify(clone));
}

function migrate(doc) {
  // v1 -> v2: added mastery track + chaseBoards (illustrative migration path).
  if (doc.version === 1) {
    doc.mastery = doc.mastery || { xp: 0, level: 1 };
    doc.chaseBoards = doc.chaseBoards || {};
    doc.settings = { ...DEFAULT_SETTINGS, ...(doc.settings || {}) };
    doc.version = 2;
  }
  return doc;
}

// Validate an arbitrary save document (object or JSON string): migrate, then
// require the current version and a matching checksum. Returns the ready doc
// or null. Shared by the localStorage loader and the cloud-save mirror.
export function parseSaveDoc(raw) {
  try {
    const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof doc !== 'object' || doc === null) return null;
    const migrated = migrate(doc);
    if (migrated.version !== SAVE_VERSION) return null;
    if (checksum(migrated) !== migrated.checksum) return null;
    migrated.settings = { ...DEFAULT_SETTINGS, ...migrated.settings };
    return migrated;
  } catch (e) {
    return null;
  }
}

export function loadSave(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return defaultSave();
    const doc = JSON.parse(raw);
    if (typeof doc !== 'object' || doc === null) return defaultSave();
    const migrated = migrate(doc);
    if (migrated.version !== SAVE_VERSION) return defaultSave();
    if (checksum(migrated) !== migrated.checksum) {
      console.warn('[save] checksum mismatch — resetting to a safe default');
      return defaultSave();
    }
    migrated.settings = { ...DEFAULT_SETTINGS, ...migrated.settings };
    return migrated;
  } catch (e) {
    console.warn('[save] load failed', e);
    return defaultSave();
  }
}

export function writeSave(doc, storage = globalThis.localStorage) {
  try {
    doc.updatedAt = Date.now();
    doc.checksum = checksum(doc);
    storage?.setItem(STORAGE_KEY, JSON.stringify(doc));
    return true;
  } catch (e) {
    console.warn('[save] write failed', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Achievements — small static set; stable lowercase keys; idempotent unlocks.
// ---------------------------------------------------------------------------
export const ACHIEVEMENTS = [
  { key: 'first-light', name: 'First Light', description: 'Complete your first track.' },
  { key: 'hold-mastery', name: 'Steady Hands', description: 'Complete 25 hold notes without an early release, lifetime.' },
  { key: 'streak-50', name: 'Unbroken Fifty', description: 'Reach a 50 combo in any track.' },
  { key: 'summit-clear', name: 'Summit of Light', description: 'Clear the final Journey mastery stage.' },
  { key: 'long-road', name: 'The Long Road', description: 'Play on 7 different days. Any mode, any assists.' },
];

export function unlockAchievement(save, key) {
  if (!ACHIEVEMENTS.some((a) => a.key === key)) return false;
  if (save.achievements[key]) return false; // idempotent
  save.achievements[key] = Date.now();
  return true;
}

// Mastery track XP: long-term, accessibility-neutral progression.
export function awardMasteryXp(save, xp) {
  save.mastery.xp += Math.max(0, xp | 0);
  const level = Math.floor(Math.sqrt(save.mastery.xp / 100)) + 1;
  const leveled = level > save.mastery.level;
  save.mastery.level = level;
  return leveled;
}

// Stars for a journey stage result (0-3): completion, accuracy, full combo.
export function starsForResult(breakdown) {
  if (breakdown.terminalReason !== 'complete') return 0;
  let stars = 1;
  if (breakdown.accuracy >= 0.9) stars++;
  if (breakdown.counts.miss === 0) stars++;
  return stars;
}

// Days-played tracking for the long-road achievement.
export function markPlayedToday(save, utcDateString) {
  save.stats.daysPlayed = save.stats.daysPlayed || {};
  save.stats.daysPlayed[utcDateString] = true;
  return Object.keys(save.stats.daysPlayed).length;
}

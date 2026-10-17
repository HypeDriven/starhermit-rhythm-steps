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
  qualityTier: 'auto', // legacy (pre-gfx) tier; migrated into `gfx` on load
  // graphics quality model (see gfx.js): { preset: 'auto'|low|balanced|high|ultra,
  // render_scale, adaptive, show_fps, <category>: tier } — never mutated in place
  gfx: { preset: 'auto' },
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
  // lane keys as KeyboardEvent.code (older saves held e.key letters; migrated on load)
  keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  pauseKey: 'Escape',
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
    const legacyGfx = !migrated.settings?.gfx;
    migrated.settings = { ...DEFAULT_SETTINGS, ...migrated.settings };
    if (legacyGfx) migrated.settings.gfx = { preset: { high: 'high', medium: 'balanced', low: 'low' }[migrated.settings.qualityTier] || 'auto' };
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
    const legacyGfx = !migrated.settings?.gfx;
    migrated.settings = { ...DEFAULT_SETTINGS, ...migrated.settings };
    if (legacyGfx) migrated.settings.gfx = { preset: { high: 'high', medium: 'balanced', low: 'low' }[migrated.settings.qualityTier] || 'auto' };
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

// Merge two save docs (this device and the cloud copy another device wrote)
// without losing progress on either side: the higher journey unlock, the
// better stars/best score per stage and per daily date, the union of lessons,
// achievements (earliest unlock), days played and seed-board entries, and the
// larger lifetime stats and mastery XP. Settings and profile stay `local`'s
// (the platform settings KV and account profile sync those).
export function mergeSaves(local, remote) {
  const a = local, b = remote;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = JSON.parse(JSON.stringify(a));
  const maxMap = (x = {}, y = {}) => { const o = { ...x }; for (const [k, v] of Object.entries(y)) o[k] = Math.max(num(o[k]), num(v)); return o; };
  out.updatedAt = Math.max(num(a.updatedAt), num(b.updatedAt));
  out.journey = {
    unlocked: Math.max(num(a.journey?.unlocked), num(b.journey?.unlocked), 1),
    stars: maxMap(a.journey?.stars, b.journey?.stars),
    bestScores: maxMap(a.journey?.bestScores, b.journey?.bestScores),
  };
  const history = { ...(a.daily?.history || {}) };
  for (const [d, r] of Object.entries(b.daily?.history || {})) if (!history[d] || num(r.score) > num(history[d].score)) history[d] = r;
  const last = [a.daily?.lastPlayed, b.daily?.lastPlayed].filter(Boolean).sort().pop() || null;
  out.daily = { ...(a.daily || {}), lastPlayed: last, history };
  out.achievements = { ...(b.achievements || {}) };
  for (const [k, v] of Object.entries(a.achievements || {})) out.achievements[k] = out.achievements[k] ? Math.min(num(out.achievements[k]) || num(v), num(v) || num(out.achievements[k])) : v;
  out.lessons = { ...(b.lessons || {}), ...(a.lessons || {}) };
  const xp = Math.max(num(a.mastery?.xp), num(b.mastery?.xp));
  out.mastery = { xp, level: Math.floor(Math.sqrt(xp / 100)) + 1 };
  const boards = { ...(a.chaseBoards || {}) };
  for (const [seed, list] of Object.entries(b.chaseBoards || {})) {
    const seen = new Set((boards[seed] || []).map((e) => e.sessionId));
    boards[seed] = [...(boards[seed] || []), ...list.filter((e) => !seen.has(e.sessionId))]
      .sort((x, y) => num(y.total ?? y.score) - num(x.total ?? x.score)).slice(0, 20);
  }
  out.chaseBoards = boards;
  const sa = a.stats || {}, sb = b.stats || {};
  out.stats = {
    ...sb, ...sa,
    sessionsPlayed: Math.max(num(sa.sessionsPlayed), num(sb.sessionsPlayed)),
    totalScore: Math.max(num(sa.totalScore), num(sb.totalScore)),
    bestCombo: Math.max(num(sa.bestCombo), num(sb.bestCombo)),
    firstPlayDone: !!(sa.firstPlayDone || sb.firstPlayDone),
    holdsCompleted: Math.max(num(sa.holdsCompleted), num(sb.holdsCompleted)),
    earlyReleases: Math.max(num(sa.earlyReleases), num(sb.earlyReleases)),
    daysPlayed: { ...(sb.daysPlayed || {}), ...(sa.daysPlayed || {}) },
  };
  return out;
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

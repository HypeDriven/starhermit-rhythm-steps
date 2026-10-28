// The progress this client stores as the engine save, and what it reads from
// the browser build: pure, shared by native/platform.ts and the node tests.
// - The engine save is the browser build's save document (js/persistence.js)
//   without its settings, update time and checksum: the guest profile
//   (name, avatar hue), Journey unlocks, stars and best scores, the Daily
//   history, achievements, finished lessons, mastery XP, the Score Chase seed
//   boards and the lifetime stats. Two copies merge as the browser build's
//   cloud conflicts did (persistence.js mergeSaves).
// - The browser build mirrored its whole save document (settings included)
//   to the cloud slot game:<slug> as JSON (StarHermit.saveJSON). The engine
//   shows that slot as foreign: readForeign() turns it into progress plus the
//   options this game still owns.
// - Of the old settings, the gameplay and accessibility options the runtime
//   has no equivalent for stay the game's (engine settings, OPTION_KEYS);
//   volumes, mute, graphics, reduced motion, high contrast, larger text,
//   language and key bindings are the runtime's Options. isLegacyKey() names
//   every per-player settings key the browser build wrote, to remove once
//   read.

import { defaultSave, mergeSaves, parseSaveDoc, DEFAULT_SETTINGS } from './persistence.js';

/** The game's own options and their defaults (engine settings, same keys as the old save's settings). */
export const OPTION_DEFAULTS = {
  leftHanded: false,
  holdMode: 'hold',
  timingAssist: 'off',
  cvdPalette: false,
  captions: true,
  haptics: true,
  cameraSway: true,
  noteSpeed: 1,
};
export const OPTION_KEYS = Object.keys(OPTION_DEFAULTS);

const PROGRESS_KEYS = ['version', 'profile', 'journey', 'daily', 'achievements', 'lessons', 'mastery', 'chaseBoards', 'stats'];

function plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** A new player's progress. */
export function blank() { return normalize(null); }

/** Any stored or old document → progress (unknown or broken parts → defaults). */
export function normalize(raw) {
  const base = defaultSave();
  const src = plain(raw) || {};
  const out = {};
  for (const k of PROGRESS_KEYS) {
    const d = base[k];
    const v = src[k];
    if (k === 'version') out.version = base.version;
    else if (plain(d) && plain(v)) out[k] = { ...clone(d), ...clone(v) };
    else out[k] = clone(d);
  }
  const j = out.journey;
  j.unlocked = Math.min(40, Math.max(1, Math.floor(Number(j.unlocked) || 1)));
  if (!plain(j.stars)) j.stars = {};
  if (!plain(j.bestScores)) j.bestScores = {};
  if (!plain(out.daily.history)) out.daily.history = {};
  const xp = Math.max(0, Math.floor(Number(out.mastery.xp) || 0));
  out.mastery = { xp, level: Math.floor(Math.sqrt(xp / 100)) + 1 };
  return out;
}

/** Two copies merged without losing either side's progress (the old cloud-conflict merge). */
export function merge(a, b) {
  const x = normalize(a), y = normalize(b);
  const m = mergeSaves({ ...x, settings: {} }, { ...y, settings: {} });
  return normalize(m);
}

function sorted(v) {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sorted);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = sorted(v[k]);
  return out;
}
/** Whether two copies hold the same progress. */
export function same(a, b) {
  return JSON.stringify(sorted(normalize(a))) === JSON.stringify(sorted(normalize(b)));
}

/** Only well-typed option values. */
export function pickOptions(raw) {
  const out = {};
  if (!plain(raw)) return out;
  for (const k of OPTION_KEYS) {
    const v = raw[k];
    if (typeof OPTION_DEFAULTS[k] === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (k === 'holdMode' && (v === 'hold' || v === 'toggle')) out[k] = v;
    else if (k === 'timingAssist' && (v === 'off' || v === 'wide')) out[k] = v;
    else if (k === 'noteSpeed' && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(1.6, Math.max(0.6, Math.round(v * 10) / 10));
  }
  return out;
}

/** The browser build's cloud slot (JSON text of its save document) → { progress, options }, or null. */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!plain(obj)) return null;
  // A checksummed v1/v2 document migrates as the old loader did; an
  // unchecked one (edited by hand, an older SDK) is still read for progress.
  const doc = parseSaveDoc(clone(obj)) || obj;
  if (!plain(doc.journey) && !plain(doc.stats)) return null;
  return { progress: normalize(doc), options: pickOptions(doc.settings) };
}

/** Every per-player settings key the browser build wrote (its settings mirror, sh-language.js, game-options.js). */
export function isLegacyKey(key) {
  if (key === 'keys' || key === 'pauseKey' || key === 'qualityTier') return false;
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) || key === 'telemetryConsent' ||
    key === 'ui.language' || key === 'audio.options' || key.startsWith('graphics.gpu.');
}

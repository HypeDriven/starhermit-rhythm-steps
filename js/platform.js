// Platform: StarHermit host adapter over the canonical SDK (starhermit-sdk.js,
// loaded as a classic script before the modules; globalThis.StarHermit).
// Every method degrades gracefully to local-only behavior standalone, where
// no network call is made.
//
// The SDK reads the launch token from the fragment (#game_token=<jwt> or the
// sign-in return #access_token=<jwt>), strips it, keeps it in memory only and
// renews it. The slug comes from the game_scope claim (never hard-coded).
// Hosted mode uses: profile nickname + avatar, the cloud-save slot
// (game:<slug>), the per-player settings KV, controls (keyboard bindings),
// read-only leaderboards and the invite share link. There is no per-game
// time/presence/telemetry/score-submit route for launch tokens; personal
// bests stay in the cloud-saved document.

const SH = () => globalThis.StarHermit || null;

const state = {
  timeOffsetMs: 0,
  timeSynced: false,
  profileName: null,
  consentTelemetry: false,
};
let syncHandler = null;
let lifecycleBound = false;

// ---------------------------------------------------------------------------
// Launch context
// ---------------------------------------------------------------------------
export function detectHost() {
  const sh = SH();
  if (!sh) return false;
  sh.init(); // reads + strips the launch fragment; idempotent
  if (!lifecycleBound) {
    lifecycleBound = true;
    sh.on('saved', (ok) => reportSync(ok ? 'synced' : 'error'));
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => flushCloud());
      document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloud(); });
    }
  }
  return isHosted();
}
export function isHosted() { const sh = SH(); return !!(sh && sh.signedIn); }
export function gameScope() { const sh = SH(); return sh ? sh.slug : null; }
export function profileName() { return state.profileName; }
export function canSignIn() { const sh = SH(); return !!(sh && sh.canSignIn()); }
export function signIn() { const sh = SH(); return !!(sh && sh.signIn()); }
export function inviteLink() { return isHosted() ? SH().inviteLink() : null; }
/** fn({ signedIn }) when the session signs in/out (renewal refused). */
export function onAuth(fn) { const sh = SH(); return sh ? sh.on('auth', fn) : () => {}; }

// Daily boundaries use the device's UTC clock: the platform has no per-game
// time route reachable by launch tokens.
export async function syncTime() {
  state.timeSynced = false;
  return nowUtcDateString();
}
export function serverNow() { return Date.now() + state.timeOffsetMs; }
export function nowUtcDateString() {
  return new Date(serverNow()).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Identity: profile nickname (SDK; "Player <id>" fallback), avatar.
// ---------------------------------------------------------------------------
export async function nicknameFor(userId) {
  const sh = SH();
  const id = String(userId);
  const p = sh ? await sh.profile(id).catch(() => null) : null;
  return (p ? p.displayName : `Player ${id.slice(0, 8)}`).slice(0, 24);
}
// Load the signed-in player's display name; null when standalone.
export async function loadProfile() {
  if (!isHosted()) return null;
  state.profileName = await nicknameFor(SH().userId);
  return state.profileName;
}
/** Object URL of the signed-in player's avatar, or null. */
export async function avatarUrl() {
  return isHosted() ? SH().avatarUrl().catch(() => null) : null;
}

// ---------------------------------------------------------------------------
// Cloud save: the SDK slot (game:<slug>), remote-preferred on load, debounced
// pushes with a pagehide flush. localStorage stays the offline cache.
// ---------------------------------------------------------------------------
export function setSyncStatusHandler(fn) { syncHandler = fn; }
function reportSync(status) {
  if (!isHosted()) return;
  try { syncHandler?.(status); } catch { /* UI optional */ }
}
// Load the remote mirror. Resolves {ok, doc?, none?}.
export async function cloudLoad() {
  if (!isHosted()) return { ok: false, error: 'not-hosted' };
  reportSync('connecting');
  const doc = await SH().loadJSON();
  reportSync('synced');
  return doc ? { ok: true, doc } : { ok: true, none: true };
}
// Debounced mirror of the local save doc. Call after every persisted write.
export function scheduleCloudPush(doc) {
  if (!isHosted()) return;
  reportSync('saving');
  SH().saveJSON(doc, 2000);
}
// Immediate best-effort flush (pagehide / beforeunload / tab hidden).
export function flushCloud() {
  if (isHosted()) SH().flushSave(true);
}

// ---------------------------------------------------------------------------
// Settings KV: player preferences (not progress, not key bindings).
// ---------------------------------------------------------------------------
const NOT_SETTINGS = new Set(['keys', 'pauseKey', 'qualityTier']);
let sentSettings = {};
let settingsTimer = null;
function prefKeys(defaults) { return Object.keys(defaults).filter((k) => !NOT_SETTINGS.has(k)); }
/** Apply platform settings over `settings` (platform wins). Resolves true if changed. */
export async function loadSettings(settings, defaults) {
  if (!isHosted()) return false;
  const remote = await SH().getSettings().catch(() => ({}));
  let changed = false;
  for (const k of prefKeys(defaults)) {
    if (remote && remote[k] !== undefined && remote[k] !== null) { settings[k] = remote[k]; changed = true; }
  }
  sentSettings = JSON.parse(JSON.stringify(Object.fromEntries(prefKeys(defaults).map((k) => [k, settings[k]]))));
  return changed;
}
/** Patch changed preferences to the platform (debounced). */
export function mirrorSettings(settings, defaults) {
  if (!isHosted()) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const diff = {};
    for (const k of prefKeys(defaults)) {
      if (JSON.stringify(settings[k]) !== JSON.stringify(sentSettings[k])) diff[k] = settings[k] === undefined ? null : settings[k];
    }
    if (!Object.keys(diff).length) return;
    Object.assign(sentSettings, JSON.parse(JSON.stringify(diff)));
    SH().patchSettings(diff);
  }, 600);
}

// ---------------------------------------------------------------------------
// Controls: lane1..lane4 + pause (KeyboardEvent.code), mirrored in
// starhermit.txt. Local rebinds persist in the save; signed in, the platform
// copy wins and rebinds are written with setControl / resetControls.
// ---------------------------------------------------------------------------
export const LANE_ACTIONS = ['lane1', 'lane2', 'lane3', 'lane4'];
export const DEFAULT_BINDINGS = { lane1: ['KeyD'], lane2: ['KeyF'], lane3: ['KeyJ'], lane4: ['KeyK'], pause: ['Escape'] };
let bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));

/** Convert a legacy e.key binding ('d', ';') to a KeyboardEvent.code. */
export function keyToCode(k) {
  if (typeof k !== 'string' || !k) return null;
  if (/^[A-Z]/.test(k) && k.length > 1) return k; // already a code
  if (/^[a-z]$/.test(k)) return 'Key' + k.toUpperCase();
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  const map = { ' ': 'Space', ';': 'Semicolon', ',': 'Comma', '.': 'Period', '/': 'Slash', "'": 'Quote',
    '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '\\': 'Backslash', '`': 'Backquote',
    escape: 'Escape', enter: 'Enter', tab: 'Tab', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown' };
  return map[k] || null;
}
/** Short label for a KeyboardEvent.code. */
export function keyLabel(code) {
  const named = { Escape: 'Esc', Space: 'Space', Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backslash: '\\', Backquote: '`',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
  if (named[code]) return named[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  return code || '?';
}
/** Resolve bindings: local lane codes as defaults, platform overrides when signed in. */
export async function loadBindings(laneCodes) {
  const defaults = { ...JSON.parse(JSON.stringify(DEFAULT_BINDINGS)) };
  (laneCodes || []).forEach((c, i) => { if (c && LANE_ACTIONS[i]) defaults[LANE_ACTIONS[i]] = [c]; });
  const sh = SH();
  bindings = sh ? await sh.loadBindings(defaults).catch(() => defaults) : defaults;
  return bindings;
}
export function getBindings() { return bindings; }
export function setLocalBindings(laneCodes) {
  laneCodes.forEach((c, i) => { bindings[LANE_ACTIONS[i]] = [c]; });
}
export function actionFor(code) {
  for (const [a, codes] of Object.entries(bindings)) if (codes.includes(code)) return a;
  return null;
}
/** Persist lane bindings to the platform (signed in only). */
export function saveLaneBindings(laneCodes) {
  if (!isHosted()) return;
  const b = {};
  laneCodes.forEach((c, i) => { b[LANE_ACTIONS[i]] = [c]; });
  SH().setControls(b).catch(() => {});
}
export function resetControls() {
  if (isHosted()) SH().resetControls();
}

// ---------------------------------------------------------------------------
// Leaderboards: read-only. Clients can never submit scores; personal bests
// live in the save doc. Entries resolve userIds to nicknames.
// ---------------------------------------------------------------------------
export async function fetchGameInfo() {
  if (!isHosted()) return { ok: false, error: 'not-hosted' };
  const sh = SH();
  const data = await sh.getGame();
  if (data && !data.leaderboardId) {
    const boards = await sh.leaderboards();
    if (boards && boards[0]) data.leaderboardId = boards[0].id;
  }
  return data ? { ok: true, data } : { ok: false, error: 'unavailable' };
}
export async function fetchLeaderboard(boardId, { friendsOnly = false, page = 1, pageSize = 10 } = {}) {
  if (!isHosted()) return { ok: false, error: 'not-hosted' };
  const r = await SH().leaderboardEntries(boardId, { page, pageSize, scope: friendsOnly ? 'friends' : undefined });
  const raw = Array.isArray(r.items) ? r.items : (Array.isArray(r.entries) ? r.entries : []);
  const entries = [];
  for (const e of raw.slice(0, pageSize)) {
    const uid = e.userId ?? e.user_id ?? null;
    const name = uid != null ? await nicknameFor(String(uid)) : (typeof e.nickname === 'string' ? e.nickname : 'Player');
    entries.push({ name, score: Number(e.score ?? e.total ?? e.value ?? 0), rank: e.rank });
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// Telemetry: consent is recorded in the save doc, but the platform exposes no
// per-game telemetry endpoint reachable by launch tokens — events stay local.
// ---------------------------------------------------------------------------
export function telemetry(eventName, props = {}) {
  if (!state.consentTelemetry) return;
  const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
  if (!allowed.includes(eventName)) return;
  // Local-only funnel: no network endpoint exists for hosted games.
}

export function setTelemetryConsent(v) { state.consentTelemetry = !!v; }
export function timeSynced() { return state.timeSynced; }

// Platform: StarHermit host adapter. Same-origin /api routes when hosted;
// every method degrades gracefully to local-only behavior standalone.
//
// Launch token: read once from the URL fragment (#game_token=<jwt>), stripped
// via history.replaceState, held in memory only, refreshed before expiry.
// Query-param fallbacks exist for local dev only — never on the platform
// host. The JWT payload (base64url decode, no verify) provides sub and
// game_scope; the slug is never hard-coded.
//
// Hosted mode calls ONLY documented platform routes: profile lookup, cloud
// saves (one zip+base64 slot), read-only leaderboards, time sync, and
// launch-token refresh. The wiki has no per-game presence/activity/
// telemetry/score-submit endpoints reachable by launch tokens, so those are
// local no-ops here; leaderboards are platform-owned and personal bests stay
// in the cloud-saved document.

const API = '/api/v1';
const CLOUD_DEBOUNCE_MS = 2000;
const TOKEN_REFRESH_MS = 45 * 60 * 1000;
const TOKEN_REFRESH_RETRY_MS = 60000;

const state = {
  hosted: false,
  launchToken: null,
  sub: null,
  scope: null,
  timeOffsetMs: 0, // server time minus local time (round-trip adjusted)
  timeSynced: false,
  profileName: null,
  refreshTimer: null,
  consentTelemetry: false,
};

let syncHandler = null;
let pushTimer = null;
let pendingPush = null;
let lifecycleBound = false;

// ---------------------------------------------------------------------------
// Minimal ZIP writer/reader (stored entries only, no compression).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// ---------------------------------------------------------------------------
// Launch context
// ---------------------------------------------------------------------------
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(json);
  } catch { return null; }
}

export function detectHost() {
  try {
    const url = new URL(window.location.href);
    const platformHost = /(^|\.)starhermit\.com$/i.test(url.hostname);
    let token = null;
    let scope = null;
    if (window.location.hash) {
      const frag = new URLSearchParams(window.location.hash.slice(1));
      token = frag.get('game_token');
      if (token && window.history?.replaceState) {
        frag.delete('game_token');
        frag.delete('session_id');
        const rest = frag.toString();
        window.history.replaceState(null, '', url.pathname + url.search + (rest ? `#${rest}` : ''));
      }
    }
    if (!token && !platformHost) {
      // Query fallbacks are for the local dev server only — on the platform
      // host the token only ever arrives in the fragment.
      token = url.searchParams.get('game_token') || url.searchParams.get('launch_token') ||
        url.searchParams.get('token') || url.searchParams.get('launch');
      scope = url.searchParams.get('scope');
      if (token && window.history?.replaceState) {
        for (const k of ['game_token', 'launch_token', 'token', 'launch', 'scope']) url.searchParams.delete(k);
        window.history.replaceState(null, '', url.toString());
      }
    }
    if (token) {
      state.hosted = true;
      state.launchToken = token; // memory only — never written to storage
      const claims = decodeJwtPayload(token);
      state.sub = claims && claims.sub ? String(claims.sub) : null;
      state.scope = (claims && claims.game_scope ? String(claims.game_scope) : null) || scope;
      scheduleTokenRefresh();
      bindLifecycle();
    }
  } catch { /* standalone */ }
  return state.hosted;
}

export function isHosted() { return state.hosted; }
export function gameScope() { return state.scope; }
export function profileName() { return state.profileName; }

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (state.launchToken) headers.authorization = `Bearer ${state.launchToken}`;
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...options, headers });
  } catch (e) {
    return { ok: false, error: 'network-unavailable', offline: true };
  }
  if (res.status === 429) return { ok: false, error: 'rate-limited', retryable: true };
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  if (!res.ok) return { ok: false, error: body?.error || `http-${res.status}`, retryable: res.status >= 500 };
  return { ok: true, data: body };
}

// Token lifetime is 60 min: re-mint scoped tokens every 45 min; on failure
// retry after ~60 s with the current token still in place.
function scheduleTokenRefresh(delayMs = TOKEN_REFRESH_MS) {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(refreshToken, delayMs);
}

async function refreshToken() {
  if (!state.hosted || !state.launchToken || !state.scope) return;
  let ok = false;
  try {
    const r = await api(`/games/${encodeURIComponent(state.scope)}/launch-token`, { method: 'POST', body: '{}' });
    const token = r.ok && r.data && typeof r.data.token === 'string' ? r.data.token : null;
    if (token) {
      state.launchToken = token;
      const claims = decodeJwtPayload(token);
      if (claims && claims.sub) state.sub = String(claims.sub);
      ok = true;
    }
  } catch { /* keep the current token; retry shortly */ }
  scheduleTokenRefresh(ok ? TOKEN_REFRESH_MS : TOKEN_REFRESH_RETRY_MS);
}

// Flush pending cloud saves when the page hides or unloads.
function bindLifecycle() {
  if (lifecycleBound) return;
  lifecycleBound = true;
  window.addEventListener('pagehide', () => flushCloud());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloud(); });
}

// Synchronize with platform time using round-trip-adjusted offset.
export async function syncTime() {
  if (!state.hosted) { state.timeSynced = false; return nowUtcDateString(); }
  const t0 = Date.now();
  const r = await api('/time');
  const t1 = Date.now();
  const serverMs = r.ok && typeof r.data?.now === 'number' ? r.data.now
    : r.ok && typeof r.data?.time === 'number' ? r.data.time
    : r.ok && typeof r.data?.ms === 'number' ? r.data.ms : null;
  if (serverMs !== null) {
    const rtt = t1 - t0;
    state.timeOffsetMs = (serverMs + rtt / 2) - t1;
    state.timeSynced = true;
  }
  return nowUtcDateString();
}

export function serverNow() { return Date.now() + state.timeOffsetMs; }

export function nowUtcDateString() {
  return new Date(serverNow()).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Identity: account nickname via the profile route. NEVER /api/v1/me (403 for
// launch tokens), never usernames. Fallback: "Player " + id.slice(0, 8).
// ---------------------------------------------------------------------------
const nickCache = new Map();

export async function nicknameFor(userId) {
  const id = String(userId);
  if (nickCache.has(id)) return nickCache.get(id);
  let name = `Player ${id.slice(0, 8)}`;
  const r = await api(`/users/${encodeURIComponent(id)}/profile`);
  if (r.ok && typeof r.data?.nickname === 'string' && r.data.nickname.trim()) {
    name = r.data.nickname.trim().slice(0, 24);
  }
  nickCache.set(id, name);
  return name;
}

// Load the signed-in player's display name; null when standalone.
export async function loadProfile() {
  if (!state.hosted || !state.sub) return null;
  state.profileName = await nicknameFor(state.sub);
  return state.profileName;
}

// ---------------------------------------------------------------------------
// Cloud save: ONE slot per game, zip+base64, remote-preferred on load,
// debounced pushes with a pagehide flush. localStorage stays the offline
// cache; the cloud slot is a mirror.
// ---------------------------------------------------------------------------
export function setSyncStatusHandler(fn) { syncHandler = fn; }

function reportSync(status) {
  if (!state.hosted) return;
  try { syncHandler?.(status); } catch { /* UI optional */ }
}

function cloudSlot() {
  return state.hosted && state.scope ? `${API}/me/cloud-saves/${encodeURIComponent(state.scope)}` : null;
}

// Load the remote mirror. 404 = no save yet. Resolves {ok, doc?, none?}.
export async function cloudLoad() {
  const slot = cloudSlot();
  if (!slot) return { ok: false, error: 'not-hosted' };
  reportSync('connecting');
  let res;
  try {
    res = await fetch(slot, { headers: { authorization: `Bearer ${state.launchToken}` } });
  } catch (e) {
    reportSync('offline');
    return { ok: false, error: 'network-unavailable', offline: true };
  }
  if (res.status === 404) { reportSync('synced'); return { ok: true, none: true }; }
  if (!res.ok) { reportSync('error'); return { ok: false, error: `http-${res.status}` }; }
  try {
    const bytes = new Uint8Array(await res.arrayBuffer());
    const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
    reportSync('synced');
    return { ok: true, doc };
  } catch (e) {
    reportSync('error');
    return { ok: false, error: 'bad-save' };
  }
}

async function pushDoc(doc, { keepalive = false } = {}) {
  const slot = cloudSlot();
  if (!slot) return { ok: false, error: 'not-hosted' };
  reportSync('saving');
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  let res;
  try {
    res = await fetch(slot, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.launchToken}` },
      body: JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', bytes)) }),
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch (e) {
    reportSync('offline');
    return { ok: false, error: 'network-unavailable', offline: true };
  }
  if (!res.ok) { reportSync('error'); return { ok: false, error: `http-${res.status}` }; }
  reportSync('synced');
  return { ok: true };
}

// Debounced mirror of the local save doc. Call after every persisted write.
export function scheduleCloudPush(doc) {
  if (!cloudSlot()) return;
  pendingPush = doc;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const d = pendingPush;
    pendingPush = null;
    if (d) pushDoc(d);
  }, CLOUD_DEBOUNCE_MS);
}

// Immediate best-effort flush (pagehide / beforeunload / tab hidden).
export function flushCloud() {
  if (!cloudSlot()) return;
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  const d = pendingPush;
  pendingPush = null;
  if (d) pushDoc(d, { keepalive: true });
}

// ---------------------------------------------------------------------------
// Leaderboards: read-only. Clients can never submit scores; personal bests
// live in the save doc. Entries resolve userIds to nicknames.
// ---------------------------------------------------------------------------
export async function fetchGameInfo() {
  if (!state.hosted || !state.scope) return { ok: false, error: 'not-hosted' };
  return api(`/games/${encodeURIComponent(state.scope)}`);
}

export async function fetchLeaderboard(boardId, { friendsOnly = false, page = 1, pageSize = 10 } = {}) {
  if (!state.hosted) return { ok: false, error: 'not-hosted' };
  const q = new URLSearchParams({ friendsOnly: friendsOnly ? '1' : '', page: String(page), pageSize: String(pageSize) });
  const r = await api(`/leaderboards/${encodeURIComponent(boardId)}/entries?${q}`);
  if (!r.ok) return r;
  const raw = Array.isArray(r.data?.entries) ? r.data.entries : (Array.isArray(r.data) ? r.data : []);
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

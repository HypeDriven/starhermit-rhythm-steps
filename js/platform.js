// Platform: StarHermit host adapter. Same-origin /api and /ws routes when
// hosted; every method degrades gracefully to local-only behavior standalone.
// Launch/account tokens are read from the short-lived launch context and are
// NEVER persisted to local storage.

const state = {
  hosted: false,
  launchToken: null,
  scope: null,
  timeOffsetMs: 0, // server time minus local time (round-trip adjusted)
  timeSynced: false,
  activityStarted: false,
  heartbeatTimer: null,
  consentTelemetry: false,
};

export function detectHost() {
  try {
    const params = new URLSearchParams(location.search);
    const token = params.get('launch_token') || params.get('token');
    if (token) {
      state.hosted = true;
      state.launchToken = token; // memory only — never written to storage
      state.scope = params.get('scope') || null;
    }
  } catch { /* standalone */ }
  return state.hosted;
}

export function isHosted() { return state.hosted; }
export function gameScope() { return state.scope; }

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (state.launchToken) headers.authorization = `Bearer ${state.launchToken}`;
  let res;
  try {
    res = await fetch(`/api${path}`, { ...options, headers });
  } catch (e) {
    return { ok: false, error: 'network-unavailable', offline: true };
  }
  if (res.status === 429) return { ok: false, error: 'rate-limited', retryable: true };
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  if (!res.ok) return { ok: false, error: body?.error || `http-${res.status}`, retryable: res.status >= 500 };
  return { ok: true, data: body };
}

// Synchronize with platform time using round-trip-adjusted offset.
export async function syncTime() {
  if (!state.hosted) { state.timeSynced = false; return nowUtcDateString(); }
  const t0 = Date.now();
  const r = await api('/v1/time');
  const t1 = Date.now();
  if (r.ok && typeof r.data?.now === 'number') {
    const rtt = t1 - t0;
    state.timeOffsetMs = (r.data.now + rtt / 2) - t1;
    state.timeSynced = true;
  }
  return nowUtcDateString();
}

export function serverNow() { return Date.now() + state.timeOffsetMs; }

export function nowUtcDateString() {
  return new Date(serverNow()).toISOString().slice(0, 10);
}

// Activity lifecycle — accurate playtime for the host.
export async function startActivity() {
  if (!state.hosted || state.activityStarted) return;
  const r = await api('/v1/activity/start', { method: 'POST', body: JSON.stringify({ scope: state.scope }) });
  if (r.ok) state.activityStarted = true;
}

export async function endActivity() {
  if (!state.hosted || !state.activityStarted) return;
  await api('/v1/activity/end', { method: 'POST', body: '{}' });
  state.activityStarted = false;
}

// Throttled presence heartbeats while actively playing.
export function startHeartbeat() {
  if (!state.hosted || state.heartbeatTimer) return;
  state.heartbeatTimer = setInterval(() => { api('/v1/presence/heartbeat', { method: 'POST', body: '{}' }); }, 45000);
}

export function stopHeartbeat() {
  if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
}

// Durable achievement delivery (idempotent server-side).
export async function deliverAchievement(key) {
  if (!state.hosted) return { ok: false, error: 'not-hosted' };
  return api('/v1/achievements/unlock', { method: 'POST', body: JSON.stringify({ key }) });
}

// Ranked submission (daily / score chase). Includes ruleset, content version,
// seed, assists, and duration with every submission.
export async function submitScore(envelope) {
  if (!state.hosted) return { ok: false, error: 'not-hosted' };
  return api('/v1/scores/submit', { method: 'POST', body: JSON.stringify({ envelope }) });
}

export async function fetchLeaderboard(boardId, { friendsOnly = false } = {}) {
  if (!state.hosted) return { ok: false, error: 'not-hosted' };
  return api(`/v1/leaderboards/${encodeURIComponent(boardId)}?friends=${friendsOnly ? 1 : 0}`);
}

// Cloud save: versioned, checksummed document. Conflict handling preserves
// both snapshots; the caller asks the player when neither descends from the other.
export async function cloudPush(saveDoc) {
  if (!state.hosted) return { ok: false, error: 'not-hosted' };
  return api('/v1/save/push', { method: 'POST', body: JSON.stringify({ doc: saveDoc }) });
}

export async function cloudPull() {
  if (!state.hosted) return { ok: false, error: 'not-hosted' };
  return api('/v1/save/pull');
}

// Anonymous funnel telemetry: start, tutorial step, round end, retry,
// settings change, error category. No raw text, no personal data.
export function telemetry(eventName, props = {}) {
  if (!state.consentTelemetry) return;
  const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
  if (!allowed.includes(eventName)) return;
  const safe = {};
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
  }
  if (state.hosted) api('/v1/telemetry', { method: 'POST', body: JSON.stringify({ event: eventName, props: safe }) });
}

export function setTelemetryConsent(v) { state.consentTelemetry = !!v; }
export function timeSynced() { return state.timeSynced; }

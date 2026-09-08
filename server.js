// Rhythm Steps — authoritative Game Script (StarHermit server module).
// Used only for: seeded daily sessions, replay/score validation, and durable
// achievement delivery. Ordinary practice runs locally and offline.
//
// The host sandbox loads this module and routes:
//   handleMessage(ctx, msg)  — RPC-style entry point
// msg: { kind: 'validate-score' | 'daily-info' | 'unlock-achievement', ... }
//
// Determinism contract: validation re-runs the exact client rules engine and
// content generator against the submitted replay envelope. A score is
// accepted only when the replayed terminal hash matches the claimed hash.

import { replayEnvelope, RULES_VERSION } from './js/rules.js';
import { dailyChart, dailyInfo, scoreChaseChart, CONTENT_VERSION } from './js/content.js';

const MAX_COMMANDS = 20000;
const MAX_PAYLOAD_BYTES = 512 * 1024;

// Rate limit: 5 submissions per minute per identity (in-memory bucket).
const buckets = new Map();
function rateLimited(identity) {
  const now = Date.now();
  const b = buckets.get(identity) || { count: 0, reset: now + 60000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 60000; }
  b.count++;
  buckets.set(identity, b);
  return b.count > 5;
}

// A daily result is only ranked for the day it belongs to. The previous UTC
// day stays acceptable so a run started just before midnight (or delayed in
// flight) still validates; anything older is a replay of a favourable past day.
const DAILY_GRACE_DAYS = 1;
function dailyDateAcceptable(dateString, nowMs) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const chartDay = Date.parse(`${dateString}T00:00:00Z`);
  if (!Number.isFinite(chartDay)) return false;
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const ageDays = Math.round((today - chartDay) / 86400000);
  return ageDays >= 0 && ageDays <= DAILY_GRACE_DAYS;
}

function chartForEnvelope(env, nowMs) {
  if (env.chartId?.startsWith('daily-')) {
    const date = env.chartId.slice('daily-'.length);
    if (!dailyDateAcceptable(date, nowMs)) return null;
    return dailyChart(date);
  }
  if (env.chartId?.startsWith('chase-')) {
    // chase-<seedHex>-<difficulty>
    const parts = env.chartId.split('-');
    return scoreChaseChart(parseInt(parts[1], 16), parts[2]);
  }
  return null;
}

export function handleMessage(ctx, msg) {
  try {
    if (!msg || typeof msg !== 'object') return { error: 'malformed-message' };
    const payloadSize = JSON.stringify(msg).length;
    if (payloadSize > MAX_PAYLOAD_BYTES) return { error: 'payload-too-large' };

    switch (msg.kind) {
      case 'daily-info': {
        const date = typeof msg.date === 'string' ? msg.date : new Date(ctx.now()).toISOString().slice(0, 10);
        return { ok: true, info: dailyInfo(date) };
      }

      case 'validate-score': {
        if (rateLimited(ctx.identity)) return { error: 'rate-limited' };
        const env = msg.envelope;
        if (!env || typeof env !== 'object') return { error: 'missing-envelope' };
        if (env.rulesVersion !== RULES_VERSION) return { error: 'stale-version' };
        if (env.contentVersion !== CONTENT_VERSION) return { error: 'stale-content-version' };
        if (!Array.isArray(env.commands) || env.commands.length > MAX_COMMANDS) return { error: 'bad-command-log' };
        if (!env.terminal || typeof env.terminal.hash !== 'string') return { error: 'incomplete-envelope' };
        // The timing-assist setting is authoritative only if it is applied to
        // the client-side log either before or during replay. Because the
        // assist rewrites the tick that is then logged (replay stays exact),
        // the server cannot distinguish an assisted run from a perfect one, so
        // ranked submissions must not carry the widen-window assist at all.
        if (env.assists?.timingAssist === 'wide') return { error: 'assist-not-permitted', rejected: true };

        const chart = chartForEnvelope(env, typeof ctx?.now === 'function' ? ctx.now() : Date.now());
        if (!chart) return { error: 'unknown-chart' };
        // The rebuilt chart must be exactly the one the envelope names, so a
        // submission cannot claim a different difficulty than the one played.
        if (chart.id !== env.chartId) return { error: 'unknown-chart' };
        if (chart.seed !== env.seed) return { error: 'seed-mismatch' };

        // Command sanity: bounds, ordering, types.
        let lastTick = -1;
        for (const c of env.commands) {
          if (!c || typeof c !== 'object') return { error: 'malformed-command' };
          if (typeof c.tick !== 'number' || c.tick < 0 || c.tick > chart.durationMs + 5000) return { error: 'tick-out-of-bounds' };
          if (c.tick < lastTick) return { error: 'commands-out-of-order' };
          lastTick = c.tick;
          if (c.type !== 'tap' && c.type !== 'release') return { error: 'bad-command-type' };
          if (!(c.lane >= 0 && c.lane < 4)) return { error: 'lane-out-of-bounds' };
        }

        const result = replayEnvelope(chart, env);
        if (!result.ok) return { error: result.reason };
        if (result.hash !== env.terminal.hash) return { error: 'hash-mismatch', rejected: true };

        const b = result.breakdown;
        // Plausibility: accuracy bounds and score consistency are guaranteed by
        // the replay; here we only guard absurd durations.
        if (b.elapsedMs > chart.durationMs + 5000) return { error: 'implausible-duration' };

        return {
          ok: true,
          accepted: true,
          score: b.total,
          grade: b.grade,
          accuracy: b.accuracy,
          maxCombo: b.maxCombo,
          assists: env.assists || {},
          durationMs: b.elapsedMs,
        };
      }

      case 'unlock-achievement': {
        const ALLOWED = ['first-light', 'hold-mastery', 'streak-50', 'summit-clear', 'long-road'];
        if (typeof msg.key !== 'string' || !ALLOWED.includes(msg.key)) return { error: 'unknown-achievement' };
        const already = ctx.store.get(`ach:${ctx.identity}:${msg.key}`);
        if (already) return { ok: true, already: true }; // idempotent
        ctx.store.set(`ach:${ctx.identity}:${msg.key}`, ctx.now());
        return { ok: true, unlocked: true };
      }

      default:
        return { error: 'unknown-kind' };
    }
  } catch (e) {
    return { error: 'internal', detail: String(e && e.message || e) };
  }
}

// Platform adapter (js/platform.js) over the shipped StarHermit SDK with a
// stubbed fetch and launch fragment: token read, profile nickname, cloud save
// round trip on `game:<slug>`, settings KV, lane bindings (controls API), and
// no network traffic standalone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../js/persistence.js';

const SDK = (() => {
  const m = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(m, m.exports);
  return m.exports;
})();

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-1234567890', game_scope: 'rhythm-steps', exp: 9999999999 })}.sig`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timers = { setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)), clearTimeout: (t) => t && clearTimeout(t) };

function fakeWindow(hash, hostname = 'localhost') {
  const loc = { hash, pathname: '/', search: '', hostname, href: `https://${hostname}/${hash}`, origin: `https://${hostname}` };
  return { location: loc, history: { state: null, replaceState(_s, _t, url) { loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } } };
}
function stubNet() {
  const calls = [];
  const store = { save: null, patches: [], controls: [] };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, auth: init.headers && init.headers.Authorization });
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/v1/users/u-1234567890/profile') return json(200, { nickname: 'Beat Ana' });
    if (url === '/api/v1/me/cloud-saves/game%3Arhythm-steps') {
      if (method === 'GET') return store.save ? new Response(store.save, { status: 200 }) : json(404, {});
      if (method === 'PUT') { store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return json(200, {}); }
    }
    if (url === '/api/v1/games/rhythm-steps/settings') {
      if (method === 'GET') return json(200, { settings: { volMusic: 0.2, keys: ['x'] } });
      if (method === 'PATCH') { store.patches.push(JSON.parse(init.body).settings); return json(200, {}); }
    }
    if (url === '/api/v1/games/rhythm-steps/controls') {
      if (method === 'GET') return json(200, { actions: [{ action: 'lane2', codes: ['KeyG'] }] });
      if (method === 'PUT') { store.controls.push(JSON.parse(init.body).bindings); return json(200, {}); }
    }
    return json(404, {});
  };
  return { calls, store, fetch };
}
let n = 0;
async function load(win, net) {
  globalThis.StarHermit = SDK.create({ window: win, fetch: net.fetch, ...timers });
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, hidden: false };
  const P = await import(`../js/platform.js?i=${n++}`);
  P.detectHost();
  return P;
}

test('hosted: token, nickname, cloud save, settings KV, bindings', async () => {
  const net = stubNet();
  const win = fakeWindow(`#game_token=${JWT}`);
  const P = await load(win, net);
  assert.equal(P.isHosted(), true);
  assert.equal(win.location.hash, '');
  assert.equal(P.gameScope(), 'rhythm-steps');
  assert.equal(await P.loadProfile(), 'Beat Ana');

  assert.deepEqual(await P.cloudLoad(), { ok: true, none: true });
  P.scheduleCloudPush({ version: 2, stats: { sessionsPlayed: 4 } });
  P.flushCloud();
  await sleep(20);
  assert.ok(net.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/me/cloud-saves/game%3Arhythm-steps'));
  assert.deepEqual((await P.cloudLoad()).doc, { version: 2, stats: { sessionsPlayed: 4 } });

  const settings = { ...DEFAULT_SETTINGS };
  assert.equal(await P.loadSettings(settings, DEFAULT_SETTINGS), true);
  assert.equal(settings.volMusic, 0.2);
  assert.deepEqual(settings.keys, DEFAULT_SETTINGS.keys, 'key bindings are not settings');
  settings.largeText = true;
  P.mirrorSettings(settings, DEFAULT_SETTINGS);
  await sleep(700);
  assert.deepEqual(net.store.patches.at(-1), { largeText: true });

  await P.loadBindings(['KeyD', 'KeyF', 'KeyJ', 'KeyK']);
  assert.equal(P.actionFor('KeyG'), 'lane2');
  assert.equal(P.actionFor('KeyF'), null);
  assert.equal(P.actionFor('Escape'), 'pause');
  P.saveLaneBindings(['KeyA', 'KeyS', 'KeyJ', 'KeyK']);
  await sleep(10);
  assert.deepEqual(net.store.controls.at(-1), { lane1: ['KeyA'], lane2: ['KeyS'], lane3: ['KeyJ'], lane4: ['KeyK'] });

  assert.ok(net.calls.every((c) => c.auth === `Bearer ${JWT}`));
  assert.ok(P.inviteLink().includes('/game-invite/u-1234567890/rhythm-steps'));
});

test('standalone: no network; local lane keys drive bindings', async () => {
  const net = stubNet();
  const P = await load(fakeWindow('', 'rhythm-steps.starhermit.com'), net);
  assert.equal(P.isHosted(), false);
  assert.equal(P.canSignIn(), true);
  assert.equal(await P.loadProfile(), null);
  assert.equal((await P.cloudLoad()).ok, false);
  P.scheduleCloudPush({ a: 1 });
  P.flushCloud();
  assert.equal(await P.loadSettings({}, DEFAULT_SETTINGS), false);
  await P.loadBindings(['KeyA', 'KeyS', 'KeyJ', 'KeyK']);
  assert.equal(P.actionFor('KeyA'), 'lane1');
  P.saveLaneBindings(['KeyA', 'KeyS', 'KeyJ', 'KeyK']);
  P.resetControls();
  assert.equal((await P.fetchGameInfo()).ok, false);
  assert.equal(P.inviteLink(), null);
  await P.syncTime();
  assert.deepEqual(net.calls, []);
  assert.equal(P.keyToCode('d'), 'KeyD');
  assert.equal(P.keyToCode(';'), 'Semicolon');
  assert.equal(P.keyLabel('KeyD'), 'D');
});

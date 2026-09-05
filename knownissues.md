# Known Issues — Rhythm Steps

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and its bundled headless-Chrome end-to-end smoke test.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | **PASS** — 39/39 (`node tests/run-tests.mjs`) |
| `node --check` on all modules | clean (11 modules + `server.js`) |
| `tests/e2e.mjs` (headless Chrome + touch) | **PASS** — desktop 1280x800 and mobile 390x844 playthroughs both reach a results screen with **no page errors**; exits 0 with the `E2E PASS` line |

(The previous `tests/e2e-smoke.mjs` was superseded by `tests/e2e.mjs`, which drives real
keyboard/touch inputs through the on-screen UI in both a desktop and a touch-enabled mobile viewport.)

The e2e run drove real key events against the live chart and scored 700 points from three
simulated hits, reached the results screen twice (abort and natural completion), rendered all 40
journey stages, and confirmed the session was persisted. Additional coverage added by this pass: a
corrupt-`localStorage` reload matrix over `rhythm-steps:save` and `rhythm-steps:settings`
(`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted cleanly).

## Resolved

Both confirmed defects were fixed and verified on 2026-09-05.

### RESOLVED — 1. The timing-assist flag is unverifiable

**Fix:** Take the server-side-reject option the expected text explicitly allowed. The server now
rejects any ranked envelope that claims the widen-window timing assist, so a modified client cannot
post an assisted run as a clean one:

- `server.js:62-67` — `handleMessage` validates `validate-score` envelopes and returns
  `{ error: 'assist-not-permitted', rejected: true }` when `env.assists?.timingAssist === 'wide'`.
- Test added at `tests/run-tests.mjs` ("server rejects a ranked envelope carrying the wide timing
  assist").

**Verification:** `npm test` passes (39/39).

### RESOLVED — 2. Score-chase board ignores the spec tie-break (`compareResults` dead code)

**Fix:** Wire `compareResults` into both the write and render paths, and normalize legacy locally
saved board entries via a new `chaseEntry` helper:

- `js/rules.js:361-369` — add `chaseEntry(e)`, mapping legacy `{score}`-only entries to the
  `{total, invalidActions, elapsedMs, terminalReason, sessionId}` fields `compareResults` reads.
- `js/main.js:547-550` — build the board entry with the full field set (including
  `terminalReason`, `invalidActions`, `elapsedMs`) and `board.sort((a, b) =>
  compareResults(chaseEntry(a), chaseEntry(b)))`.
- `js/ui.js:221` — `renderChaseBoard` sorts by `compareResults(chaseEntry(a), chaseEntry(b))`.
- Test added at `tests/run-tests.mjs` ("chase board tie-break uses compareResults and tolerates
  legacy entries").

**Verification:** `npm test` passes (39/39); the tie-break ordering (fewer invalid actions, then
lower elapsed time) is asserted directly.

### RESOLVED — 3. Playfield canvas could be 1x1 / hidden, failing the e2e

The playfield was hiding the canvas (`#playfield` got the `hidden` class) and the renderers sized
themselves from a container that reported `0` until layout, leaving a 1x1 canvas and breaking any
e2e that required a visible, actionable playfield.

**Fix:**

- `index.html:16` — `#playfield` no longer starts `hidden`; it is the opaque screens' (z-index 10)
  backdrop, so the renderer keeps a real viewport size while screens are shown.
- `js/main.js:58` — `renderer.resize()` is called at boot to size the canvas from the start.
- `js/render2d.js:167-168`, `js/render3d.js:473-476` — `Math.max(1, container.clientWidth ||
  window.innerWidth)` (and height), so the canvas never falls back to 1x1 when the host is not yet
  laid out.
- `js/ui.js:70-73`, `js/ui.js:375` — the playfield is no longer force-hidden when showing a screen;
  it remains the sized backdrop.

**Verification:** `tests/e2e.mjs` passes with real hits registered on both desktop (keyboard) and
mobile (touch), which requires a visible, correctly sized lane canvas.

## Suspected — not confirmed

### 1. Score-chase seeds are player-chosen

- **File:** `js/ui.js:43-50` (`btn-chase-start` / `btn-chase-random`), `server.js:34-38`
  (`chartForEnvelope`)
- **Concern:** The seed is typed into a free-text field (`chase-seed`) with a random default, and
  `chartForEnvelope` will happily rebuild a chart for whatever seed the envelope names. A player
  can therefore hunt for a seed that generates an easy chart and post a high score on it.
  spec.md §Modes calls for "asynchronous global and friends comparisons using **validated seeds
  and rulesets**".
- **Why unconfirmed:** Boards are keyed per seed (`save.chaseBoards[seed]`, `js/main.js:543`), so
  players compete only against others on the same seed — which may be the intended "shareable
  seeded chart" design described at `js/content.js:297`. Whether a *global* score-chase board
  exists depends on the host, which is not in this repository.

### 2. An old `daily-<date>` chart id is accepted for validation

- **File:** `server.js:31-33`
- **Concern:** `chartForEnvelope` rebuilds `dailyChart(env.chartId.slice('daily-'.length))` for any
  date string, with no comparison against `ctx.now()`. A player could keep replaying a favourable
  past day.
- **Why unconfirmed:** The host, not this module, decides which board a validated result is filed
  under, and `handleMessage` has no board-write path to inspect.

## Investigated and rejected

### Model claim: `openMode` never shows the daily screen

The model review flagged `js/main.js:178` because the `'daily'` branch of `openMode` calls
`controller.startDaily()` while every other mode calls `ui.showScreen(...)`, concluding "the
'daily' screen is never shown". **This is not a defect.** There is no `screen-daily` in
`index.html` (the sections are title/setup/journey/practice/challenge/learn/chase/results/settings/
help/profile), and `startDaily()` (`js/main.js:262-274`) goes straight to the shared setup screen
with `ranked: true` and the assist summary — exactly what spec.md:84 asks for ("Mode setup: show
rules, expected duration, player count, assists, and whether the result is ranked before
commitment"). Recorded so the claim is not re-investigated.

## Checked, no defects found

- UI: a 60-click random crawl across title, journey list, stage setup, in-play lane keys, pause,
  settings, help and profile produced zero console errors. (An earlier 80-click run aborted on a
  CDP evaluate timeout; re-running it cleanly showed that was a harness/browser stall, not a
  game fault.)
- Suspend/resume and corrupt storage: covered by the bundled e2e plus a five-payload corruption
  matrix over both storage keys.
- `js/rules.js`: judgment windows, miss window, hold grace and hold-tick scoring, empty-hit and
  health handling, `legalActions`, monotonic `tick`, terminal reasons, integer score breakdown,
  serialization and `hashState`, `replayEnvelope` with idempotent duplicate-id rejection — all
  covered by the passing suite (golden easy/medium/hard runs, an interrupted session, an all-miss
  session) and by reading. The model review returned NO DEFECTS FOUND.
- `js/content.js`: 40 journey stages, challenges, practice difficulties, lessons, immutable daily
  seed per UTC date, a 200-case generator fuzz and a 500-case malformed-command fuzz — all pass.
- `server.js` `validate-score`: version and content-version gates, command-log bounds, per-command
  tick ordering/bounds/type/lane checks, seed match against the rebuilt chart, terminal-hash
  comparison, duration bound, per-identity rate limit, and idempotent achievement unlock. Tests
  cover tampering, malformed/oversized/unknown messages and rate limiting.
- Persistence (`js/persistence.js`): five kinds of corrupt payload in both storage keys, all
  booting cleanly.
- Real-browser behaviour: the bundled e2e reports zero page errors across the whole flow.

## Not tested

- `js/render3d.js` visual output beyond "boots, mounts a canvas, and reports no errors"; headless
  SwiftShader cannot judge the acceptance criteria in spec.md §4.
- A live HTTP surface: `server.js` is a StarHermit message-handler module, not an HTTP server, so
  it was reviewed by reading and through its unit tests rather than by probing a port.
- Gamepad and haptics input paths. (Touch is now covered by `tests/e2e.mjs`: the mobile 390x844
  viewport taps the on-screen lane buttons with `hasTouch: true` and registers real hits.)

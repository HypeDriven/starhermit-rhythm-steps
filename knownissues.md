# Known Issues — Rhythm Steps

## Review pass 2026-09-07 (Claude Opus 5)

`npm test` **41/41 PASS**, `node --check` clean on all 11 modules + `server.js`,
`npm run test:e2e` **PASS** (desktop 1280x800 + mobile 390x844, zero page errors).

Fixed in this pass:

1. **Restarting a track dropped its modifiers.** `restartTrack()` rebuilt the session with
   `{ lesson: context.lesson }`, a field that is never stored on the context, so `opts.failEnabled`
   was lost: restarting *Thin Ice* or *Unbroken* from the pause menu (or Retry from the results
   screen) silently continued without health, and restarting a lesson lost the lesson overlay.
   `js/main.js` now keeps `currentOpts` alongside the chart/mode/context and reuses it.
   Covered by `tests/e2e.mjs` ("challenge restart keeps the health modifier").
2. **Escape resumed play underneath the settings panel.** With Settings or Help opened over the
   pause menu (z-index 50 over the pause dialog), Escape hit the `phase === 'paused'` branch and
   resumed the run while the opaque panel still covered the playfield. The key handler now closes
   an open overlay screen first (`ui.overlayScreenVisible()`), matching the on-screen Back button.
   Covered by `tests/e2e.mjs` ("pause → settings overlay → back leaves the game paused").
3. **2D fallback renderer drew at the wrong scale above 2x DPR.** `resize()` caps the backing store
   at `dpr = min(devicePixelRatio, 2)` but `update()` recovered CSS pixels with the *uncapped*
   `devicePixelRatio`, so on a 3x display the lanes were laid out across two thirds of the canvas.
   The CSS size is now recorded in `resize()` and used directly.
4. **Left-handed layout desynced the lanes from the buttons.** `body.left-handed` reverses the lane
   button row, but both renderers kept drawing lane 0 on the left, so every touch target pointed at
   the wrong lane. `mirrorLanes` now mirrors the drawn lanes and the pointer pick in `render2d.js`
   and `render3d.js`, and toggling the setting rebuilds the 3D causeway.
5. **The playfield stayed focusable and in the accessibility tree behind menus.** The lane and pause
   buttons could be tabbed into from a menu screen or the pause dialog. `#playfield` is now `inert`
   (plus `aria-hidden`) whenever a screen or the pause dialog covers it. Pausing also clears held
   lanes, which the swallowed pointer/key release would otherwise leave lit.
6. **Server accepted a daily replay from any past day** (previously logged below as *Suspected 2*).
   `chartForEnvelope` rebuilt `daily-<date>` for any date string, so a favourable past day could be
   farmed. Validation now accepts only the current UTC day and the previous one (a run finishing
   across the rollover), and requires the rebuilt chart id to equal the submitted `chartId` so a
   score-chase submission cannot claim a difficulty it did not play. Two tests added.
7. **Smaller UI fixes.** The HUD accuracy readout no longer shows the previous run's value before
   the first judgment; the score-chase board looks up the same normalized seed key that
   `startChase` writes (and refreshes as the seed field changes) and tolerates entries without a
   `score`/`grade` field; the title's journey status uses `JOURNEY_STAGES.length` instead of a
   hard-coded 40.

Also added: `LICENSE.md` (PolyForm Noncommercial 1.0.0), which the repo was missing.

---

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

### 2. An old `daily-<date>` chart id is accepted for validation — RESOLVED 2026-09-07

Fixed in the review pass above: `chartForEnvelope` now rejects any daily date outside the current
UTC day and the one before it. Original report follows.

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

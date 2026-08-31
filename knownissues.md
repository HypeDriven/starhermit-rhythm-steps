# Known Issues — Rhythm Steps

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark105 (OBLITERATED Q5_K_M),
alongside the game's own test suite and its bundled headless-Chrome end-to-end smoke test.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | no `package.json`; `node tests/run-tests.mjs` gives 37/37 pass |
| `node --check` on all modules | clean (11 modules + `server.js`) |
| `tests/e2e-smoke.mjs` (headless Chrome) | **PASS** — 23 checks, "no page errors", full boot → setup → countdown → active → pause/resume → abort → retry → natural track end → results → save |

The e2e run drove real key events against the live chart and scored 700 points from three
simulated hits, reached the results screen twice (abort and natural completion), rendered all 40
journey stages, and confirmed the session was persisted. Additional coverage added by this pass: a
corrupt-`localStorage` reload matrix over `rhythm-steps:save` and `rhythm-steps:settings`
(`{"broken":`, `null`, `[]`, `{}`, non-JSON — all booted cleanly).

## Confirmed defects

Defects below were each verified by reading the source, not just reported by the model.

### 1. The timing-assist flag is unverifiable — the assist is baked into the logged commands

- **File:** `js/session.js:79-98` (`_assistTick` / `tap`), `server.js:94`, gated only at
  `js/main.js:536` and `js/main.js:549`
- **Trigger:** Play a Daily or Score-chase run with `timingAssist: 'wide'` from a client that does
  not apply the local gate, then submit.
- **Behaviour:** The assist rewrites the input timestamp *before* the command is logged:

  ```js
  // Timing assist widens windows by pulling the command tick toward the note
  // time. The transformed command is what gets logged — replay stays exact.
  ```

  `replayEnvelope` (`js/rules.js:395-408`) never receives the assist settings, so the server's
  replay reproduces the assisted timings exactly and cannot tell an assisted run from a perfect
  one. The authoritative script then simply echoes the client's own claim:

  ```js
  assists: env.assists || {},
  ```

  The only thing preventing assisted submissions is a client-side check
  (`save.settings.timingAssist !== 'wide'` at `js/main.js:536` and `js/main.js:549`), which a
  modified client drops.
- **Expected:** spec.md:204 requires assists to be part of a validated submission, and
  spec.md §Determinism: "Treat client clocks, scores, inventories, roles, physics outcomes, and
  completion claims as untrusted in competitive contexts." Either log the raw tick plus the assist
  setting and let the replay apply it, or reject assisted envelopes server-side.
- **Evidence:** The four quoted locations. The design is deliberate (the comment says so), but it
  makes the ranked-board assist flag unenforceable.

### 2. Score-chase board ignores the spec tie-break, and `compareResults` is dead code

- **File:** `js/main.js:546` and `js/ui.js:219`; `js/rules.js:351-359` (`compareResults`)
- **Trigger:** Post two runs with the same total to the same seed board.
- **Behaviour:** Both the write path and the render path sort by score alone:

  ```js
  board.sort((a, b) => b.score - a.score);                                   // js/main.js:546
  (save.chaseBoards[id] || []).slice().sort((a, b) => b.score - a.score)…    // js/ui.js:219
  ```

  Equal scores therefore fall back to insertion order. `compareResults` — whose header comment
  reads "Tie-break ordering: primary objective completion, fewer invalid actions, lower
  authoritative elapsed time, then stable session identifier" and which is unit-tested at
  `tests/run-tests.mjs:195-199` — is never called by the game (`grep -rn compareResults js/`
  matches only its own definition).
- **Expected:** spec.md:38's ordering, i.e. use `compareResults`.
- **Evidence:** The three quoted locations plus the grep for call sites.

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
- Touch, gamepad and haptics input paths.

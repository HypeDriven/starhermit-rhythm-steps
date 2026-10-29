# Rhythm Steps — specification

Rhythm Steps is a four-lane rhythm game on a reactive concert causeway made of light. Notes descend the
lanes toward a glowing judgment line: tap them on the beat, hold the long glowing bars head to tail, and
keep the combo alive. It is a StarHermit engine **script game** (engine 1.23.0, host API 1.22,
`engine.minor=20`), played natively by the StarHermit client and in browsers by the engine's web runtime
from one package. (The browser build's original design specification is in the git history before the
engine port.)

## Files

| Path | What it is |
| --- | --- |
| `starhermit.txt` | Manifest: entry `native/main.ts`, engine pin, capabilities (platform, storage, clipboard), the lane and pause actions with keys, pads and Options groups, `server=score-script.js`. |
| `native/main.ts` | Entry: game flow, the fixed-step song clock, input, session events, progression, results, lifecycle. |
| `native/session.ts` | One playthrough over the rules (commands, the replay command log, logical events). |
| `native/screens.ts` | Every screen, the pause dialog and the playfield HUD on `starhermit:ui`. |
| `native/render.ts` | The causeway on `starhermit:scene`; `native/quality.ts` the look per graphics tier. |
| `native/audio.ts` | Sound clips, the adaptive music stems, ambience, captions. |
| `native/platform.ts` | Save, options, account, clock, leaderboard posting and reading. |
| `native/i18n.ts`, `native/style.ts`, `native/game.ts` | Strings, the UI style sheet and theme, typed imports of `js/`. |
| `js/rules.js`, `js/content.js`, `js/rng.js`, `js/persistence.js` | The browser build's deterministic rules, content generator and save model, unchanged. |
| `js/progress.js` | What the engine save holds; merging; migrating the old cloud slot and settings. |
| `js/music.js` | The seeded composition rendered into five looping stems; the ambience bed. |
| `js/strings.js`, `js/sh-i18n.js` | Translation tables (nine locales) and the account strings. |
| `score-script.js` | Platform server script: range-checks a posted total for the `high-score` board (unchanged). |
| `server.js` | The replay/score validator module the rules tests exercise (not packaged, unchanged). |
| `sfx/*.opus` | Authored one-shots (`sfx/manifest.json` lists their events). |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`). |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index, written by `npm run package`. |
| `tests/`, `tools/` | Node tests, native play scripts and their generator, the browser check, packaging. |

## Rules

Unchanged from the browser build (`js/rules.js`, rules version 1). Four lanes; tap notes and hold notes.
A press is judged against the nearest pending note in its lane: Perfect within ±45 ms (300), Great ±90 ms
(200), Good ±135 ms (100); a note not pressed 135 ms after its time is a Miss and resets the combo. A press
with no note in reach is an empty hit (an invalid action; it drains health where health is on). Holds are
pressed at the head and held to the tail; releasing more than 120 ms early is an early release (combo
reset), otherwise the hold completes. Holds score 10 points per 100 ms sustained. Each hit adds a combo
bonus of +2 per 10 combo (at most +100). Results show notes + combo bonus + hold bonus = total, the
counts, max combo, accuracy (Perfect 1, Great 0.7, Good 0.4, Miss 0) and a letter grade (SSS … D; F for a
failed run). Health (Challenges Unbroken and Thin Ice) loses 12 per miss, 6 per early release, 2 per empty
hit; at zero the run fails.

Timing assist "Wide" (Settings) pulls a press toward the nearest note (1.5× windows) and is shown as an
assist on the setup card.

## Modes and content

Unchanged content (`js/content.js`, content version 1), generated deterministically from seeds:

- **Journey** — 40 stages in five themed blocks (taps, holds, chords, streams, everything), every 8th a
  mastery stage with an accuracy goal. Clearing unlocks the next stage and earns 1–3 stars (completion,
  ≥ 90 % accuracy, no miss). Play on the title starts the next unlocked stage.
- **Daily** — one seed per UTC day (the platform's clock; the device's when offline), rotating difficulty
  and theme; the personal best per day is kept in the save.
- **Practice** — five difficulties (Calm … Relentless) and a choice of the five themes; unranked.
- **Challenge** — Unbroken (health on, no misses), Redline 140 (accuracy ≥ 80 %), Thin Ice (health drain),
  Longform (holds, accuracy ≥ 85 %), Sharp Eyes (score target 55 % of par).
- **Score Chase** — any numeric seed at a chosen difficulty; every run is added to the seed's local board
  (top 20, saved and cloud-synced), and the platform's high-score board shows read-only.
- **Learn** — three interactive lessons (tap on the line, hold the glow, keep the streak) whose steps advance
  only when the player performs the action.

Progression: mastery XP (total / 50, +25 for a completed run; level = ⌊√(XP/100)⌋ + 1), lifetime stats
(sessions, total score, best combo, holds completed, days played) and five achievements kept in the save:
First Light, Steady Hands, Unbroken Fifty, Summit of Light, The Long Road.

## Screens

- **Title** over the live causeway: the logo, tagline, Play, the six mode buttons (Journey with the
  unlocked stage, Daily with today's grade), Settings, Help, Profile, Invite a friend (signed in) or Sign in.
- **Setup** card per run: description, rules, duration, players, ranked, assists, Start / Back.
- **Journey** grid (stars, locked stages dimmed, mastery stages with an accent border), **Practice**,
  **Challenges**, **Learn**, **Score Chase** (seed field, difficulty, Play this seed, Random seed, local and
  platform boards), **Profile** (avatar, guest name field or the account name, mastery, sessions, best
  combo, days played, cloud sync state, achievements).
- **Countdown** 3-2-1-GO (36 steps each), then the **playfield**: objective pill, track progress bar, pause
  button, score / combo / accuracy / health, the judgment pop, the audio caption line, the lesson card, the
  four lane buttons and toasts.
- **Pause** dialog: Resume, Restart track, Settings, Help (both over the paused run), Leave track.
- **Results**: grade, headline (stars, goal met, failed), the score breakdown, counts, achievements
  unlocked, mastery XP, the leaderboard line (signed in), Retry / Next stage / Home.
- **Settings**: note speed, camera sway, hold style (hold / toggle), timing assist, colour-vision-safe
  palette, left-handed lanes, audio captions, haptics; Open Options (the runtime's); Replay tutorial;
  Reset all progress (inline confirmation).
- **How to play**: rule cards with the player's effective keys.

Layouts by the window's logical size: wide (≥ 1024 px: the HUD's objective rail at the left, a 640 px lane
tray), phone portrait (≤ 700 px wide: 76 px lane buttons, tighter panels) and short landscape (≤ 500 px
tall: compact title with three mode columns, two-column setup and results, a 44 px lane strip).

## Controls

| Action | Keys | Gamepad | Touch / mouse |
| --- | --- | --- | --- |
| Lane 1–4 | D F J K | A / D-pad up, B / down, X / left, Y / right | the lane buttons, or the lanes of the causeway |
| Pause / back | Escape | Start | the ⏸ button |

Players rebind keys and pads in the runtime's Options (actions `lane1`–`lane4`, `pause`; the old platform
controls carry over by name). Fingers are tracked individually, so chords and holds work with several
fingers; a lane is up when no key, pad, finger or mouse holds it. Hold style "toggle" releases a hold on the
second press. Menus use the runtime's focus navigation (Tab / arrows / Enter, the pad); Escape goes back.

## Look

The browser build's three.js r160 scene on `starhermit:scene`: WGSL sky dome (gradient, beat-swelling
horizon glow, aurora shimmer), metallic floor with an emissive grid far below, four brushed-glass lanes whose
beat rungs flow with the notes, light-strip edges, the breathing judgment line, receptors that flash and
swell on presses, clear-coated gem notes and glowing hold bars, instanced pylons with beat-pulsing caps,
drifting light arches, sky dust, hit pulse rings and sparks, drifting motes; portrait and landscape
framing, seeded camera sway and a small shake on misses and combo milestones (both off under reduced
motion). Five themes and the colour-vision-safe palette.

Port details: punctual light intensities ÷ π (r155+ lights); `new RoomEnvironment(renderer)` prefiltered
at 0.04 as before, given to each lit material as its own envMap at its old envMapIntensity (at minor 20
the scene environment ignores per-material intensity); the post chain is `renderer.ao` (GTAO), `bloom`
(0.5 / 0.4 / threshold 0.9), `grade` (linear S-curve 0.18, saturation 1.12, split tints, vignette 0.26) and
`antialias`. Graphics tiers follow the runtime's quality (Low: Lambert, no shadows or post, static
background, plain detail; Balanced: standard materials, 512 shadows, bloom, grade, FXAA, sparks, animated,
detailed; High: physical, 1024 shadows, GTAO, SMAA; Ultra: 2048 shadows, full GTAO, MSAA); spark and mote
counts scale with the level. Render scale, adaptive resolution and the frame-rate limit are the runtime's.

## Audio

Authored one-shots per event (hit grades, combo milestone every 25, hold ticks, miss, empty hit, countdown,
results fanfares, UI clicks), loaded one at a time once the mixer runs. The music is the old seeded
composition (kick, bass, hat, snare, arpeggio on an eighth-note grid), rendered per chart into five looping
stems and played as sample-aligned buffer sources on the synthesis graph; their gains follow the combo
intensity (the old adaptive layers). The theme's ambience bed is a rendered loop. Buses: effects (hits,
countdown, fanfares), interface (UI), music (music and ambience). Captions (Settings) show "Combo 25!",
"Miss", the countdown and the track's end. Volumes, mute and the voice limit are the runtime's Options.

## Lifecycle and determinism

The song clock is the runtime's fixed steps at 60 Hz: step *n* is tick round(n·1000/60) ms, and a press is
judged at the last step's tick. Pauses, a hidden window (which pauses the run) and slow frames never move
it, every machine judges the same press the same way, and play scripts replay exactly. The music follows
the step clock: it starts at the song position and restarts its stems at the step clock's position when
the mixer drifts more than 35 ms from it. Cosmetic randomness (sparks, shake, sway) uses separate seeded
streams and never touches the rules.

## Platform

- **Save**: the engine save (device and cloud) holds the progress above; two devices' copies merge (higher
  unlock, better stars and scores, union of lessons, achievements and seed-board entries, larger stats).
  The browser build's cloud slot (`game:<slug>`) is read as foreign, merged in once and replaced.
- **Options**: the game's eight options are engine settings (synced); values the browser build stored in
  the account's settings KV are adopted once, then every old KV key is removed.
- **Leaderboard**: signed in, every completed run except lessons posts its total through
  `score-script.js` (range-checked by the server script) to the `high-score` board; the results show the
  rank. The Score Chase screen reads the board's top 10 (guests too).
- **Account**: sign-in, the invite link (copied to the clipboard), the account name and avatar on the
  profile; a sign-out keeps playing locally.
- Multiplayer: none (asynchronous comparison only).

## Localization and accessibility

Nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) in the runtime's interface
language. Screen-reader names for every control (lane buttons announce their key), live announcements of
misses, lesson steps and results. High contrast, larger text and reduced motion are the runtime's options
(high contrast swaps the UI tokens; reduced motion stops sway, shake, sparks and background motion).

## Checks

- `npm test`: rules, content, replay and server-validator suite (`tests/run-tests.mjs`); progress model,
  i18n coverage and the play-script model (`node --test`); `tests/native.mjs`: web index up to date, `tsc`,
  `starhermit check` with no warnings, and the render-check play scripts in `tests/native/` (Journey 1→2 by
  keys all Perfect, Practice with holds and chords, Learn by touch on a 390×844@3 phone, a failing
  Challenge, Score Chase with a typed seed, today's Daily, the menus and the pause flow), generated by
  `npm run plays` from the rules.
- `npm run test:browser`: the web package in Chrome on the GPU at desktop, phone (DPR 3) and phone
  landscape: keys, mouse and touch on lanes, pause and resume, through to the results, no console errors.

## Known limitations

- Guest key rebinds stored in the old save's settings are not carried over (the runtime's controls start
  from the defaults; signed-in players' platform controls carry over).
- The old anonymous-usage-stats checkbox is gone: the browser build never sent anything.
- Achievements are save-local (as before); the platform has no achievement records for this game.
- Score posting uses `score-script.js` with the client's total, range-checked (unchanged from the browser
  build, per the solo-leaderboard policy); replay validation in `server.js` is not deployed.

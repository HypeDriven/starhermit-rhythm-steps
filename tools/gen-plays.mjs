// Writes the engine play scripts that play whole tracks through the real UI
// (tests/native/*.play): a bot presses every note of a chart at the fixed
// step nearest its time (holds held to their tail) by keys (D F J K) or by
// touches on the lane buttons, and the rules (js/rules.js) replay exactly
// those presses at the ticks the game will judge them, so each script checks
// the results' total and counts.
//
// Timing (measured on the 1.23.0 render check, one fixed step a frame at
// 60 Hz; see tests/plays.test.mjs for the model's own checks): counting the
// frames after the line that starts the track (`click =Start`, a lesson's
// card, `click =Retry`), the countdown takes 144 steps and a press line
// issued at frame F after it is judged at song step F + OFFSET (OFFSET
// below). Each hold / release line takes one frame, a touch line three, `frames N`
// takes N + 1. Lines that would share a frame (chords, a release beside a press)
// are pushed to the next free frame, which the rules then judge a step
// later — still Perfect (±45 ms is ±2.7 steps).
//   node tools/gen-plays.mjs            write the scripts
//   node tools/gen-plays.mjs --offset N one calibration script (tests/native/_calibrate.play) at offset N
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGame, applyCommand, advance, scoreBreakdown } from '../js/rules.js';
import { journeyChart, lessonChart, challengeChart, practiceChart, dailyChart, scoreChaseChart } from '../js/content.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = main ? process.argv.slice(2) : [];
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
/** Song step a press line acts at = its frame after the start line − START. */
export const START = opt('--offset', 144);
/** The same for touches on the lane buttons (a phone layout). */
export const TOUCH_START = opt('--touch-offset', START);
export const STEP_MS = 1000 / 60;
export const tickOf = (step) => Math.round(step * STEP_MS);
const KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];

/**
 * The bot's presses for a chart: [{ step, lane, type: 'down' | 'up' }] — each note pressed at its
 * nearest step, a tap let go two steps later, a hold three steps after its tail.
 */
export function presses(chart, { skip = () => false } = {}) {
  const out = [];
  for (const n of chart.notes) {
    if (skip(n)) continue;
    const s = Math.round(n.time / STEP_MS);
    out.push({ step: s, lane: n.lane, type: 'down', note: n.id });
    const end = n.kind === 'hold' ? Math.round((n.time + n.duration) / STEP_MS) + 3 : s + 2;
    out.push({ step: end, lane: n.lane, type: 'up', note: n.id });
  }
  out.sort((a, b) => a.step - b.step || (a.type === 'up' ? -1 : 1) || a.lane - b.lane);
  return out;
}

/** Places each press on a frame of its own (one line a frame): [{ frame, line, step }] with the step it is judged at. */
export function schedule(list, { touch = null, saves = [] } = {}) {
  const S0 = touch ? TOUCH_START : START;
  const used = new Set();
  const out = [];
  for (const sv of saves) { used.add(sv.step + S0); out.push({ frame: sv.step + S0, line: `save ${sv.name}`, step: sv.step, lane: -1, type: 'save' }); }
  for (const p of list) {
    let f = p.step + S0;
    while (used.has(f) || (touch && (used.has(f - 1) || used.has(f - 2)))) f++;
    used.add(f);
    if (touch) { used.add(f + 1); used.add(f + 2); } // a touch line takes three frames (measured): down, then lifted
    const line = touch ? (p.type === 'down' ? `touch ${touch[p.lane]}` : null) : `${p.type === 'down' ? 'hold' : 'release'} ${KEYS[p.lane]}`;
    if (line) out.push({ frame: f, line, step: f - S0, lane: p.lane, type: p.type, len: touch ? 3 : 1 });
  }
  return out.sort((a, b) => a.frame - b.frame);
}

/** The rules' result for the scheduled presses (a touch is a press and its release a frame later). */
export function expected(chart, sched, { failEnabled = false, touch = false } = {}) {
  const s = createGame(chart, { failEnabled });
  let k = 0;
  const cmds = [];
  for (const e of sched) {
    if (e.type === 'save') continue;
    cmds.push({ id: `c${k++}`, tick: tickOf(e.step), type: e.type === 'down' ? 'tap' : 'release', lane: e.lane });
    if (touch) cmds.push({ id: `c${k++}`, tick: tickOf(e.step + 1), type: 'release', lane: e.lane });
  }
  cmds.sort((a, b) => a.tick - b.tick);
  for (const c of cmds) applyCommand(s, c);
  advance(s, chart.durationMs + 5000);
  return scoreBreakdown(s);
}

/** Script lines for the schedule, from the line after the starting line. */
export function lines(sched) {
  const out = [];
  let c = 0; // the frame the next line runs at
  for (const e of sched) {
    if (e.frame < c) throw new Error(`line at frame ${e.frame} before ${c}`);
    if (e.frame > c) out.push(`frames ${e.frame - c - 1}`);
    out.push(e.line);
    c = e.frame + (e.len ?? 1);
  }
  return out;
}
const fmt = (n) => n.toLocaleString('en-US');
function resultLines(b, name) {
  const c = b.counts;
  return [
    'until 2400 =Results', 'frames 30',
    `expect =${fmt(b.total)}`, `expect =Perfect ${c.perfect}`, `expect =Great ${c.great}`, `expect =Good ${c.good}`, `expect =Miss ${c.miss}`,
    `expect =Max combo ${b.maxCombo}`,
    `save ${name}`,
  ];
}
function write(name, header, body) {
  writeFileSync(join(root, 'tests', 'native', name), header.map((l) => `# ${l}`).join('\n') + '\n' + body.join('\n') + '\n');
  console.log(`wrote tests/native/${name}`);
}
/** A track played by keys from its starting line: the lines, the expected breakdown. */
export function keyRun(chart, opts = {}) {
  const sched = schedule(presses(chart, opts), { saves: opts.saves ?? [] });
  return { lines: lines(sched), b: expected(chart, sched, opts) };
}
/** The lane buttons' centres on a 390 × 844 phone (screens.ts laneTray: 8 px margins, 8 px gaps, 76 px tall, 8 px from the bottom). */
const TOUCH = [0, 1, 2, 3].map((i) => `${(8 + 87.5 / 2 + i * 95.5).toFixed(1)} ${844 - 8 - 38}`);
/** Touches on the lane buttons (taps only: a touch lifts after a frame, so holds end early). */
export function touchRun(chart, opts = {}) {
  const sched = schedule(presses(chart, opts), { touch: TOUCH, saves: opts.saves ?? [] });
  return { lines: lines(sched), b: expected(chart, sched, { ...opts, touch: true }) };
}

/** Today's Daily from the title's Daily button, by keys (tests/native.mjs writes it at test time). */
export function dailyPlay(nowMs) {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const r = keyRun(dailyChart(date));
  return [
    `# The Daily for ${date} (UTC) from the title's Daily button, every note pressed on time (written by tests/native.mjs at test time).`,
    'until 300 =Play', 'frames 20', 'click =Daily', 'until 120 =Start', 'frames 10', 'click =Start',
    ...r.lines, ...resultLines(r.b, 'daily'),
  ];
}

if (main && args.includes('--offset')) {
  const r = keyRun(journeyChart(0));
  write('_calibrate.play', [`calibration at START ${START}: expect all Perfect`], [
    'until 300 =Play', 'frames 20', 'click =Play', 'until 120 =Start', 'frames 10', 'click =Start', ...r.lines, ...resultLines(r.b, 'calibrate'),
  ]);
  console.log(JSON.stringify(r.b.counts));
} else if (main) {
  // Journey 1 → 2 by keys from Play, every note Perfect; the grid then shows stage 3 unlocked
  const j1 = keyRun(journeyChart(0), { saves: [{ step: 300, name: 'play-1' }] }), j2 = keyRun(journeyChart(1));
  write('journey.play', ['Journey stages 1 and 2 played by keys, every note on its step (tools/gen-plays.mjs; generated: do not edit).'], [
    'until 300 =Play', 'frames 30', 'save title',
    'click =Play', 'until 120 =Start', 'frames 10', 'save setup', 'click =Start',
    ...j1.lines, ...resultLines(j1.b, 'results-1'),
    'click =Next stage', 'until 120 =Start', 'frames 10', 'click =Start', ...j2.lines, ...resultLines(j2.b, 'results-2'),
    'click =Home', 'until 120 =Play', 'frames 10', 'click =Journey', 'until 120 Forty stages', 'frames 10', 'save journey-grid', 'click =Stage 3: Crossing Lanes, 0 of 3 stars', 'until 120 =Start', 'expect =Stage 3: Crossing Lanes',
  ].filter(Boolean));
  // holds and chords: Journey 19 (Anchor Points: taps, holds, chords) from the grid is locked; Practice Steady has all of them
  const steady = practiceChart('steady', null, 'tideglass');
  const pr = keyRun(steady, { saves: [{ step: 900, name: 'practice-play' }] });
  write('practice-holds.play', ['Practice Steady (holds and chords) by keys (tools/gen-plays.mjs; generated: do not edit).'], [
    'until 300 =Play', 'frames 20', 'click =Practice', 'until 120 Unranked', 'frames 10', 'save practice',
    'click =Steady — 108 BPM', 'until 120 =Start', 'frames 10', 'click =Start', ...pr.lines, ...resultLines(pr.b, 'practice-results'),
  ]);
  // the lesson track by touches on the lane buttons in a phone layout
  const lt = touchRun(lessonChart('lesson-tap'), { saves: [{ step: 420, name: 'phone-play' }] });
  write('learn-phone.play', ['viewport 390x844@3', 'Learn: "Tap on the line" by touches on the lane buttons on a phone (tools/gen-plays.mjs; generated: do not edit).'], [
    'until 300 =Play', 'frames 20', 'save phone-title', 'touch =Learn', 'until 120 Interactive lessons', 'frames 10', 'save phone-learn',
    'touch Tap on the line', ...lt.lines, ...resultLines(lt.b, 'phone-results'),
  ]);
  // a challenge with health on, failing by not pressing: Thin Ice ends early
  const ch = challengeChart('survival');
  void ch;
  write('challenge-fail.play', ['Challenge Thin Ice with no presses: health drains to zero and the run fails (tools/gen-plays.mjs; generated: do not edit).'], [
    'until 300 =Play', 'frames 20', 'click =Challenge', 'until 120 =Thin Ice', 'frames 10', 'click =Thin Ice', 'until 120 =Start', 'frames 10', 'save challenge-setup',
    'click =Start', 'until 1800 =Challenge failed', 'frames 20', 'expect =Miss 9', 'save challenge-failed',
  ]);
  // Score Chase: a typed seed, played by keys
  const sc = keyRun(scoreChaseChart(424242, 'brisk'), { saves: [{ step: 600, name: 'chase-play' }] });
  write('chase.play', ['Score Chase with seed 424242 (Brisk) by keys; the local seed board then lists the run (tools/gen-plays.mjs; generated: do not edit).'], [
    'until 300 =Play', 'frames 20', 'click =Score Chase', 'until 120 =Play this seed', 'frames 10', 'click e.g. 123456', 'frames 5', 'type 424242', 'frames 5',
    'click =Play this seed', 'until 120 =Start', 'frames 10', 'click =Start', ...sc.lines, ...resultLines(sc.b, 'chase-results'),
    'expect =Score posted to your seed board',
  ]);
}

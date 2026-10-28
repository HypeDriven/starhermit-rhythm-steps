// The track's music, as the browser build's js/audio.js composed it, rendered
// into sample buffers instead of scheduled live on oscillators: pure (no
// audio API), so node tests time and check it and native/audio.ts plays it.
//
// The composition is the old one, deterministic from the chart seed: a root
// note and two 16-step lines (bass and arpeggio) from the seed's 'music'
// stream, played on an eighth-note grid — a kick on every beat, the bass on
// beats, a hat on off-beats, a snare on beats 2 and 4 and the arpeggio. The
// old music was adaptive: hats came in past 0.15 intensity (combo / 60),
// the arpeggio past 0.3 and the snare past 0.45, and the bass, hat and
// arpeggio grew louder with it. Here each layer is one looping stem of the
// 16-step loop (8 beats) at unit level; native/audio.ts plays the five stems
// together, sample-aligned, and sets each one's gain from the intensity
// (layerGains), which is the old mix step for step.
//
// Voices as the old _blip/_noise drew them: a blip rises linearly to its peak
// in 4 ms and decays exponentially to 0.0001 at its duration (oscillator
// frequencies ramp exponentially); a noise burst starts at its peak and decays
// the same way through a biquad high-pass (RBJ, as Web Audio's). The noise
// comes from a seeded stream ('music-noise'), so the stems are identical on
// every run.

import { makeRng, streamSeed } from './rng.js';

const PENTA = [0, 2, 4, 7, 9];
export const STEMS = ['kick', 'bass', 'hat', 'snare', 'arp'];

/** The old startMusic composition for a chart: root, bass and arpeggio lines (MIDI notes or null). */
export function compose(chart) {
  const rng = makeRng(streamSeed(chart.seed, 'music'));
  const rootMidi = 36 + rng.int(0, 5);
  const bassLine = [], arpLine = [];
  for (let i = 0; i < 16; i++) {
    bassLine.push(rng.chance(0.7) ? rootMidi + rng.pick(PENTA) : null);
    arpLine.push(rng.chance(0.6) ? rootMidi + 24 + rng.pick(PENTA) + rng.pick([0, 12]) : null);
  }
  const beatMs = 60000 / chart.bpm;
  return { rootMidi, bassLine, arpLine, beatMs, stepMs: beatMs / 2, loopMs: beatMs * 8 };
}

/** Each stem's gain at an intensity 0–1 (the old _scheduleStep levels over each stem's unit peak). */
export function layerGains(intensity) {
  const i = Math.max(0, Math.min(1, intensity));
  return {
    kick: 0.4,
    bass: 0.10 + 0.05 * i,
    hat: i > 0.15 ? 0.06 + 0.06 * i : 0,
    snare: i > 0.45 ? 0.12 : 0,
    arp: i > 0.3 ? 0.05 + 0.06 * i : 0,
  };
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** The voices (events) of each stem over one loop. */
function events(c) {
  const ev = { kick: [], bass: [], hat: [], snare: [], arp: [] };
  for (let step = 0; step < 16; step++) {
    const t = (step * c.stepMs) / 1000;
    const onBeat = step % 2 === 0;
    const beatInBar = Math.floor(step / 2) % 4;
    if (onBeat) ev.kick.push({ t, kind: 'blip', type: 'sine', freq: 120, freqEnd: 45, dur: 0.12 });
    if (!onBeat) ev.hat.push({ t, kind: 'noise', dur: 0.03, filter: 6000, q: 1 });
    if (onBeat && (beatInBar === 1 || beatInBar === 3)) ev.snare.push({ t, kind: 'noise', dur: 0.08, filter: 1800, q: 0.8 });
    const bass = c.bassLine[step];
    if (bass != null && onBeat) ev.bass.push({ t, kind: 'blip', type: 'sawtooth', freq: midi(bass), freqEnd: null, dur: 0.22 });
    const arp = c.arpLine[step];
    if (arp != null) ev.arp.push({ t, kind: 'blip', type: 'triangle', freq: midi(arp), freqEnd: null, dur: 0.1 });
  }
  return ev;
}

function wave(type, ph) {
  const p = ph - Math.floor(ph);
  if (type === 'sine') return Math.sin(2 * Math.PI * p);
  if (type === 'sawtooth') return 2 * p - 1;
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p; // triangle
}

/** RBJ high-pass biquad coefficients (Web Audio's BiquadFilterNode, Q as given). */
function highpass(freq, q, rate) {
  const w0 = (2 * Math.PI * freq) / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

/**
 * A renderer of the chart's five stems at `rate` Hz that works in slices
 * (`step(budget)` renders up to `budget` samples of voices and returns true
 * when every stem is done), so a frame's call stays short.
 */
export function stemRenderer(chart, rate = 22050) {
  const c = compose(chart);
  const length = Math.max(1, Math.round((c.loopMs / 1000) * rate));
  const ev = events(c);
  const stems = {};
  for (const s of STEMS) stems[s] = new Float32Array(length);
  const noiseRng = makeRng(streamSeed(chart.seed, 'music-noise'));
  // one job per voice; each renders its samples (wrapping past the loop end)
  const jobs = [];
  for (const s of STEMS) for (const e of ev[s]) jobs.push({ stem: s, e, n: 0, total: Math.ceil((e.dur + 0.02) * rate), ph: 0, z1: 0, z2: 0, x1: 0, x2: 0, bq: e.kind === 'noise' ? highpass(e.filter, e.q, rate) : null });
  let j = 0;
  function step(budget = 4000) {
    while (j < jobs.length && budget > 0) {
      const job = jobs[j];
      const { e } = job;
      const out = stems[job.stem];
      const start = Math.round(e.t * rate);
      const end = Math.min(job.total, job.n + budget);
      for (let n = job.n; n < end; n++) {
        const t = n / rate;
        let s;
        if (e.kind === 'blip') {
          // gain: 0 → 1 linearly over 4 ms, then exponentially to 0.0001 at dur; silent after the stop
          const g = t < 0.004 ? t / 0.004 : t < e.dur ? Math.pow(0.0001, (t - 0.004) / (e.dur - 0.004)) : 0;
          const f = e.freqEnd ? e.freq * Math.pow(e.freqEnd / e.freq, Math.min(1, t / e.dur)) : e.freq;
          s = wave(e.type, job.ph) * g;
          job.ph += f / rate;
        } else {
          if (t >= e.dur) { s = 0; } else {
            const x = noiseRng.next() * 2 - 1;
            const g = Math.pow(0.0001, t / e.dur);
            const b = job.bq;
            const y = b.b0 * x + b.b1 * job.x1 + b.b2 * job.x2 - b.a1 * job.z1 - b.a2 * job.z2;
            job.x2 = job.x1; job.x1 = x; job.z2 = job.z1; job.z1 = y;
            s = y * g;
          }
        }
        const k = (start + n) % length;
        out[k] += s;
      }
      budget -= end - job.n;
      job.n = end;
      if (job.n >= job.total) j++;
    }
    return j >= jobs.length;
  }
  return { compose: c, length, rate, stems, step, get done() { return j >= jobs.length; } };
}

const AMBIENT_CUTOFF = { deep: 220, water: 400, fire: 600, forest: 800, hall: 300 };
/**
 * The old ambience bed: 2 s of brown-ish noise (seeded) through a low-pass at
 * the theme's cutoff, at gain 0.35 (it looped on the ambience bus).
 */
export function ambience(kind, rate = 22050, seed = 1) {
  const len = rate * 2;
  const data = new Float32Array(len);
  const rng = makeRng(streamSeed(seed, 'ambience'));
  let last = 0;
  const freq = AMBIENT_CUTOFF[kind] || 250;
  // RBJ low-pass, Q = 1 (Web Audio's default)
  const w0 = (2 * Math.PI * freq) / rate, alpha = Math.sin(w0) / 2, cos = Math.cos(w0), a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0, a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < len; i++) {
    const white = rng.next() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    const x = last * 3.5;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y * 0.35;
  }
  return data;
}

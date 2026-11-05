// The track's music, as the browser build's js/audio.js composed it: pure (no
// audio API). native/audio.ts renders these voices with the engine's offline
// audio context and plays the stems.
//
// The composition is the old one, deterministic from the chart seed: a root
// note and two 16-step lines (bass and arpeggio) from the seed's 'music'
// stream, played on an eighth-note grid: a kick on every beat, the bass on
// beats, a hat on off-beats, a snare on beats 2 and 4 and the arpeggio. The
// old music was adaptive: hats came in past 0.15 intensity (combo / 60),
// the arpeggio past 0.3 and the snare past 0.45, and the bass, hat and
// arpeggio grew louder with it. Here each layer is one looping stem of the
// 16-step loop (8 beats) at unit level; native/audio.ts plays the five stems
// together, sample-aligned, and sets each one's gain from the intensity
// (layerGains), which is the old mix step for step.

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
export function events(c) {
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

/** The ambience bed's low-pass cutoff per theme. */
export const AMBIENT_CUTOFF = { deep: 220, water: 400, fire: 600, forest: 800, hall: 300 };

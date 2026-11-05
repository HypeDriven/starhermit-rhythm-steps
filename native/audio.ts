// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event — hit grades, the
// combo milestone every 25, hold ticks, misses, empty taps, the countdown,
// the results fanfares and UI clicks — the track's adaptive music and the
// theme's ambience bed, with the visual captions for meaningful sounds.
//
// The music is the old seeded composition (js/music.js), rendered once per
// chart by the engine's offline audio context into five looping stems (kick, bass, hat, snare, arpeggio) and played
// on the engine's synthesis graph as sample-aligned buffer sources started at
// one mixer time, each through a gain set from the combo intensity (the old
// adaptive layers). The run's clock is the fixed steps (session.ts), and the
// music follows it: the loop starts at the song position, and if the mixer's
// clock drifts from the steps by more than 35 ms (a slow page, a stall) the
// stems restart at the step clock's position — so what is heard stays on the
// beat the judgement uses, and the judgement stays deterministic.
//
// The oscillator blips the browser build played while a sample decoded are
// not ported (the samples all load at start; a cue before its clip is ready
// is skipped). Buses: hits,
// misses, the countdown and fanfares on "effects" (the old effects and voice
// buses), UI clicks on "interface", the music and ambience on "music" (the
// runtime has no ambience bus). The runtime's Options own the volumes, mute
// and the voice limit.
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioBuffer, type AudioBufferSourceNode, type AudioClip, type GainNode, type Sound } from "starhermit:audio";
import { streamSeed } from "../js/rng.js";
import { Music, type Chart, type Composition, type MusicVoice } from "./game.ts";

const SAMPLES = [
  "hit-perfect", "hit-great", "hit-good", "combo-milestone", "hold-tick", "miss", "empty-hit",
  "countdown-tick", "countdown-go", "ui-move", "ui-confirm", "ui-back", "ui-error", "fanfare-win", "fanfare-loss",
];
const clips = new Map<string, AudioClip>();
let suspended = false;
/** Loads every clip at once (onStart). */
export function loadSfx(): void {
  for (const name of SAMPLES) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** (text) => void: visual captions for meaningful audio (shown when the Captions option is on). */
export let onCaption: (key: string, vars?: Record<string, string | number>) => void = () => {};
export function setCaptionHandler(fn: typeof onCaption): void { onCaption = fn; }

function sample(name: string, bus: "effects" | "interface" = "effects"): void {
  if (suspended) return;
  const c = clips.get(name);
  if (!c) return;
  try { playClip(c, { bus }); }
  catch { /* the mixer is full this frame: skip it */ }
}

export function playHit(grade: string, combo: number): void {
  sample(grade === "perfect" ? "hit-perfect" : grade === "great" ? "hit-great" : "hit-good");
  if (combo > 0 && combo % 25 === 0) { sample("combo-milestone"); onCaption("Combo {n}!", { n: combo }); }
}
export function playHoldTick(): void { sample("hold-tick"); }
export function playMiss(): void { sample("miss"); onCaption("Miss"); }
export function playEmptyHit(): void { sample("empty-hit"); }
/** n = 3, 2, 1, then 0 for GO. */
export function playCountdown(n: number): void {
  sample(n === 0 ? "countdown-go" : "countdown-tick");
  onCaption(n === 0 ? "Go!" : String(n));
}
export function playUi(kind: "move" | "confirm" | "back" | "error" = "move"): void {
  sample(kind === "confirm" ? "ui-confirm" : kind === "back" ? "ui-back" : kind === "error" ? "ui-error" : "ui-move", "interface");
}
export function playResultFanfare(grade: string): void {
  const good = grade !== "D" && grade !== "F";
  sample(good ? "fanfare-win" : "fanfare-loss");
  onCaption(good ? "Track complete" : "Track ended");
}

// -- music ------------------------------------------------------------------------------------
const RATE = 22050;
interface Track { chart: Chart; compose: Composition; buffers: Record<string, AudioBuffer> | null }
let track: Track | null = null;
interface Voice { src: AudioBufferSourceNode; gain: GainNode; stem: string }
let voices: Voice[] = [];
let gains: Record<string, GainNode> = {};
let anchor: { mixer: number; song: number } | null = null;
let wantPlaying = false;
let songNow = 0;
let intensity = 0;
let drift = 0;
let sinceStart = 0;
let lastGains: Record<string, number> = {};

/** One stem at unit level: its voices over one loop, the tails wrapped to the start. */
async function renderStem(voices: MusicVoice[], loopMs: number, noiseSeed: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.round((loopMs / 1000) * RATE));
  const tail = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, length + tail, RATE);
  for (const e of voices) {
    const g = off.createGain();
    g.connect(off.destination);
    const end = e.t + e.dur;
    if (e.kind === "blip") {
      // gain: 0 → 1 linearly over 4 ms, then exponentially to 0.0001 at dur; silent after the stop
      g.gain.setValueAtTime(0, e.t);
      g.gain.linearRampToValueAtTime(1, e.t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      const osc = off.createOscillator();
      osc.type = e.type!;
      osc.frequency.setValueAtTime(e.freq!, e.t);
      if (e.freqEnd) osc.frequency.exponentialRampToValueAtTime(e.freqEnd, end);
      osc.connect(g);
      osc.start(e.t);
      osc.stop(end);
    } else {
      // noise: starts at its peak, decays to 0.0001 at dur, through a high-pass
      g.gain.setValueAtTime(1, e.t);
      g.gain.exponentialRampToValueAtTime(0.0001, end);
      const hp = off.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = e.filter!;
      hp.Q.value = 20 * Math.log10(e.q!); // the engine's Q is in dB, as Web Audio's
      hp.connect(g);
      const noise = off.createNoise({ seed: (noiseSeed + Math.round(e.t * RATE)) >>> 0, seconds: 1 });
      noise.connect(hp);
      noise.start(e.t);
      noise.stop(end);
    }
  }
  const r = (await off.startRendering()).getChannelData(0);
  const out = r.slice(0, length);
  for (let i = 0; i < tail; i++) out[i % length]! += r[length + i]!;
  const b = context.createBuffer(1, length, RATE);
  b.copyToChannel(out, 0);
  return b;
}
/** A run's music: renders its stems. */
export function prepareMusic(chart: Chart): void {
  if (track && track.chart.seed === chart.seed && track.chart.bpm === chart.bpm) return;
  stopMusic();
  const compose = Music.compose(chart);
  const t: Track = { chart, compose, buffers: null };
  track = t;
  const events = Music.events(compose);
  const noiseSeed = streamSeed(chart.seed, "music-noise") as number;
  void Promise.all(Music.STEMS.map((s) => renderStem(events[s] ?? [], compose.loopMs, noiseSeed))).then((list) => {
    const bufs: Record<string, AudioBuffer> = {};
    Music.STEMS.forEach((s, i) => { bufs[s] = list[i]!; });
    t.buffers = bufs;
  }, (e: unknown) => console.warn(`music: ${e instanceof Error ? e.message : String(e)}`));
}
/** The run's song is playing from `songMs` (fixed-step clock); call every frame with the position. */
export function startMusic(songMs: number): void { wantPlaying = true; songNow = songMs; drift = 0; }
export function setSongPosition(songMs: number): void { songNow = songMs; }
export function setIntensity(x: number): void { intensity = Math.max(0, Math.min(1, x)); }
export function stopMusic(): void {
  wantPlaying = false;
  stopVoices();
}
function stopVoices(): void {
  for (const v of voices) {
    try { v.src.stop(); } catch { /* not started */ }
    try { v.src.release(); v.gain.release(); } catch { /* released */ }
  }
  voices = [];
  gains = {};
  anchor = null;
  lastGains = {};
}
function startVoices(): void {
  if (!track?.buffers) return;
  stopVoices();
  const lead = 0.06;
  const when = context.currentTime + lead;
  const song = songNow + lead * 1000;
  const loopMs = track.compose.loopMs;
  const offset = (((song % loopMs) + loopMs) % loopMs) / 1000;
  const g = Music.layerGains(intensity);
  for (const stem of Music.STEMS) {
    const src = context.createBufferSource();
    src.buffer = track.buffers[stem]!;
    src.loop = true;
    const gain = context.createGain();
    gain.gain.value = g[stem]!;
    src.connect(gain).connect(context.bus("music"));
    src.start(when, offset);
    voices.push({ src, gain, stem });
    gains[stem] = gain;
  }
  lastGains = g;
  anchor = { mixer: when, song };
  sinceStart = 0;
  drift = 0;
}

// -- ambience ---------------------------------------------------------------------------------
const AMBIENCE_GAIN = 0.35;
const ambienceClips = new Map<string, AudioClip>();
let ambienceKind: string | null = null;
let ambienceVoice: Sound | null = null;
const ambienceRendering = new Set<string>();
/** The old bed: 2 s of brown noise through a low-pass at the theme's cutoff (Q 1), seamless. */
async function renderAmbience(kind: string): Promise<AudioClip> {
  const n = 2 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 7, seconds: 2 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = Music.AMBIENT_CUTOFF[kind] ?? 250;
  lp.Q.value = 0; // 0 dB: Q 1 linear, as the old filter
  const g = off.createGain();
  g.gain.value = AMBIENCE_GAIN;
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE); // filtered periodic noise is periodic once settled
}
/** The theme's quiet looping bed (null stops it). */
export function setAmbience(kind: string | null): void {
  if (kind === ambienceKind) return;
  ambienceKind = kind;
  try { ambienceVoice?.stop(); } catch { /* ended */ }
  ambienceVoice = null;
}

/** A hidden window: everything quiet. */
export function setSuspended(on: boolean): void {
  suspended = on;
  if (on) stopVoices();
  try { ambienceVoice?.fade(on ? 0 : 1, 0.1); } catch { /* the mixer restarted */ }
}

/** Each frame once the mixer runs: the music's start, sync and levels, the ambience. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantPlaying && !suspended && track?.buffers) {
    if (!anchor) startVoices();
    else {
      // the mixer's song position against the step clock's
      const heard = anchor.song + (context.currentTime - anchor.mixer) * 1000;
      drift = drift * 0.85 + (heard - songNow) * 0.15;
      if (++sinceStart > 20 && Math.abs(drift) > 35) startVoices();
      const g = Music.layerGains(intensity);
      for (const s of Music.STEMS) {
        if (g[s] !== lastGains[s] && gains[s]) {
          try { gains[s]!.gain.setTargetAtTime(g[s]!, context.currentTime, 0.04); } catch { /* bounds */ }
        }
      }
      lastGains = g;
    }
  }
  if (ambienceKind && !ambienceVoice && !suspended) {
    const kind = ambienceKind;
    const clip = ambienceClips.get(kind);
    if (clip) { try { ambienceVoice = playClip(clip, { bus: "music", loop: true }); } catch { ambienceVoice = null; } }
    else if (!ambienceRendering.has(kind)) {
      ambienceRendering.add(kind);
      renderAmbience(kind).then((c) => { ambienceClips.set(kind, c); }, (e: unknown) => console.warn(`ambience: ${String(e)}`));
    }
  }
}

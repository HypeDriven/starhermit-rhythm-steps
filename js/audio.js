// Audio: authored sample one-shots (sfx/*.opus) with original procedural
// WebAudio synthesis as fallback — no sampled or licensed content beyond the
// authored clips. Buses: music / effects / ambience / voice, each independently
// mixed. Event sounds are short transients tied to logical game events.
// Music is generated from the chart seed so replays sound identical.

import { makeRng, streamSeed } from './rng.js';

const PENTA = [0, 2, 4, 7, 9]; // minor pentatonic degrees

// Authored sample one-shots (sfx/<name>.opus, see sfx/manifest.json) mapped
// onto existing logical events. Samples are lazy-fetched/decoded after the
// user-gesture unlock; the synthesized voices below remain the fallback while
// a sample is still loading or if it fails to load.
const SAMPLE_EVENTS = [
  'hit-perfect', 'hit-great', 'hit-good', 'combo-milestone',
  'hold-tick', 'miss', 'empty-hit',
  'countdown-tick', 'countdown-go',
  'ui-move', 'ui-confirm', 'ui-back', 'ui-error',
  'fanfare-win', 'fanfare-loss',
];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.musicTimer = null;
    this.musicState = null;
    this.ambienceNodes = null;
    this.onCaption = null; // (text) => void — visual captions for meaningful audio
    this.captionsEnabled = true;
    this.settings = { volMusic: 0.8, volEffects: 0.9, volAmbience: 0.5, volVoice: 0.8, muted: false };
    this._sfxVariantRng = null;
    this._sampleCache = new Map(); // name -> { buffer: AudioBuffer|null, failed: boolean }
  }

  // Must be called from a user gesture.
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.master = master;
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.connect(master);
      this.buses[bus] = g;
    }
    this.applySettings(this.settings);
  }

  get ready() { return !!this.ctx; }

  applySettings(s) {
    this.settings = { ...this.settings, ...s };
    if (!this.ctx) return;
    this.master.gain.value = this.settings.muted ? 0 : 1;
    this.buses.music.gain.value = this.settings.volMusic;
    this.buses.effects.gain.value = this.settings.volEffects;
    this.buses.ambience.gain.value = this.settings.volAmbience;
    this.buses.voice.gain.value = this.settings.volVoice;
  }

  caption(text) {
    if (this.captionsEnabled && this.onCaption) this.onCaption(text);
  }

  // -------------------------------------------------------------------------
  // Primitive voices
  // -------------------------------------------------------------------------
  _blip(bus, { freq = 440, freqEnd = null, type = 'sine', dur = 0.08, gain = 0.3, at = 0, detune = 0 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (detune) osc.detune.value = detune;
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  _noise(bus, { dur = 0.1, gain = 0.2, at = 0, filterFreq = 3000, q = 1, type = 'highpass' }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + at;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Seeded variants when recording matters (replay consistency).
    const rng = this._sfxVariantRng;
    for (let i = 0; i < len; i++) data[i] = rng ? rng.next() * 2 - 1 : Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = filterFreq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t0);
  }

  // -------------------------------------------------------------------------
  // Authored sample playback (lazy fetch/decode/cache, effects bus).
  // -------------------------------------------------------------------------
  _sampleEntry(name) {
    if (!this.ctx || !SAMPLE_EVENTS.includes(name)) return null;
    let e = this._sampleCache.get(name);
    if (!e) {
      e = { buffer: null, failed: false };
      this._sampleCache.set(name, e);
      fetch(`sfx/${name}.opus`)
        .then((r) => { if (!r.ok) throw new Error(`sfx ${name}: HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => { e.buffer = buf; })
        .catch(() => { e.failed = true; });
    }
    return e;
  }

  // Plays sfx/<name>.opus on the effects bus if decoded; returns false while
  // loading or after failure so the caller falls back to synthesis.
  _playSample(name) {
    const e = this._sampleEntry(name);
    if (!e || !e.buffer) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = e.buffer;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  // -------------------------------------------------------------------------
  // Game event sounds (event hierarchy: ack < hit < combo/goal < completion)
  // -------------------------------------------------------------------------
  setSfxSeed(seed) { this._sfxVariantRng = makeRng(streamSeed(seed, 'sfx')); }

  playHit(grade, combo = 0) {
    if (!this.ctx) return;
    const fx = this.buses.effects;
    const key = grade === 'perfect' ? 'hit-perfect' : grade === 'great' ? 'hit-great' : 'hit-good';
    if (!this._playSample(key)) {
      const v = this._sfxVariantRng ? this._sfxVariantRng.next() : Math.random();
      if (grade === 'perfect') {
        this._blip(fx, { freq: 880 * (1 + v * 0.02), freqEnd: 1320, type: 'triangle', dur: 0.1, gain: 0.28 });
        this._blip(fx, { freq: 1760, type: 'sine', dur: 0.07, gain: 0.12, at: 0.01 });
      } else if (grade === 'great') {
        this._blip(fx, { freq: 660 * (1 + v * 0.03), freqEnd: 880, type: 'triangle', dur: 0.09, gain: 0.24 });
      } else {
        this._blip(fx, { freq: 440, freqEnd: 520, type: 'square', dur: 0.06, gain: 0.12 });
      }
    }
    if (combo > 0 && combo % 25 === 0) { // combo milestone tier
      if (!this._playSample('combo-milestone')) {
        this._blip(fx, { freq: 1046, freqEnd: 2093, type: 'sine', dur: 0.25, gain: 0.2, at: 0.02 });
      }
      this.caption(`Combo ${combo}!`);
    }
  }

  playHoldTick() {
    if (!this.ctx) return;
    if (!this._playSample('hold-tick')) {
      this._blip(this.buses.effects, { freq: 1200, type: 'sine', dur: 0.03, gain: 0.05 });
    }
  }

  playMiss() {
    if (!this.ctx) return;
    if (!this._playSample('miss')) {
      this._blip(this.buses.effects, { freq: 220, freqEnd: 110, type: 'sawtooth', dur: 0.18, gain: 0.16 });
      this._noise(this.buses.effects, { dur: 0.12, gain: 0.1, filterFreq: 800, type: 'lowpass' });
    }
    this.caption('Miss');
  }

  playEmptyHit() {
    if (!this.ctx) return;
    if (!this._playSample('empty-hit')) {
      this._noise(this.buses.effects, { dur: 0.05, gain: 0.06, filterFreq: 2500 });
    }
  }

  playCountdown(n) {
    if (!this.ctx) return;
    if (!this._playSample(n === 0 ? 'countdown-go' : 'countdown-tick')) {
      const freq = n === 0 ? 880 : 440;
      this._blip(this.buses.voice, { freq, type: 'sine', dur: n === 0 ? 0.3 : 0.12, gain: 0.3 });
    }
    this.caption(n === 0 ? 'Go!' : String(n));
  }

  playUi(kind = 'move') {
    if (!this.ctx) return;
    const key = { confirm: 'ui-confirm', back: 'ui-back', error: 'ui-error' }[kind] || 'ui-move';
    if (this._playSample(key)) return;
    if (kind === 'confirm') this._blip(this.buses.effects, { freq: 620, freqEnd: 930, type: 'sine', dur: 0.07, gain: 0.15 });
    else if (kind === 'back') this._blip(this.buses.effects, { freq: 500, freqEnd: 330, type: 'sine', dur: 0.07, gain: 0.12 });
    else if (kind === 'error') this._blip(this.buses.effects, { freq: 200, type: 'square', dur: 0.08, gain: 0.1 });
    else this._blip(this.buses.effects, { freq: 540, type: 'sine', dur: 0.04, gain: 0.08 });
  }

  playResultFanfare(gradeLetter) {
    if (!this.ctx) return;
    const good = !['D', 'F'].includes(gradeLetter);
    if (!this._playSample(good ? 'fanfare-win' : 'fanfare-loss')) {
      const root = good ? 523.25 : 392;
      const seq = good ? [1, 1.25, 1.5, 2] : [1, 0.94, 0.89];
      seq.forEach((ratio, i) => {
        this._blip(this.buses.voice, { freq: root * ratio, type: 'triangle', dur: 0.35, gain: 0.22, at: i * 0.12 });
      });
    }
    this.caption(good ? 'Track complete' : 'Track ended');
  }

  // -------------------------------------------------------------------------
  // Adaptive procedural music. Layered stems: kick / hat / bass / arp.
  // Layers follow intensity (combo-driven), scheduled with lookahead against
  // the AudioContext clock so gameplay timing is sample-consistent.
  // -------------------------------------------------------------------------
  startMusic(chart, { intensity = 0, startAtMs = 0 } = {}) {
    if (!this.ctx) return;
    this.stopMusic();
    const rng = makeRng(streamSeed(chart.seed, 'music'));
    const rootMidi = 36 + rng.int(0, 5);
    const beatMs = 60000 / chart.bpm;
    // Pre-compose a deterministic 8-bar loop.
    const bassLine = [], arpLine = [];
    for (let i = 0; i < 16; i++) {
      bassLine.push(rng.chance(0.7) ? rootMidi + rng.pick(PENTA) : null);
      arpLine.push(rng.chance(0.6) ? rootMidi + 24 + rng.pick(PENTA) + rng.pick([0, 12]) : null);
    }
    const stepMs = beatMs / 2;
    const startCtxTime = this.ctx.currentTime + 0.05 - startAtMs / 1000;
    this.musicState = {
      chart, beatMs, rootMidi, bassLine, arpLine,
      step: Math.floor(startAtMs / stepMs),
      nextTime: this.ctx.currentTime + 0.05,
      startCtxTime,
      intensity,
      stepMs, // eighth-note grid
    };
    this.musicTimer = setInterval(() => this._schedule(), 40);
  }

  setIntensity(x) { if (this.musicState) this.musicState.intensity = Math.max(0, Math.min(1, x)); }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
    this.musicState = null;
  }

  // Song position in ms derived from the audio clock (authoritative for play).
  songTimeMs() {
    const m = this.musicState;
    if (!m || !this.ctx) return null;
    return Math.max(0, (this.ctx.currentTime - m.startCtxTime) * 1000);
  }

  _schedule() {
    const m = this.musicState;
    if (!m || !this.ctx) return;
    const ahead = 0.15; // 150 ms lookahead
    while (m.nextTime < this.ctx.currentTime + ahead) {
      const at = Math.max(0, m.nextTime - this.ctx.currentTime);
      this._scheduleStep(m, m.step, at);
      m.step++;
      m.nextTime += m.stepMs / 1000;
    }
  }

  _midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  _scheduleStep(m, step, at) {
    const music = this.buses.music;
    const eighth = step % 16;
    const onBeat = step % 2 === 0;
    const beatInBar = Math.floor(step / 2) % 4;
    const inten = m.intensity;
    // Kick on beats (always — anchors timing).
    if (onBeat) this._blip(music, { freq: 120, freqEnd: 45, type: 'sine', dur: 0.12, gain: 0.4, at });
    // Hat on off-beats when intensity rises.
    if (!onBeat && inten > 0.15) this._noise(music, { dur: 0.03, gain: 0.06 + 0.06 * inten, at, filterFreq: 6000 });
    // Snare-ish accent on beats 2 and 4 at higher intensity.
    if (onBeat && (beatInBar === 1 || beatInBar === 3) && inten > 0.45) {
      this._noise(music, { dur: 0.08, gain: 0.12, at, filterFreq: 1800, q: 0.8 });
    }
    // Bass line.
    const bass = m.bassLine[eighth];
    if (bass != null && onBeat) {
      this._blip(music, { freq: this._midi(bass), type: 'sawtooth', dur: 0.22, gain: 0.10 + 0.05 * inten, at });
    }
    // Arp layer only at high intensity (adaptive stem).
    const arp = m.arpLine[eighth];
    if (arp != null && inten > 0.3) {
      this._blip(music, { freq: this._midi(arp), type: 'triangle', dur: 0.1, gain: 0.05 + 0.06 * inten, at });
    }
  }

  // -------------------------------------------------------------------------
  // Ambience: quiet looping noise bed, themed.
  // -------------------------------------------------------------------------
  startAmbience(kind = 'deep') {
    if (!this.ctx || this.ambienceNodes) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown-ish noise
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = { deep: 220, water: 400, fire: 600, forest: 800, hall: 300 }[kind] || 250;
    const g = this.ctx.createGain();
    g.gain.value = 0.35;
    src.connect(f).connect(g).connect(this.buses.ambience);
    src.start();
    this.ambienceNodes = { src, g };
  }

  stopAmbience() {
    if (this.ambienceNodes) {
      try { this.ambienceNodes.src.stop(); } catch { /* already stopped */ }
      this.ambienceNodes = null;
    }
  }

  suspendAll() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resumeAll() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}

export const audio = new AudioEngine();

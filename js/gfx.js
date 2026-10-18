// Graphics quality model: presets, per-category overrides, StarHermit hardware-level
// detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js) so the settings panel, the renderer and the
// unit tests agree on what a setting means. Quality tiers never alter rules,
// timing windows or the visibility of notes.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  particles: ['low', 'high'],        // hit sparks + drifting light motes
  background: ['static', 'animated'], // arch drift, sky shimmer, beat-pulsing pylons, lane flow
  detail: ['plain', 'detailed'],      // sky dome, lane surface texture, floor grid, pylon caps
};

// Each preset is a row of tiers, a render scale and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', particles: 'high', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Lanes, notes, timing
 * windows and hit areas are identical on every preset — only visuals change.
 *   material  gem, receptor, lane and pylon shading: lambert (Low) / standard (Balanced) / physical
 *             clear-coated gems (High, Ultra)
 *   segments  round-geometry detail: receptor discs and beat rings (sky dome and light arches scale with it)
 *   laneTex   brushed-glass lane texture height in px (width ¼ of it; floor grid ½ of it; Detail on)
 *   stars     sky-dust points (Detail on; Detail off draws at most 200)
 *   sparks    hit-spark pool at Particles "high", scaled with the level
 *   motes     drifting light motes at Particles "high", scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', segments: 16, laneTex: 128, stars: 200, sparks: 120, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', segments: 24, laneTex: 256, stars: 400, sparks: 200, motes: 100, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', segments: 32, laneTex: 256, stars: 700, sparks: 320, motes: 160, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', segments: 48, laneTex: 512, stars: 1000, sparks: 480, motes: 240, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 640;
export const MOTE_MAX = 320;

/** A preset's concrete budget for a hardware level (particle counts scale ≤ 1.5× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(1.5, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset, auto,
    scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2),
    dprCap: row.dprCap,
  };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas renders directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every override but keeps scale/adaptive/fps prefs. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = s.render_scale;
  if (s.adaptive != null) out.adaptive = s.adaptive;
  if (s.show_fps != null) out.show_fps = s.show_fps;
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) { return TABLE[preset]?.[cat]; }

const WORDS = { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion', bloom: 'bloom', sparks: 'sparks', noAA: 'no anti-aliasing' };

/** Cost summary; `words` localizes the terms (defaults to English). */
export function describe(r, pixels, words = WORDS) {
  const w = { ...WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoFull : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.particles === 'high' ? w.sparks : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

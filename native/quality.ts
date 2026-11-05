// The look per graphics level. The engine owns its effects through
// levelSettings(): shadows and their map size, AO, bloom, grade and
// anti-aliasing come from the frame's level. The game keeps its art per quality
// tier (frame().quality): shading, detail, and the hit sparks and light motes,
// scaled within the tier by the level's particle budget (at most 1.5×). Lanes,
// notes, timing windows and hit areas are identical on every tier: only visuals
// change. The runtime owns the rest of the old Graphics panel: Auto and the
// level choice, render scale and the pixel-ratio cap, adaptive resolution, the
// frame-rate limit and the FPS readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Gem, receptor, lane and pylon shading: Lambert (Low), standard (Balanced), clear-coated physical (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Round-geometry detail: receptor discs and beat rings (sky dome and light arches scale with it). */
  segments: number;
  /** Brushed-glass lane texture height in px (width ¼; floor grid ½; detail on). */
  laneTex: number;
  /** Sky-dust stars (detail on; detail off draws at most 200). */
  stars: number;
  sparks: number;
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Hit sparks and drifting light motes. */
  particles: "low" | "high";
  /** Arch drift, sky shimmer, beat-pulsing pylon caps, lane flow. */
  animated: boolean;
  /** Sky dome, IBL reflections, textured lanes, floor grid, pylon caps, all pylons and arches. */
  detailed: boolean;
  budget: Budget;
}

type Art = Pick<Look, "particles" | "animated" | "detailed">;
const ART: Record<QualityTier, Art> = {
  low: { particles: "low", animated: false, detailed: false },
  balanced: { particles: "high", animated: true, detailed: true },
  high: { particles: "high", animated: true, detailed: true },
  ultra: { particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", segments: 16, laneTex: 128, stars: 200, sparks: 120, motes: 60 },
  balanced: { material: "standard", segments: 24, laneTex: 256, stars: 400, sparks: 200, motes: 100 },
  high: { material: "physical", segments: 32, laneTex: 256, stars: 700, sparks: 320, motes: 160 },
  ultra: { material: "physical", segments: 48, laneTex: 512, stars: 1000, sparks: 480, motes: 240 },
};
export const SPARK_MAX = 640;
export const MOTE_MAX = 320;
export const STAR_MAX = 1000;
/** The level each tier's budgets were tuned at. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level's settings (plain data, compared by applyLook). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}

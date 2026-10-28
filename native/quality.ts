// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the hit sparks and light motes scaled within the tier by the level
// (frame().levelIndex, at most 1.5×), as the browser build scaled them by its
// hardware level. Lanes, notes, timing windows and hit areas are identical on
// every tier — only visuals change. The runtime owns the rest of the old
// Graphics panel: Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and the FPS readout. The
// panel's per-category overrides are not offered (Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", particles: "low", animated: false, detailed: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", particles: "high", animated: true, detailed: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", particles: "high", animated: true, detailed: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", segments: 16, laneTex: 128, stars: 200, sparks: 120, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", segments: 24, laneTex: 256, stars: 400, sparks: 200, motes: 100, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", segments: 32, laneTex: 256, stars: 700, sparks: 320, motes: 160, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", segments: 48, laneTex: 512, stars: 1000, sparks: 480, motes: 240, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 640;
export const MOTE_MAX = 320;
export const STAR_MAX = 1000;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}

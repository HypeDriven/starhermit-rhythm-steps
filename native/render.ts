// The reactive concert causeway on starhermit:scene, as the browser build's
// js/render3d.js drew it with three.js r160: the sky dome (gradient, a
// horizon glow swelling on the beat, a slow aurora shimmer; WGSL), the
// metallic floor far below with its emissive grid, four brushed-glass lanes
// whose beat rungs flow with the notes, the light-strip lane edges, the
// judgment line breathing on the beat, the glossy receptors that flash and
// swell on presses, the clear-coated gem notes and glowing hold bars, the
// instanced pylons with beat-pulsing caps, the light arches drifting toward
// the camera, the sky dust, the hit pulse rings and sparks, the drifting
// light motes, the authored portrait / landscape framing with seeded sway
// and the tiered shake. Rendering reads the rules state only.
//
// From three.js r160: punctual light intensities are ÷ π (the engine's light
// units, r155+ physical lights); the sky ShaderMaterial is WGSL; the
// reflections are `new RoomEnvironment(renderer)` prefiltered as before, and
// each lit material takes it as its own envMap at its old envMapIntensity (at
// engine.minor 20 the scene's environment ignores per-material intensities,
// as three.js r163+ does; r160 used them); the key light's fitted shadow box
// is the engine's shadow distance and its world-unit normal bias is texels;
// the post chain (GTAOPass, UnrealBloomPass 0.5 / 0.4 / 0.9, the grade
// before the output, FXAA / SMAA / MSAA) is renderer.ao / bloom / grade /
// antialias; canvas textures are OffscreenCanvas. The invisible pick plane is
// a ray–plane intersection. The 2D fallback renderer for browsers without
// WebGL is gone (the runtime draws wherever it runs).
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, DynamicDrawUsage, FogExp2, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OctahedronGeometry, PerspectiveCamera, Plane, PlaneGeometry, PMREMGenerator,
  Points, PointsMaterial, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, ShaderMaterial, SphereGeometry, SRGBColorSpace, TorusGeometry,
  Vector2, Vector3, pointerToNdc, renderer, scene, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { makeRng, streamSeed } from "../js/rng.js";
import { Content, type Note, type Theme } from "./game.ts";
import { MOTE_MAX, SPARK_MAX, STAR_MAX, type Look } from "./quality.ts";

const PI = Math.PI;
export const LANES = 4;
const LANE_W = 1.7;
const TRACK_LEN = 64;
const RECEPTOR_Z = 0;
const NOTE_Y = 0.12;
const FRAMING = {
  portrait: { camPos: [0, 9.2, 12.5], lookAt: [0, 1.8, -15], fov: 56 },
  landscape: { camPos: [0, 7.5, 11.5], lookAt: [0, 1.4, -14], fov: 50 },
};
const GRADE_COLORS: Record<string, number> = { perfect: 0xfff6a8, great: 0x7dffb0, good: 0x8ab8ff, miss: 0x666a75 };
type Rng = { next(): number };
const rngOf = (seed: number, name: string): Rng => (makeRng as (s: number) => Rng)((streamSeed as (s: number, n: string) => number)(seed, name));
const laneXOf = (lane: number): number => (lane - (LANES - 1) / 2) * LANE_W;

// -- renderer, camera, lights ------------------------------------------------------------------
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 300);
renderer.camera = camera;
const keyLight = new DirectionalLight(0xbfd8ff, 2.2 / PI);
keyLight.position.set(2.5, 22, -6);
keyLight.target.position.set(0, 0, -12);
// the old box (lanes wide, 24 m ahead to 18 m behind the line) is the engine's view distance
keyLight.shadow.distance = 42;
keyLight.shadow.bias = -0.0008;
keyLight.shadow.normalBias = 1.5;
const hemi = new HemisphereLight(0x0a1024, 0x05070f, 0.9 / PI);
const rimLight = new DirectionalLight(0x35e0ff, 0.3 / PI);
rimLight.position.set(0, 3, -30);
scene.add(keyLight, keyLight.target, hemi, rimLight);

// -- procedural textures -------------------------------------------------------------------------
function laneTexture(height: number): Texture {
  const c = new OffscreenCanvas(height / 4, height);
  const g = c.getContext("2d");
  g.scale(height / 256, height / 256);
  const rng = rngOf(7, "lane-tex");
  g.fillStyle = "#7c8699";
  g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 900; i++) { // fine brushed-glass grain
    const v = 140 + Math.floor(rng.next() * 60);
    g.fillStyle = `rgba(${v},${v + 8},${v + 20},0.35)`;
    g.fillRect(rng.next() * 64, rng.next() * 256, 1, 2 + rng.next() * 6);
  }
  for (let k = 0; k < 4; k++) { // beat rungs: one bright + three faint per tile
    g.fillStyle = k === 0 ? "rgba(255,255,255,0.7)" : "rgba(230,240,255,0.3)";
    g.fillRect(0, k * 64, 64, k === 0 ? 3 : 1);
  }
  g.fillStyle = "rgba(255,255,255,0.5)";
  g.fillRect(0, 0, 2, 256); g.fillRect(62, 0, 2, 256);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  t.repeat.set(1, 24);
  return t;
}
function gridTexture(size: number): Texture {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext("2d");
  g.scale(size / 128, size / 128);
  g.fillStyle = "#000";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.lineWidth = 2;
  g.strokeRect(0, 0, 128, 128);
  g.strokeStyle = "rgba(255,255,255,0.25)";
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(64, 0); g.lineTo(64, 128); g.moveTo(0, 64); g.lineTo(128, 64); g.stroke();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(40, 40);
  t.anisotropy = 4;
  return t;
}
function sparkSprite(): Texture {
  const c = new OffscreenCanvas(32, 32);
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(c);
}

// -- the sky dome (WGSL port of SKY_FRAG) --------------------------------------------------------
const SKY_FRAG = /* wgsl */ `
fn rsHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn rsNoise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rsHash(i), rsHash(i + vec2f(1.0, 0.0)), f.x), mix(rsHash(i + vec2f(0.0, 1.0)), rsHash(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world - uniforms.uCenter);
  let h = clamp(d.y, -0.2, 1.0);
  var c = mix(uniforms.uHorizon, uniforms.uTop, smoothstep(0.0, 0.55, h));
  let band = exp(-abs(h - 0.02) * 9.0);
  let centre = exp(-abs(d.x) * 1.6) * step(d.z, 0.0);
  c = c + uniforms.uGlow * band * (0.35 + 0.9 * centre) * (0.85 + 0.3 * uniforms.uBeat);
  var a = rsNoise(vec2f(d.x * 3.0 + uniforms.uTime * 0.03, h * 6.0 - uniforms.uTime * 0.02));
  a = a * rsNoise(vec2f(d.x * 7.0 - uniforms.uTime * 0.05, h * 11.0));
  c = c + uniforms.uGlow * 0.22 * a * smoothstep(0.05, 0.35, h) * (1.0 - smoothstep(0.45, 0.9, h));
  return vec4f(c, 1.0);
}`;

// -- state ---------------------------------------------------------------------------------------
let look: Look | null = null;
let theme: Theme = Content.getTheme("neon-causeway");
let cvd = false;
let mirror = false;
let reducedMotion = false;
let cameraSway = true;
let noteSpeed = 1;
let seed = 1;
let time = 0;
let beat = 0;
let shake = 0;
let swayPhase = 0;
let rng: Rng = rngOf(1, "visual");
let fxRng: Rng = rngOf(1, "sparks");
const laneFlash = [0, 0, 0, 0];
const laneHeld = [false, false, false, false];
let envMap: Texture | null = null;
let portrait = false;

const skyU = {
  uTop: { value: new Color() }, uHorizon: { value: new Color() }, uGlow: { value: new Color() },
  uTime: { value: 0 }, uBeat: { value: 0 }, uCenter: { value: new Vector3() },
};
const sky = new Mesh(new SphereGeometry(200, 32, 16), new ShaderMaterial({ uniforms: skyU, fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false, fog: false }));
sky.renderOrder = -1;
sky.noAO = true;
scene.add(sky);

type Lit = MeshLambertMaterial | MeshStandardMaterial | MeshPhysicalMaterial;
interface Spec {
  color: number; emissive: number; emissiveIntensity: number; roughness: number; metalness: number; envMapIntensity: number;
  clearcoat?: number; clearcoatRoughness?: number; transparent?: boolean; opacity?: number; flatShading?: boolean;
}
/** Lambert (Low), standard (Balanced) or clear-coated physical (High, Ultra), as tieredMaterial(). */
function tiered(spec: Spec): Lit {
  const { roughness, metalness, envMapIntensity, clearcoat, clearcoatRoughness, ...base } = spec;
  const tier = look?.budget.material ?? "standard";
  if (tier === "lambert") return new MeshLambertMaterial(base);
  const pbr = { ...base, roughness, metalness, envMapIntensity };
  if (tier === "physical" && clearcoat !== undefined) return new MeshPhysicalMaterial({ ...pbr, clearcoat, clearcoatRoughness: clearcoatRoughness ?? 0 });
  return new MeshStandardMaterial(pbr);
}
const noteColor = (): number => (cvd ? Content.CVD_PALETTE.note : theme.note);
const holdColor = (): number => (cvd ? Content.CVD_PALETTE.hold : theme.hold);
const edgeColor = (): number => (cvd ? Content.CVD_PALETTE.laneEdge : theme.laneEdge);
const receptorColor = (): number => (cvd ? Content.CVD_PALETTE.receptor : theme.receptor);
function spec(role: "lane" | "receptor" | "note" | "hold" | "pylon"): Spec {
  const t = theme;
  if (role === "lane") return { color: t.lane, roughness: 0.6, metalness: 0.45, envMapIntensity: 0.08, emissive: edgeColor(), emissiveIntensity: 0.06 };
  if (role === "receptor") return { color: 0x0a0a12, roughness: 0.25, metalness: 0.85, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.6, emissive: receptorColor(), emissiveIntensity: 0.7 };
  if (role === "note") return { color: noteColor(), roughness: 0.12, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.1, emissive: noteColor(), emissiveIntensity: 1.0 };
  if (role === "hold") return { color: holdColor(), roughness: 0.2, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 0.8, emissive: holdColor(), emissiveIntensity: 0.95, transparent: true, opacity: 0.95 };
  return { color: t.env, roughness: 0.45, metalness: 0.5, envMapIntensity: 0.4, emissive: t.env, emissiveIntensity: 0.25, flatShading: true };
}
const hdr = (c: Color, hex: number, k: number): Color => c.set(hex).multiplyScalar(k);

// -- the scene's meshes (built once; materials swap with the look's shading tier) ---------------
let segments = 32;
const floorMat = new MeshStandardMaterial({ color: 0x05070c, roughness: 0.3, metalness: 0.85, envMapIntensity: 0.15, emissive: theme.env, emissiveIntensity: 0.9 });
const floor = new Mesh(new PlaneGeometry(400, 400), floorMat);
floor.rotation.x = -PI / 2;
floor.position.set(0, -1.2, -60);
floor.receiveShadow = true;
scene.add(floor);
let gridTex: Texture | null = null;
let laneTex: Texture | null = null;
let texBudget = 0;

const laneGeo = new BoxGeometry(LANE_W - 0.12, 0.08, TRACK_LEN + 8);
const laneMeshes: Mesh[] = [];
let laneMats: Lit[] = [];
const edgeMat = new MeshBasicMaterial();
const edges: Mesh[] = [];
const judgeLine = new Mesh(new BoxGeometry(LANE_W * LANES + 0.4, 0.12, 0.18), new MeshBasicMaterial());
judgeLine.position.set(0, 0.08, RECEPTOR_Z);
scene.add(judgeLine);
const receptors: Mesh[] = [];
interface PoolItem { mesh: Mesh; mat: Lit; inUse: boolean; noteId: number }
const notePool: PoolItem[] = [];
const holdPool: PoolItem[] = [];
let pylonMat: Lit;
let pylons: InstancedMesh;
const capMat = new MeshBasicMaterial();
let caps: InstancedMesh;
const PYLONS = 24;
const arches: Mesh[] = [];
let stars: Points;
interface Pulse { mesh: Mesh; mat: MeshBasicMaterial; age: number; active: boolean; strength: number }
const pulsePool: Pulse[] = [];
let sparks: Points;
const sparkPos = new Float32Array(SPARK_MAX * 3), sparkCol = new Float32Array(SPARK_MAX * 3), sparkVel = new Float32Array(SPARK_MAX * 3);
const sparkLife = new Float32Array(SPARK_MAX), sparkBase = new Float32Array(SPARK_MAX * 3);
let sparkNext = 0, sparkCap = 0, sparksDirty = false;
let motes: Points;
const motePos = new Float32Array(MOTE_MAX * 3);
const moteMat = new PointsMaterial({ size: 0.16, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true });
let moteCount = 0;
const sprite = sparkSprite();
moteMat.map = sprite;

function build(): void {
  for (let i = 0; i < LANES; i++) {
    const mat = tiered(spec("lane"));
    const m = new Mesh(laneGeo, mat);
    m.position.set(laneXOf(i), 0, -TRACK_LEN / 2 + 4);
    m.receiveShadow = true;
    scene.add(m);
    laneMeshes.push(m);
    laneMats.push(mat);
  }
  const edgeGeo = new BoxGeometry(0.05, 0.1, TRACK_LEN + 8);
  for (let i = 0; i <= LANES; i++) {
    const e = new Mesh(edgeGeo, edgeMat);
    e.position.set(laneXOf(0) - LANE_W / 2 + i * LANE_W, 0.02, -TRACK_LEN / 2 + 4);
    scene.add(e);
    edges.push(e);
  }
  const recGeo = new CylinderGeometry(0.55, 0.62, 0.1, segments);
  for (let i = 0; i < LANES; i++) {
    const r = new Mesh(recGeo, tiered(spec("receptor")));
    r.position.set(laneXOf(i), 0.1, RECEPTOR_Z);
    r.castShadow = true;
    scene.add(r);
    receptors.push(r);
  }
  const tapGeo = new OctahedronGeometry(0.5);
  tapGeo.scale(1, 0.55, 1);
  for (let i = 0; i < 48; i++) {
    const mat = tiered(spec("note"));
    const m = new Mesh(tapGeo, mat);
    m.visible = false;
    m.castShadow = true;
    scene.add(m);
    notePool.push({ mesh: m, mat, inUse: false, noteId: -1 });
  }
  const holdGeo = new BoxGeometry(0.5, 0.16, 1);
  for (let i = 0; i < 16; i++) {
    const mat = tiered(spec("hold"));
    const m = new Mesh(holdGeo, mat);
    m.visible = false;
    m.castShadow = true;
    scene.add(m);
    holdPool.push({ mesh: m, mat, inUse: false, noteId: -1 });
  }
  pylonMat = tiered(spec("pylon"));
  pylons = new InstancedMesh(new CylinderGeometry(0.3, 0.55, 7, 6), pylonMat, PYLONS * 2);
  caps = new InstancedMesh(new OctahedronGeometry(0.24), capMat, PYLONS * 2);
  scene.add(pylons, caps);
  const archGeo = new TorusGeometry(LANE_W * LANES * 0.62, 0.09, Math.max(6, segments / 4), segments * 1.5, PI);
  for (let i = 0; i < 8; i++) {
    const a = new Mesh(archGeo, new MeshBasicMaterial({ transparent: true, opacity: 0.65, depthWrite: false }));
    a.position.set(0, 0, -18 - i * 16);
    scene.add(a);
    arches.push(a);
  }
  const sg = new BufferGeometry();
  sg.setAttribute("position", new BufferAttribute(new Float32Array(STAR_MAX * 3), 3));
  stars = new Points(sg, new PointsMaterial({ color: 0xafc8ff, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.8, fog: false }));
  scene.add(stars);
  const pulseGeo = new RingGeometry(0.5, 0.58, segments);
  pulseGeo.rotateX(-PI / 2);
  for (let i = 0; i < 12; i++) {
    const mat = new MeshBasicMaterial({ color: theme.receptor, transparent: true, opacity: 0, side: DoubleSide, depthWrite: false });
    const p = new Mesh(pulseGeo, mat);
    p.visible = false;
    p.noAO = true;
    scene.add(p);
    pulsePool.push({ mesh: p, mat, age: 0, active: false, strength: 1 });
  }
  const g = new BufferGeometry();
  for (let i = 0; i < SPARK_MAX; i++) sparkPos[i * 3 + 1] = -50;
  g.setAttribute("position", new BufferAttribute(sparkPos, 3).setUsage(DynamicDrawUsage));
  g.setAttribute("color", new BufferAttribute(sparkCol, 3).setUsage(DynamicDrawUsage));
  sparks = new Points(g, new PointsMaterial({ size: 0.26, map: sprite, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  const mg = new BufferGeometry();
  mg.setAttribute("position", new BufferAttribute(motePos, 3).setUsage(DynamicDrawUsage));
  motes = new Points(mg, moteMat);
  motes.frustumCulled = false;
  scene.add(motes);
}
build();

/** The chart's seeded placement: pylons and caps, stars, motes; the visual and spark streams. */
export function setSeed(s: number): void {
  seed = s >>> 0 || 1;
  rng = rngOf(seed, "visual");
  fxRng = rngOf(seed, "sparks");
  swayPhase = rng.next() * PI * 2;
  const mtx = new Matrix4(), capM = new Matrix4();
  const envRng = rngOf(seed, "env");
  let idx = 0;
  for (let i = 0; i < PYLONS; i++) {
    const z = -8 - i * 7 - envRng.next() * 3;
    for (const side of [-1, 1]) {
      const x = side * (LANE_W * LANES * 0.5 + 2.2 + envRng.next() * 2.5);
      const sc = 0.7 + envRng.next() * 0.9;
      const sy = sc * (0.8 + envRng.next() * 0.6);
      mtx.makeScale(sc, sy, sc);
      mtx.setPosition(x, 3 * sc, z);
      pylons.setMatrixAt(idx, mtx);
      capM.makeScale(sc, sc * 1.6, sc);
      capM.setPosition(x, 3 * sc + 3.5 * sy + 0.5 * sc, z);
      caps.setMatrixAt(idx, capM);
      idx++;
    }
  }
  pylons.instanceMatrix.needsUpdate = true;
  caps.instanceMatrix.needsUpdate = true;
  const pos = (stars.geometry.getAttribute("position") as BufferAttribute).array as Float32Array;
  const starRng = rngOf(seed, "stars");
  for (let i = 0; i < STAR_MAX; i++) {
    pos[i * 3] = (starRng.next() - 0.5) * 260;
    pos[i * 3 + 1] = 6 + starRng.next() * 90;
    pos[i * 3 + 2] = -40 - starRng.next() * 200;
  }
  (stars.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
  const mr = rngOf(seed, "motes");
  for (let i = 0; i < MOTE_MAX; i++) {
    motePos[i * 3] = (mr.next() - 0.5) * 30;
    motePos[i * 3 + 1] = 0.5 + mr.next() * 9;
    motePos[i * 3 + 2] = 8 - mr.next() * 90;
  }
  (motes.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
  sparkLife.fill(0);
  for (let i = 0; i < SPARK_MAX; i++) sparkPos[i * 3 + 1] = -50;
  sparksDirty = true;
  for (const p of pulsePool) { p.active = false; p.mesh.visible = false; }
  for (let i = 0; i < arches.length; i++) arches[i]!.position.z = -18 - i * 16;
  shake = 0;
}

function ensureEnv(): Texture | null {
  if (envMap) return envMap;
  try {
    // three r160: the 900-candela room the old page made with the renderer argument
    envMap = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
  } catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); envMap = null; }
  return envMap;
}
const ENV_INTENSITY = { lane: 0.08, receptor: 0.6, note: 1.1, hold: 0.8, pylon: 0.4 };
function allLit(): [Lit, keyof typeof ENV_INTENSITY | "floor"][] {
  return [
    ...laneMats.map((m) => [m, "lane"] as [Lit, "lane"]),
    ...receptors.map((r) => [r.material as Lit, "receptor"] as [Lit, "receptor"]),
    ...notePool.map((p) => [p.mat, "note"] as [Lit, "note"]),
    ...holdPool.map((p) => [p.mat, "hold"] as [Lit, "hold"]),
    [pylonMat, "pylon"], [floorMat, "floor"],
  ];
}
/** IBL as r160 lit it: the room's prefiltered light on each standard material at its own envMapIntensity (detail on only). */
function applyReflections(): void {
  const env = look?.detailed ? ensureEnv() : null;
  scene.environment = null;
  for (const [m, role] of allLit()) {
    if (!("envMap" in m)) continue;
    const s = m as MeshStandardMaterial;
    s.envMap = env;
    s.envMapIntensity = role === "floor" ? 0.15 : ENV_INTENSITY[role];
  }
}

function swapMaterials(): void {
  const swap = (old: Lit, role: "lane" | "receptor" | "note" | "hold" | "pylon"): Lit => {
    const m = tiered(spec(role));
    m.color.copy(old.color); m.emissive.copy(old.emissive); m.emissiveIntensity = old.emissiveIntensity;
    old.dispose();
    return m;
  };
  laneMats = laneMats.map((old, i) => { const m = swap(old, "lane"); laneMeshes[i]!.material = m; return m; });
  for (const r of receptors) r.material = swap(r.material as Lit, "receptor");
  for (const p of notePool) { p.mat = swap(p.mat, "note"); p.mesh.material = p.mat; }
  for (const p of holdPool) { p.mat = swap(p.mat, "hold"); p.mesh.material = p.mat; }
  pylonMat = swap(pylonMat, "pylon");
  pylons.material = pylonMat;
}
function applySegments(n: number): void {
  if (segments === n) return;
  segments = n;
  const recGeo = new CylinderGeometry(0.55, 0.62, 0.1, n);
  const old = receptors[0]?.geometry;
  for (const r of receptors) r.geometry = recGeo;
  old?.dispose();
  const pulseGeo = new RingGeometry(0.5, 0.58, n);
  pulseGeo.rotateX(-PI / 2);
  const oldP = pulsePool[0]?.mesh.geometry;
  for (const p of pulsePool) p.mesh.geometry = pulseGeo;
  oldP?.dispose();
  sky.geometry.dispose();
  sky.geometry = new SphereGeometry(200, n, n / 2);
  const archGeo = new TorusGeometry(LANE_W * LANES * 0.62, 0.09, Math.max(6, n / 4), n * 1.5, PI);
  const oldA = arches[0]?.geometry;
  for (const a of arches) a.geometry = archGeo;
  oldA?.dispose();
}
function applyTextures(h: number): void {
  if (texBudget === h) return;
  texBudget = h;
  const lane = laneTexture(h);
  if (laneTex) { lane.offset.copy(laneTex.offset); laneTex.dispose(); }
  laneTex = lane;
  const grid = gridTexture(h / 2);
  gridTex?.dispose();
  gridTex = grid;
  floorMat.emissiveMap = grid;
}

/** A new look (graphics level): shading tier, segments, textures, effects. */
export function applyLook(next: Look): void {
  const prev = look;
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  if (prev && prev.budget.material !== b.material) swapMaterials();
  applySegments(b.segments);
  applyTextures(b.laneTex);
  const shadowsOn = next.shadows > 0;
  renderer.shadowMap.enabled = shadowsOn;
  keyLight.castShadow = shadowsOn;
  if (shadowsOn) keyLight.shadow.mapSize = next.shadows;
  const envOn = next.detailed;
  sky.visible = envOn;
  floor.visible = envOn;
  caps.visible = envOn;
  stars.geometry.setDrawRange(0, envOn ? Math.min(STAR_MAX, b.stars) : Math.min(200, b.stars));
  pylons.count = envOn ? PYLONS * 2 : PYLONS;
  caps.count = pylons.count;
  for (let i = 0; i < arches.length; i++) arches[i]!.visible = envOn || i < 4;
  applyLaneLook();
  const hi = next.particles === "high";
  sparks.visible = hi;
  motes.visible = hi;
  sparkCap = Math.min(SPARK_MAX, b.sparks);
  moteCount = Math.min(MOTE_MAX, b.motes);
  for (let i = sparkCap; i < SPARK_MAX; i++) { sparkLife[i] = 0; sparkPos[i * 3 + 1] = -50; }
  if (sparkNext >= sparkCap) sparkNext = 0;
  sparks.geometry.setDrawRange(0, sparkCap);
  motes.geometry.setDrawRange(0, moteCount);
  if (!hi) sparkLife.fill(0);
  applyReflections();
  // post: GTAOPass, UnrealBloomPass(…, 0.5, 0.4, 0.9), the grade before the output, AA
  const aoHi = next.ao === "high";
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: aoHi ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: aoHi ? 6 : 4, rings: 2, samples: aoHi ? 16 : 8, radiusExponent: 2 },
  };
  renderer.bloom = next.bloom ? { strength: 0.5, radius: 0.4, threshold: 0.9, resolution: b.bloomRes } : null;
  renderer.grade = next.grade ? {
    space: "linear", contrast: 0.18, saturation: 1.12, shadows: [0.95, 0.98, 1.06], highlights: [1.03, 1.0, 0.97], split: [0.25, 0.85],
    vignette: { amount: 0.26, inner: 0.32, outer: 0.82, scale: [1, 0.9] },
  } : null;
  renderer.antialias = next.antialias;
}
function applyLaneLook(): void {
  const envOn = !!look?.detailed;
  for (const m of laneMats) {
    const want = envOn ? laneTex : null;
    if ((m as MeshStandardMaterial).map !== want) (m as MeshStandardMaterial).map = want;
    m.color.set(theme.lane);
    if (envOn) m.color.multiplyScalar(1.25); // the texture darkens; keep the lane's value
  }
}

/** The chart's theme (and the colour-vision palette). */
export function setTheme(t: Theme, cvdPalette: boolean): void {
  theme = t;
  cvd = cvdPalette;
  scene.background = new Color(t.sky);
  scene.fog = new FogExp2(t.fog, t.fogDensity);
  keyLight.color.set(t.keyLight);
  rimLight.color.set(t.laneEdge);
  hemi.color.set(t.fog);
  hemi.groundColor.set(t.sky);
  skyU.uTop.value.set(t.sky);
  skyU.uHorizon.value.set(t.fog);
  skyU.uGlow.value.set(t.laneEdge).multiplyScalar(0.16);
  floorMat.emissive.set(t.env);
  applyLaneLook();
  for (const m of laneMats) m.emissive.set(edgeColor());
  hdr(edgeMat.color, edgeColor(), 1.3);
  hdr((judgeLine.material as MeshBasicMaterial).color, receptorColor(), 1.5);
  for (const r of receptors) (r.material as Lit).emissive.set(receptorColor());
  for (const p of notePool) { p.mat.color.set(noteColor()); p.mat.emissive.set(noteColor()); }
  for (const p of holdPool) { p.mat.color.set(holdColor()); p.mat.emissive.set(holdColor()); }
  pylonMat.color.set(t.env); pylonMat.emissive.set(t.env);
  hdr(capMat.color, t.accent, 1.4);
  for (const a of arches) hdr((a.material as MeshBasicMaterial).color, t.accent, 1.2);
  hdr(moteMat.color, t.laneEdge, 1.2);
}
export function setOptions(o: { reducedMotion: boolean; cameraSway: boolean; noteSpeed: number; mirror: boolean }): void {
  reducedMotion = o.reducedMotion;
  cameraSway = o.cameraSway;
  noteSpeed = o.noteSpeed || 1;
  mirror = o.mirror;
}
const laneX = (lane: number): number => laneXOf(mirror ? LANES - 1 - lane : lane);

// -- events ------------------------------------------------------------------------------------
/** A lane's press or release from any input (receptor and lane glow). */
export function pressLane(lane: number, held: boolean): void {
  laneHeld[lane] = held;
  if (held) laneFlash[lane] = 1;
}
export function releaseAll(): void { for (let i = 0; i < LANES; i++) laneHeld[i] = false; }
export function event(e: { type: string; lane?: number; grade?: string; combo?: number }): void {
  if (e.type === "hit") {
    const lane = e.lane!;
    spawnPulse(lane, GRADE_COLORS[e.grade!] ?? 0xffffff, e.grade === "perfect" ? 1.6 : 1.1);
    spawnSparks(lane, GRADE_COLORS[e.grade!] ?? 0xffffff, e.grade === "perfect" ? 22 : e.grade === "great" ? 14 : 8);
    laneFlash[lane] = 1;
    if (!reducedMotion && (e.combo ?? 0) > 0 && e.combo! % 25 === 0) shake = Math.min(1, shake + 0.35);
  } else if (e.type === "miss" || e.type === "early-release") {
    spawnPulse(e.lane!, GRADE_COLORS.miss!, 0.8);
    if (!reducedMotion) shake = Math.min(1, shake + 0.15);
  } else if (e.type === "hold-complete") {
    spawnPulse(e.lane!, holdColor(), 1.2);
    spawnSparks(e.lane!, holdColor(), 16);
  } else if (e.type === "terminal") shake = 0;
}
function spawnPulse(lane: number, color: number, strength: number): void {
  const p = pulsePool.find((x) => !x.active);
  if (!p) return;
  p.active = true;
  p.age = 0;
  p.strength = strength;
  p.mesh.visible = true;
  p.mesh.position.set(laneX(lane), 0.14, RECEPTOR_Z);
  p.mat.color.set(color);
  p.mat.opacity = 0.85;
}
function spawnSparks(lane: number, hex: number, n: number): void {
  if (look?.particles !== "high" || reducedMotion || sparkCap <= 0) return;
  const c = new Color(hex).multiplyScalar(2.2);
  const x0 = laneX(lane);
  for (let k = 0; k < n; k++) {
    const i = sparkNext;
    sparkNext = (sparkNext + 1) % sparkCap;
    const a = fxRng.next() * PI * 2;
    const sp = 1.5 + fxRng.next() * 3;
    sparkPos[i * 3] = x0 + Math.cos(a) * 0.3;
    sparkPos[i * 3 + 1] = 0.25;
    sparkPos[i * 3 + 2] = RECEPTOR_Z + Math.sin(a) * 0.3;
    sparkVel[i * 3] = Math.cos(a) * sp * 0.7;
    sparkVel[i * 3 + 1] = 3 + fxRng.next() * 4;
    sparkVel[i * 3 + 2] = Math.sin(a) * sp * 0.5 - 0.8;
    sparkLife[i] = 0.5 + fxRng.next() * 0.4;
    sparkBase[i * 3] = c.r; sparkBase[i * 3 + 1] = c.g; sparkBase[i * 3 + 2] = c.b;
  }
}
function updateParticles(dt: number, animated: boolean): void {
  if (!sparks.visible) return;
  let any = false;
  for (let i = 0; i < sparkCap; i++) {
    if (sparkLife[i]! <= 0) continue;
    any = true;
    sparkLife[i]! -= dt;
    const j = i * 3;
    if (sparkLife[i]! <= 0) { sparkPos[j + 1] = -50; sparkCol[j] = sparkCol[j + 1] = sparkCol[j + 2] = 0; continue; }
    sparkVel[j + 1]! -= 9.8 * dt;
    sparkPos[j]! += sparkVel[j]! * dt;
    sparkPos[j + 1] = Math.max(0.08, sparkPos[j + 1]! + sparkVel[j + 1]! * dt);
    sparkPos[j + 2]! += sparkVel[j + 2]! * dt;
    const f = Math.min(1, sparkLife[i]! * 2.2);
    sparkCol[j] = sparkBase[j]! * f; sparkCol[j + 1] = sparkBase[j + 1]! * f; sparkCol[j + 2] = sparkBase[j + 2]! * f;
  }
  if (any || sparksDirty) {
    (sparks.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (sparks.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
  }
  sparksDirty = any;
  if (animated) {
    for (let i = 0; i < moteCount; i++) {
      const j = i * 3;
      motePos[j + 2]! += dt * 2.2;
      motePos[j + 1]! += Math.sin(time * 0.7 + i) * dt * 0.08;
      if (motePos[j + 2]! > 10) motePos[j + 2]! -= 92;
    }
    (motes.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
  }
}

// -- the frame -----------------------------------------------------------------------------------
export interface View { notes: readonly Note[]; tick: number; bpm: number; running: boolean }
/** One frame: `view` the run (null on menus), `dt` seconds, the window size in pixels. */
export function update(view: View | null, dt: number, width: number, height: number): void {
  dt = Math.min(dt, 0.1);
  time += dt;
  const leadMs = 2400 / noteSpeed;
  const animated = !!look?.animated && !reducedMotion;
  // notes (the rules state is only read)
  const usedNotes = new Set<PoolItem>(), usedHolds = new Set<PoolItem>();
  if (view) {
    for (const n of view.notes) {
      if (n.state === "missed" || n.state === "hit" || n.state === "released") continue;
      const until = n.time - view.tick;
      if (n.state === "pending" && until > leadMs) continue;
      if (n.kind === "tap") {
        const p = notePool.find((x) => x.inUse && x.noteId === n.id) ?? notePool.find((x) => !x.inUse);
        if (!p) continue;
        p.inUse = true; p.noteId = n.id;
        usedNotes.add(p);
        const z = n.state === "pending" ? -(until / leadMs) * TRACK_LEN : RECEPTOR_Z;
        p.mesh.visible = true;
        p.mesh.position.set(laneX(n.lane), NOTE_Y + 0.3, Math.min(z, RECEPTOR_Z));
        p.mesh.scale.setScalar(n.state === "holding" ? 0.7 : 1);
        if (!reducedMotion) p.mesh.rotation.y = time * 2 + n.id;
      } else {
        const h = holdPool.find((x) => x.inUse && x.noteId === n.id) ?? holdPool.find((x) => !x.inUse);
        if (!h) continue;
        h.inUse = true; h.noteId = n.id;
        usedHolds.add(h);
        const tailUntil = n.time + n.duration - view.tick;
        const headZ = Math.min(-(Math.max(until, 0) / leadMs) * TRACK_LEN, RECEPTOR_Z);
        const tailZ = Math.max(-(tailUntil / leadMs) * TRACK_LEN, -TRACK_LEN);
        const head = n.state === "holding" ? RECEPTOR_Z : headZ;
        const len = Math.max(0.3, head - tailZ);
        h.mesh.visible = true;
        h.mesh.scale.set(1, 1, len);
        h.mesh.position.set(laneX(n.lane), NOTE_Y + 0.15, (head + tailZ) / 2);
        h.mat.emissiveIntensity = n.state === "holding" ? 1.6 : 0.95;
      }
    }
  }
  for (const p of notePool) if (p.inUse && !usedNotes.has(p)) { p.inUse = false; p.noteId = -1; p.mesh.visible = false; }
  for (const h of holdPool) if (h.inUse && !usedHolds.has(h)) { h.inUse = false; h.noteId = -1; h.mesh.visible = false; }

  // receptors and lanes (the input acknowledgement)
  for (let i = 0; i < LANES; i++) {
    laneFlash[i] = Math.max(0, laneFlash[i]! - dt * 5);
    const held = laneHeld[i]!;
    const r = receptors[i]!;
    r.position.x = laneX(i);
    (r.material as Lit).emissiveIntensity = 0.7 + laneFlash[i]! * 1.6 + (held ? 0.6 : 0);
    r.scale.setScalar(held ? 1.12 : 1);
    laneMeshes[i]!.position.x = laneX(i);
    laneMats[i]!.emissiveIntensity = 0.06 + laneFlash[i]! * 0.5 + (held ? 0.18 : 0);
  }

  // the beat: the judgment line breathes; the sky glow and pylon caps pulse when animated
  beat = 0;
  judgeLine.scale.y = 1;
  if (view && view.running) {
    const beatMs = 60000 / view.bpm;
    const phase = (((view.tick % beatMs) + beatMs) % beatMs) / beatMs;
    beat = 1 - phase;
    judgeLine.scale.y = 1 + (1 - phase) * 0.6;
  }
  // the lane surface flows with the notes; idle drift on menus
  if (animated && laneTex && look?.detailed) {
    const worldPerTile = (TRACK_LEN + 8) / laneTex.repeat.y;
    const dist = view && view.running ? (view.tick / leadMs) * TRACK_LEN : time * 3;
    laneTex.offset.y = (dist / worldPerTile) % 1;
  }
  for (const p of pulsePool) {
    if (!p.active) continue;
    p.age += dt * (reducedMotion ? 2.5 : 1.6);
    if (p.age >= 1) { p.active = false; p.mesh.visible = false; continue; }
    p.mesh.scale.setScalar(1 + p.age * 5 * p.strength);
    p.mat.opacity = 0.85 * (1 - p.age);
  }
  updateParticles(dt, animated);
  if (animated) {
    for (let i = 0; i < arches.length; i++) {
      const a = arches[i]!;
      a.position.z += dt * 1.2;
      if (a.position.z > 6) a.position.z -= 16 * arches.length;
      (a.material as MeshBasicMaterial).opacity = 0.4 + 0.3 * Math.sin(time * 0.8 + i);
    }
    stars.rotation.y = time * 0.004;
    skyU.uTime.value = time;
    skyU.uBeat.value = beat;
    hdr(capMat.color, theme.accent, 1.1 + beat * 1.2);
  } else skyU.uBeat.value = 0;

  // the camera: authored framing + seeded sway + tiered shake (never a cumulative lerp)
  portrait = height > width;
  const f = portrait ? FRAMING.portrait : FRAMING.landscape;
  const cam = new Vector3(f.camPos[0], f.camPos[1], f.camPos[2]);
  if (!reducedMotion && cameraSway && view && view.running) {
    cam.x += Math.sin(time * 0.5 + swayPhase) * 0.22;
    cam.y += Math.sin(time * 0.33 + swayPhase * 2) * 0.22 * 0.4;
  }
  if (shake > 0 && !reducedMotion) {
    shake = Math.max(0, shake - dt * 2.2);
    const amp = shake * 0.12;
    cam.x += (rng.next() - 0.5) * amp;
    cam.y += (rng.next() - 0.5) * amp;
  }
  camera.fov = f.fov;
  camera.aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  camera.updateProjectionMatrix();
  camera.position.copy(cam);
  camera.lookAt(f.lookAt[0], f.lookAt[1], f.lookAt[2]);
}

// -- lane picking on the causeway --------------------------------------------------------------
const raycaster = new Raycaster();
const pickPlane = new Plane(new Vector3(0, 1, 0), -0.05);
const hit = new Vector3();
const ndc = new Vector2();
/** The lane under a window point (pixels), or null: the old invisible pick plane over the lanes. */
export function laneAt(x: number, y: number): number | null {
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(pickPlane, hit)) return null;
  if (Math.abs(hit.x) > (LANE_W * LANES + 1) / 2 || hit.z < -TRACK_LEN - 1 || hit.z > 9) return null;
  const col = Math.round(hit.x / LANE_W + (LANES - 1) / 2);
  if (!(col >= 0 && col < LANES)) return null;
  return mirror ? LANES - 1 - col : col;
}
/** The judgment line's window y (pixels), for placing the judgment pop. */
export function judgeLineY(height: number): number {
  const v = new Vector3(0, 0, RECEPTOR_Z).project(camera);
  return (1 - v.y) / 2 * height;
}

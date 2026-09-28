// Three.js renderer: the reactive concert causeway made of light.
// Rendering consumes immutable session snapshots + interpolation alpha only;
// it never mutates rules state. Cosmetic particles never intercept raycasts
// (lane picking uses a dedicated interaction layer).
//
// Graphics quality (see gfx.js) is applied live through setGraphics(): shadow
// map size, post chain (GTAO → bloom → grade → output → SMAA/FXAA), render
// scale with adaptive resolution, particles, background motion and detail.

import * as THREE from './vendor/three.module.min.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeRng, streamSeed } from './rng.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

export const LANES = 4;
const LANE_W = 1.7;
const TRACK_LEN = 64;          // world units from receptor to horizon
const RECEPTOR_Z = 0;
const NOTE_Y = 0.12;
const SPARKS = 320;            // pooled hit-spark particles (particles: high)
const MOTES = 160;             // drifting light motes (particles: high)

// Authored framing constants (exposed, not magic offsets).
export const FRAMING = {
  portrait: { camPos: [0, 9.2, 12.5], lookAt: [0, 1.8, -15], fov: 56 },
  landscape: { camPos: [0, 7.5, 11.5], lookAt: [0, 1.4, -14], fov: 50 },
};

const GRADE_COLORS = { perfect: 0xfff6a8, great: 0x7dffb0, good: 0x8ab8ff, miss: 0x666a75 };

export function laneX(lane) { return (lane - (LANES - 1) / 2) * LANE_W; }

// GPU string (unmasked when the browser exposes it), probed once per page.
let gpuCache = null;
export function detectGpu() {
  if (gpuCache !== null) return gpuCache;
  gpuCache = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      // Firefox already unmasks RENDERER and flags the debug extension as deprecated.
      const ext = /firefox/i.test(navigator.userAgent) ? null : gl.getExtension('WEBGL_debug_renderer_info');
      gpuCache = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { gpuCache = ''; }
  return gpuCache;
}

export function isMobileDevice() {
  try {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
  } catch { return false; }
}

export function detectedPreset() { return detectPreset(detectGpu(), { mobile: isMobileDevice() }); }

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      // Gentle S-curve contrast, a touch more saturation, cool shadows / warm highlights.
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.12);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.03, 1.0, 0.97), smoothstep(0.25, 0.85, l));
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.9));
      c *= 1.0 - uVignette * smoothstep(0.32, 0.82, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Sky dome: vertical gradient with a horizon glow that swells on the beat and
// a slow aurora shimmer (frozen when the background is static).
const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SKY_FRAG = `
  uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow; uniform float uTime; uniform float uBeat;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float h = clamp(vDir.y, -0.2, 1.0);
    vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
    float band = exp(-abs(h - 0.02) * 9.0);
    float centre = exp(-abs(vDir.x) * 1.6) * step(vDir.z, 0.0);
    c += uGlow * band * (0.35 + 0.9 * centre) * (0.85 + 0.3 * uBeat);
    float a = noise(vec2(vDir.x * 3.0 + uTime * 0.03, h * 6.0 - uTime * 0.02));
    a *= noise(vec2(vDir.x * 7.0 - uTime * 0.05, h * 11.0));
    c += uGlow * 0.22 * a * smoothstep(0.05, 0.35, h) * (1.0 - smoothstep(0.45, 0.9, h));
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// Procedural surface textures (deterministic, drawn once).
function laneTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  const rng = makeRng(streamSeed(7, 'lane-tex'));
  g.fillStyle = '#7c8699';
  g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 900; i++) { // fine brushed-glass grain
    const v = 140 + Math.floor(rng.next() * 60);
    g.fillStyle = `rgba(${v},${v + 8},${v + 20},0.35)`;
    g.fillRect(rng.next() * 64, rng.next() * 256, 1, 2 + rng.next() * 6);
  }
  // Beat rungs: one bright + three faint subdivisions per tile.
  for (let k = 0; k < 4; k++) {
    g.fillStyle = k === 0 ? 'rgba(255,255,255,0.7)' : 'rgba(230,240,255,0.3)';
    g.fillRect(0, k * 64, 64, k === 0 ? 3 : 1);
  }
  g.fillStyle = 'rgba(255,255,255,0.5)'; // inner bevel highlight
  g.fillRect(0, 0, 2, 256); g.fillRect(62, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(64, 0); g.lineTo(64, 128); g.moveTo(0, 64); g.lineTo(128, 64); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(40, 40);
  t.anisotropy = 4;
  return t;
}

function sparkSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export class Renderer3D {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.theme = options.theme;
    this.cvd = !!options.cvdPalette;
    this.reducedMotion = !!options.reducedMotion;
    this.cameraSway = options.cameraSway !== false;
    this.noteSpeed = options.noteSpeed || 1;
    this.mirrorLanes = !!options.mirrorLanes;
    this.onLaneInput = options.onLaneInput || (() => {});
    this.gpu = detectGpu();
    this.detected = detectedPreset();
    this.q = resolve(options.gfx, this.detected);
    this._rng = makeRng(streamSeed(options.seed || 1, 'visual'));
    this._fxRng = makeRng(streamSeed(options.seed || 1, 'sparks'));
    this._time = 0;
    this._flow = 0;
    this._beat = 0;
    this._disposed = false;
    this._swayPhase = this._rng.next() * Math.PI * 2;
    this._shake = 0;
    this._laneFlash = [0, 0, 0, 0];
    this._laneHeld = [false, false, false, false];
    this._effects = []; // active transient effects
    this.adaptiveScale = 1;
    this._frames = [];
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.postKey = null;
    this.composer = null;
    this.postFailed = false;
    this.fps = 0;
    this._buildRenderer();
    this._buildScene();
    this._bindPointer();
    this.setGraphics(options.gfx);
  }

  // World X for a logical lane. The left-handed layout mirrors the causeway so
  // the rendered lanes keep matching the on-screen lane button order.
  _laneX(lane) { return laneX(this.mirrorLanes ? LANES - 1 - lane : lane); }
  setMirrorLanes(v) { this.mirrorLanes = !!v; }

  get _motion() {
    if (this.reducedMotion) return false;
    try { return !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
  }

  // -------------------------------------------------------------------------
  _buildRenderer() {
    // Canvas MSAA only when MSAA is wanted without a post chain (the post
    // chain multisamples its own target). Changing it needs a new context,
    // which setGraphics() reports to the caller.
    this.canvasMsaa = this.q.antialias === 'msaa' && !this.q.post;
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.canvasMsaa,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('game-canvas');
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.options.onContextLost) this.options.onContextLost();
    }, false);
  }

  _buildScene() {
    const t = this.theme;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(t.sky);
    this.scene.fog = new THREE.FogExp2(t.fog, t.fogDensity);
    this.litMats = []; // materials that depend on shadow/environment state

    // Image-based lighting: a neutral studio room prefiltered once.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    this._applyFraming();

    // Lighting: one dominant key, soft environment fill, contact grounding.
    // The key sits almost overhead so its shadow box maps straight onto the
    // causeway; the frustum is fitted to the lanes near the judgment line.
    this.keyLight = new THREE.DirectionalLight(t.keyLight, 2.2);
    this.keyLight.position.set(2.5, 22, -6);
    this.keyLight.target.position.set(0, 0, -12);
    this.scene.add(this.keyLight, this.keyLight.target);
    Object.assign(this.keyLight.shadow.camera, { left: -LANE_W * LANES / 2 - 1, right: LANE_W * LANES / 2 + 1, top: 24, bottom: -18, near: 4, far: 40 });
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.keyLight.shadow.bias = -0.0008;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    this.hemi = new THREE.HemisphereLight(t.fog, t.sky, 0.9);
    this.scene.add(this.hemi);
    // Cool rim light from the horizon so gems read as glossy solids.
    this.rimLight = new THREE.DirectionalLight(t.laneEdge, 0.3);
    this.rimLight.position.set(0, 3, -30);
    this.scene.add(this.rimLight);

    // --- Sky dome (detail) ---
    this.skyU = {
      uTop: { value: new THREE.Color(t.sky) }, uHorizon: { value: new THREE.Color(t.fog) },
      uGlow: { value: new THREE.Color(t.laneEdge).multiplyScalar(0.16) }, uTime: { value: 0 }, uBeat: { value: 0 },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    // --- Floor grid far below the causeway (detail) ---
    this.gridTex = gridTexture();
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0x05070c, roughness: 0.3, metalness: 0.85, envMapIntensity: 0.15,
      emissive: t.env, emissiveMap: this.gridTex, emissiveIntensity: 0.9,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(0, -1.2, -60);
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.litMats.push(this.floorMat);

    // --- Causeway: lane strips ---
    this.laneGroup = new THREE.Group();
    this.scene.add(this.laneGroup);
    this.laneTex = laneTexture();
    this.laneTex.repeat.set(1, 24);
    const laneGeo = new THREE.BoxGeometry(LANE_W - 0.12, 0.08, TRACK_LEN + 8);
    this.laneMeshes = [];
    this.laneMats = [];
    for (let i = 0; i < LANES; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: t.lane, roughness: 0.6, metalness: 0.45, envMapIntensity: 0.08,
        emissive: t.laneEdge, emissiveIntensity: 0.06,
      });
      const m = new THREE.Mesh(laneGeo, mat);
      m.position.set(this._laneX(i), 0, -TRACK_LEN / 2 + 4);
      m.receiveShadow = true;
      m.userData.lane = i;
      this.laneGroup.add(m);
      this.laneMeshes.push(m);
      this.laneMats.push(mat);
      this.litMats.push(mat);
    }
    // Lane edge light strips (HDR so bloom picks them up).
    const edgeGeo = new THREE.BoxGeometry(0.05, 0.1, TRACK_LEN + 8);
    this.edgeMat = new THREE.MeshBasicMaterial();
    this._hdr(this.edgeMat.color, this.cvd ? this.options.cvdColors.laneEdge : t.laneEdge, 1.3);
    for (let i = 0; i <= LANES; i++) {
      const e = new THREE.Mesh(edgeGeo, this.edgeMat);
      e.position.set(laneX(0) - LANE_W / 2 + i * LANE_W, 0.02, -TRACK_LEN / 2 + 4);
      this.laneGroup.add(e);
    }

    // --- Judgment line + receptors ---
    const lineGeo = new THREE.BoxGeometry(LANE_W * LANES + 0.4, 0.12, 0.18);
    const lineMat = new THREE.MeshBasicMaterial();
    this.judgeLine = new THREE.Mesh(lineGeo, lineMat);
    this.judgeLine.position.set(0, 0.08, RECEPTOR_Z);
    this.scene.add(this.judgeLine);
    this._setJudgeColor();

    this.receptors = [];
    const recGeo = new THREE.CylinderGeometry(0.55, 0.62, 0.1, 32);
    for (let i = 0; i < LANES; i++) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0x0a0a12, roughness: 0.25, metalness: 0.85, clearcoat: 1, clearcoatRoughness: 0.1,
        envMapIntensity: 0.6,
        emissive: this.cvd ? this.options.cvdColors.receptor : t.receptor, emissiveIntensity: 0.7,
      });
      const r = new THREE.Mesh(recGeo, mat);
      r.position.set(this._laneX(i), 0.1, RECEPTOR_Z);
      r.castShadow = true;
      this.scene.add(r);
      this.receptors.push(r);
      this.litMats.push(mat);
    }

    // --- Note pools (tap gems + hold bars): glossy clear-coated gems ---
    this.notePool = [];
    const tapGeo = new THREE.OctahedronGeometry(0.5);
    tapGeo.scale(1, 0.55, 1);
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: this._noteColor(), roughness: 0.12, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05,
        envMapIntensity: 1.1,
        emissive: this._noteColor(), emissiveIntensity: 1.0,
      });
      const m = new THREE.Mesh(tapGeo, mat);
      m.visible = false;
      m.castShadow = true;
      this.scene.add(m);
      this.notePool.push({ mesh: m, mat, inUse: false, noteId: -1, kind: 'tap' });
      this.litMats.push(mat);
    }
    this.holdPool = [];
    const holdGeo = new THREE.BoxGeometry(0.5, 0.16, 1); // z scaled per note
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshPhysicalMaterial({
        color: this._holdColor(), roughness: 0.2, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1,
        envMapIntensity: 0.8,
        emissive: this._holdColor(), emissiveIntensity: 0.95, transparent: true, opacity: 0.95,
      });
      const m = new THREE.Mesh(holdGeo, mat);
      m.visible = false;
      m.castShadow = true;
      this.scene.add(m);
      this.holdPool.push({ mesh: m, mat, inUse: false, noteId: -1 });
      this.litMats.push(mat);
    }

    // --- Environment: instanced pylons + arches, deterministic placement ---
    this.envGroup = new THREE.Group();
    this.scene.add(this.envGroup);
    const pylonCount = 24;
    const pylonGeo = new THREE.CylinderGeometry(0.3, 0.55, 7, 6);
    this.pylonMat = new THREE.MeshStandardMaterial({
      color: t.env, roughness: 0.45, metalness: 0.5, envMapIntensity: 0.4, emissive: t.env, emissiveIntensity: 0.25, flatShading: true,
    });
    this.litMats.push(this.pylonMat);
    this.pylons = new THREE.InstancedMesh(pylonGeo, this.pylonMat, pylonCount * 2);
    // Glowing caps on each pylon (detail) that pulse with the beat.
    const capGeo = new THREE.OctahedronGeometry(0.24);
    this.capMat = new THREE.MeshBasicMaterial();
    this._hdr(this.capMat.color, t.accent, 1.4);
    this.caps = new THREE.InstancedMesh(capGeo, this.capMat, pylonCount * 2);
    const mtx = new THREE.Matrix4();
    const capM = new THREE.Matrix4();
    let idx = 0;
    const envRng = makeRng(streamSeed(this.options.seed || 1, 'env'));
    for (let i = 0; i < pylonCount; i++) {
      const z = -8 - i * 7 - envRng.next() * 3;
      for (const side of [-1, 1]) {
        const x = side * (LANE_W * LANES * 0.5 + 2.2 + envRng.next() * 2.5);
        const s = 0.7 + envRng.next() * 0.9;
        const sy = s * (0.8 + envRng.next() * 0.6);
        mtx.makeScale(s, sy, s);
        mtx.setPosition(x, 3 * s, z);
        this.pylons.setMatrixAt(idx, mtx);
        capM.makeScale(s, s * 1.6, s);
        capM.setPosition(x, 3 * s + 3.5 * sy + 0.5 * s, z);
        this.caps.setMatrixAt(idx, capM);
        idx++;
      }
    }
    this.pylons.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    this.pylonCount = pylonCount;
    this.envGroup.add(this.pylons, this.caps);

    // Light arches across the causeway every so often.
    const archCount = 8;
    const archGeo = new THREE.TorusGeometry(LANE_W * LANES * 0.62, 0.09, 8, 48, Math.PI);
    this.archMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.65, depthWrite: false });
    this._hdr(this.archMat.color, t.accent, 1.2);
    this.arches = [];
    for (let i = 0; i < archCount; i++) {
      const a = new THREE.Mesh(archGeo, this.archMat.clone());
      a.position.set(0, 0, -18 - i * 16);
      this.envGroup.add(a);
      this.arches.push(a);
    }

    // Starfield / sky dust (cosmetic layer; never raycast).
    const starCount = 700;
    const starGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(starCount * 3);
    const starRng = makeRng(streamSeed(this.options.seed || 1, 'stars'));
    for (let i = 0; i < starCount; i++) {
      pos[i * 3] = (starRng.next() - 0.5) * 260;
      pos[i * 3 + 1] = 6 + starRng.next() * 90;
      pos[i * 3 + 2] = -starRng.next() * 240;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xafc8ff, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.8, fog: false,
    }));
    this.scene.add(this.stars);

    // Beat pulse rings emitted from the judgment line (pooled).
    this.pulsePool = [];
    const pulseGeo = new THREE.RingGeometry(0.5, 0.58, 32);
    pulseGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: t.receptor, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      });
      const p = new THREE.Mesh(pulseGeo, mat);
      p.visible = false;
      this.scene.add(p);
      this.pulsePool.push({ mesh: p, mat, age: 0, active: false, lane: 0, color: new THREE.Color() });
    }

    this._buildParticles();

    // Interaction layer for pointer raycasts (invisible plane over lanes).
    this.pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_W * LANES + 1, TRACK_LEN + 10),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.pickPlane.rotateX(-Math.PI / 2);
    this.pickPlane.position.set(0, 0.05, -TRACK_LEN / 2 + 4);
    this.scene.add(this.pickPlane);
    this._raycaster = new THREE.Raycaster();
    this._pointerVec = new THREE.Vector2();

    this.resize();
  }

  // Pooled hit sparks and ambient motes: additive points, never raycast.
  _buildParticles() {
    const sprite = sparkSprite();
    this.sparkTex = sprite;
    const g = new THREE.BufferGeometry();
    this.sparkPos = new Float32Array(SPARKS * 3);
    this.sparkCol = new Float32Array(SPARKS * 3);
    this.sparkVel = new Float32Array(SPARKS * 3);
    this.sparkLife = new Float32Array(SPARKS);
    this.sparkBase = new Float32Array(SPARKS * 3);
    for (let i = 0; i < SPARKS; i++) this.sparkPos[i * 3 + 1] = -50;
    g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.sparks = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.26, map: sprite, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    this.sparks.frustumCulled = false;
    this._sparkNext = 0;
    this.scene.add(this.sparks);

    const mg = new THREE.BufferGeometry();
    this.motePos = new Float32Array(MOTES * 3);
    const rng = makeRng(streamSeed(this.options.seed || 1, 'motes'));
    for (let i = 0; i < MOTES; i++) {
      this.motePos[i * 3] = (rng.next() - 0.5) * 30;
      this.motePos[i * 3 + 1] = 0.5 + rng.next() * 9;
      this.motePos[i * 3 + 2] = 8 - rng.next() * 90;
    }
    mg.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.moteMat = new THREE.PointsMaterial({
      size: 0.16, map: sprite, transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this._hdr(this.moteMat.color, this.theme.laneEdge, 1.2);
    this.motes = new THREE.Points(mg, this.moteMat);
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  _hdr(color, hex, k) { return color.set(hex).multiplyScalar(k); }
  _setJudgeColor() { this._hdr(this.judgeLine.material.color, this.cvd ? this.options.cvdColors.receptor : this.theme.receptor, 1.5); }

  _noteColor() { return this.cvd ? this.options.cvdColors.note : this.theme.note; }
  _holdColor() { return this.cvd ? this.options.cvdColors.hold : this.theme.hold; }

  _applyFraming() {
    const portrait = this.container.clientHeight > this.container.clientWidth;
    const f = portrait ? FRAMING.portrait : FRAMING.landscape;
    this._baseCamPos = new THREE.Vector3(...f.camPos);
    this._baseLookAt = new THREE.Vector3(...f.lookAt);
    this.camera.fov = f.fov;
    this.camera.position.copy(this._baseCamPos);
    this.camera.lookAt(this._baseLookAt);
    this.camera.updateProjectionMatrix();
  }

  setTheme(theme, cvd = this.cvd) {
    this.theme = theme;
    this.cvd = cvd;
    this.scene.background = new THREE.Color(theme.sky);
    this.scene.fog.color.set(theme.fog);
    this.scene.fog.density = theme.fogDensity;
    this.keyLight.color.set(theme.keyLight);
    this.rimLight.color.set(theme.laneEdge);
    this.hemi.color.set(theme.fog);
    this.hemi.groundColor.set(theme.sky);
    this.skyU.uTop.value.set(theme.sky);
    this.skyU.uHorizon.value.set(theme.fog);
    this.skyU.uGlow.value.set(theme.laneEdge).multiplyScalar(0.16);
    this.floorMat.emissive.set(theme.env);
    for (const m of this.laneMats) { m.color.set(theme.lane); m.emissive.set(cvd ? this.options.cvdColors.laneEdge : theme.laneEdge); }
    this._hdr(this.edgeMat.color, cvd ? this.options.cvdColors.laneEdge : theme.laneEdge, 1.3);
    this._setJudgeColor();
    for (const r of this.receptors) r.material.emissive.set(cvd ? this.options.cvdColors.receptor : theme.receptor);
    for (const p of this.notePool) { p.mat.color.set(this._noteColor()); p.mat.emissive.set(this._noteColor()); }
    for (const p of this.holdPool) { p.mat.color.set(this._holdColor()); p.mat.emissive.set(this._holdColor()); }
    this.pylonMat.color.set(theme.env); this.pylonMat.emissive.set(theme.env);
    this._hdr(this.capMat.color, theme.accent, 1.4);
    for (const a of this.arches) this._hdr(a.material.color, theme.accent, 1.2);
    this._hdr(this.moteMat.color, theme.laneEdge, 1.2);
  }

  // -------------------------------------------------------------------------
  // Graphics settings (live; see gfx.js). Returns true when the canvas needs
  // a new WebGL context (canvas MSAA toggled) — the caller rebuilds.
  // -------------------------------------------------------------------------
  setGraphics(saved) {
    const g = resolve(saved, this.detected);
    this.q = g;
    const size = SHADOW_MAP[g.shadows];
    const shadowsOn = size > 0;
    const envOn = g.detail === 'detailed';
    const wasShadow = this.renderer.shadowMap.enabled;
    const wasEnv = !!this.scene.environment;
    this.renderer.shadowMap.enabled = shadowsOn;
    this.keyLight.castShadow = shadowsOn;
    if (shadowsOn && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // Detail: sky dome, IBL reflections, textured lanes, floor grid, pylon caps.
    this.scene.environment = envOn ? this.envMap : null;
    this.sky.visible = envOn;
    this.floor.visible = envOn;
    this.caps.visible = envOn;
    this.stars.geometry.setDrawRange(0, envOn ? 700 : 200);
    this.pylons.count = envOn ? this.pylonCount * 2 : this.pylonCount;
    this.caps.count = this.pylons.count;
    for (let i = 0; i < this.arches.length; i++) this.arches[i].visible = envOn || i < 4;
    for (const m of this.laneMats) {
      const want = envOn ? this.laneTex : null;
      if (m.map !== want) { m.map = want; m.needsUpdate = true; }
      m.color.set(this.theme.lane);
      if (envOn) m.color.multiplyScalar(1.25); // texture darkens; keep lane value
    }
    // Particles.
    const hi = g.particles === 'high';
    this.sparks.visible = hi;
    this.motes.visible = hi;
    if (!hi) this.sparkLife.fill(0);
    if (wasShadow !== shadowsOn || wasEnv !== envOn) for (const m of this.litMats) m.needsUpdate = true;
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    const el = this.renderer.domElement;
    el.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxPreset = g.preset;
    return (g.antialias === 'msaa' && !g.post) !== this.canvasMsaa;
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      pixels: px,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' && this.renderer.capabilities.isWebGL2 ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.7;
        ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      // High threshold: only emissive gems, light strips and highlights bloom.
      if (g.bloom === 'on') composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.4, 0.9));
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly and say so in the panel.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  _render(dtMs) {
    const rescale = this._adapt(dtMs);
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h);
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try { this.composer.render(dtMs / 1000); return; } catch {
        this.postFailed = true;
        this.composer = null;
        this.postKey = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  setReducedMotion(v) { this.reducedMotion = v; }
  setNoteSpeed(v) { this.noteSpeed = v; }

  // -------------------------------------------------------------------------
  // Pointer input: raycast only against the explicit interaction plane.
  // -------------------------------------------------------------------------
  _bindPointer() {
    const el = this.renderer.domElement;
    this._activePointers = new Map(); // pointerId -> lane
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      const lane = this.laneAt(e.clientX, e.clientY);
      if (lane == null) return;
      el.setPointerCapture(e.pointerId);
      this._activePointers.set(e.pointerId, lane);
      this._laneHeld[lane] = true;
      this.onLaneInput(lane, 'down');
    });
    const release = (e, cancelled) => {
      const lane = this._activePointers.get(e.pointerId);
      if (lane == null) return;
      this._activePointers.delete(e.pointerId);
      this._laneHeld[lane] = false;
      this.onLaneInput(lane, cancelled ? 'cancel' : 'up');
    };
    el.addEventListener('pointerup', (e) => release(e, false));
    el.addEventListener('pointercancel', (e) => release(e, true)); // cancel safely on lost capture
  }

  laneAt(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointerVec.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._pointerVec, this.camera);
    const hits = this._raycaster.intersectObject(this.pickPlane, false);
    if (!hits.length) return null;
    const x = hits[0].point.x;
    const col = Math.round(x / LANE_W + (LANES - 1) / 2);
    if (!(col >= 0 && col < LANES)) return null;
    return this.mirrorLanes ? LANES - 1 - col : col;
  }

  pressLane(lane, held) { // external (keyboard/gamepad/DOM buttons) visual ack
    this._laneHeld[lane] = held;
    if (held) this._laneFlash[lane] = 1;
  }

  // -------------------------------------------------------------------------
  // Logical events → effects (event hierarchy tiers).
  // -------------------------------------------------------------------------
  event(evt) {
    if (evt.type === 'hit') {
      this._spawnPulse(evt.lane, GRADE_COLORS[evt.grade] || 0xffffff, evt.grade === 'perfect' ? 1.6 : 1.1);
      this._spawnSparks(evt.lane, GRADE_COLORS[evt.grade] || 0xffffff, evt.grade === 'perfect' ? 22 : evt.grade === 'great' ? 14 : 8);
      this._laneFlash[evt.lane] = 1;
      if (!this.reducedMotion && evt.combo > 0 && evt.combo % 25 === 0) this._shake = Math.min(1, this._shake + 0.35);
    } else if (evt.type === 'miss' || evt.type === 'early-release') {
      this._spawnPulse(evt.lane, GRADE_COLORS.miss, 0.8);
      if (!this.reducedMotion) this._shake = Math.min(1, this._shake + 0.15);
    } else if (evt.type === 'hold-complete') {
      this._spawnPulse(evt.lane, this._holdColor(), 1.2);
      this._spawnSparks(evt.lane, this._holdColor(), 16);
    } else if (evt.type === 'terminal') {
      if (!this.reducedMotion) this._shake = 0;
    }
  }

  _spawnPulse(lane, color, strength) {
    const p = this.pulsePool.find((x) => !x.active);
    if (!p) return;
    p.active = true;
    p.age = 0;
    p.strength = strength;
    p.mesh.visible = true;
    p.mesh.position.set(this._laneX(lane), 0.14, RECEPTOR_Z);
    p.mat.color.set(color);
    p.mat.opacity = 0.85;
  }

  // Sparks are a cosmetic tier above the pulse ring; reduced motion drops them.
  _spawnSparks(lane, hex, n) {
    if (this.q.particles !== 'high' || !this._motion) return;
    const c = new THREE.Color(hex).multiplyScalar(2.2);
    const x0 = this._laneX(lane);
    const r = this._fxRng;
    for (let k = 0; k < n; k++) {
      const i = this._sparkNext;
      this._sparkNext = (this._sparkNext + 1) % SPARKS;
      const a = r.next() * Math.PI * 2;
      const sp = 1.5 + r.next() * 3;
      this.sparkPos[i * 3] = x0 + Math.cos(a) * 0.3;
      this.sparkPos[i * 3 + 1] = 0.25;
      this.sparkPos[i * 3 + 2] = RECEPTOR_Z + Math.sin(a) * 0.3;
      this.sparkVel[i * 3] = Math.cos(a) * sp * 0.7;
      this.sparkVel[i * 3 + 1] = 3 + r.next() * 4;
      this.sparkVel[i * 3 + 2] = Math.sin(a) * sp * 0.5 - 0.8;
      this.sparkLife[i] = 0.5 + r.next() * 0.4;
      this.sparkBase[i * 3] = c.r; this.sparkBase[i * 3 + 1] = c.g; this.sparkBase[i * 3 + 2] = c.b;
    }
  }

  _updateParticles(dt, animated) {
    if (!this.sparks.visible) return;
    let any = false;
    for (let i = 0; i < SPARKS; i++) {
      if (this.sparkLife[i] <= 0) continue;
      any = true;
      this.sparkLife[i] -= dt;
      const j = i * 3;
      if (this.sparkLife[i] <= 0) { this.sparkPos[j + 1] = -50; this.sparkCol[j] = this.sparkCol[j + 1] = this.sparkCol[j + 2] = 0; continue; }
      this.sparkVel[j + 1] -= 9.8 * dt;
      this.sparkPos[j] += this.sparkVel[j] * dt;
      this.sparkPos[j + 1] = Math.max(0.08, this.sparkPos[j + 1] + this.sparkVel[j + 1] * dt);
      this.sparkPos[j + 2] += this.sparkVel[j + 2] * dt;
      const f = Math.min(1, this.sparkLife[i] * 2.2);
      this.sparkCol[j] = this.sparkBase[j] * f; this.sparkCol[j + 1] = this.sparkBase[j + 1] * f; this.sparkCol[j + 2] = this.sparkBase[j + 2] * f;
    }
    if (any || this._sparksDirty) {
      this.sparks.geometry.attributes.position.needsUpdate = true;
      this.sparks.geometry.attributes.color.needsUpdate = true;
    }
    this._sparksDirty = any;
    if (animated) { // motes drift slowly toward the camera
      for (let i = 0; i < MOTES; i++) {
        const j = i * 3;
        this.motePos[j + 2] += dt * 2.2;
        this.motePos[j + 1] += Math.sin(this._time * 0.7 + i) * dt * 0.08;
        if (this.motePos[j + 2] > 10) this.motePos[j + 2] -= 92;
      }
      this.motes.geometry.attributes.position.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------
  update(snap, dtMs) {
    if (this._disposed) return;
    const dt = Math.min(dtMs, 100) / 1000;
    this._time += dt;
    const leadMs = 2400 / this.noteSpeed;
    const animated = this.q.background === 'animated' && this._motion;

    // Notes from snapshot (render-only; rules state untouched).
    const usedNotes = new Set();
    const usedHolds = new Set();
    if (snap) {
      for (const n of snap.notes) {
        if (n.state === 'missed' || n.state === 'hit' || n.state === 'released') continue;
        const timeUntil = n.time - snap.tick;
        if (n.state === 'pending' && timeUntil > leadMs) continue;
        if (n.kind === 'tap') {
          const p = this.notePool.find((x) => !x.inUse || x.noteId === n.id);
          if (!p) continue;
          if (!p.inUse) { p.inUse = true; p.noteId = n.id; }
          usedNotes.add(p);
          const z = n.state === 'pending' ? -(timeUntil / leadMs) * TRACK_LEN : RECEPTOR_Z;
          p.mesh.visible = true;
          p.mesh.position.set(this._laneX(n.lane), NOTE_Y + 0.3, Math.min(z, RECEPTOR_Z));
          const s = n.state === 'holding' ? 0.7 : 1;
          p.mesh.scale.setScalar(s);
          if (!this.reducedMotion) p.mesh.rotation.y = this._time * 2 + n.id;
        } else {
          const h = this.holdPool.find((x) => !x.inUse || x.noteId === n.id);
          if (!h) continue;
          if (!h.inUse) { h.inUse = true; h.noteId = n.id; }
          usedHolds.add(h);
          const headUntil = n.time - snap.tick;
          const tailUntil = n.time + n.duration - snap.tick;
          const headZ = Math.min(-(Math.max(headUntil, 0) / leadMs) * TRACK_LEN, RECEPTOR_Z);
          const tailZ = Math.max(-(tailUntil / leadMs) * TRACK_LEN, -TRACK_LEN);
          const clampedHead = n.state === 'holding' ? RECEPTOR_Z : headZ;
          const len = Math.max(0.3, clampedHead - tailZ);
          h.mesh.visible = true;
          h.mesh.scale.set(1, 1, len);
          h.mesh.position.set(this._laneX(n.lane), NOTE_Y + 0.15, (clampedHead + tailZ) / 2);
          h.mat.emissiveIntensity = n.state === 'holding' ? 1.6 : 0.95;
        }
      }
    }
    for (const p of this.notePool) if (p.inUse && !usedNotes.has(p)) { p.inUse = false; p.noteId = -1; p.mesh.visible = false; }
    for (const h of this.holdPool) if (h.inUse && !usedHolds.has(h)) { h.inUse = false; h.noteId = -1; h.mesh.visible = false; }

    // Receptor + lane feedback (input acknowledgment tier).
    for (let i = 0; i < LANES; i++) {
      this._laneFlash[i] = Math.max(0, this._laneFlash[i] - dt * 5);
      const held = this._laneHeld[i];
      const glow = 0.7 + this._laneFlash[i] * 1.6 + (held ? 0.6 : 0);
      this.receptors[i].material.emissiveIntensity = glow;
      this.receptors[i].scale.setScalar(held ? 1.12 : 1);
      this.laneMats[i].emissiveIntensity = 0.06 + this._laneFlash[i] * 0.5 + (held ? 0.18 : 0);
    }

    // Judgment line breathes with the beat; the beat phase also drives the
    // sky glow and pylon caps when the background is animated.
    this._beat = 0;
    if (snap && snap.running) {
      const beatMs = 60000 / snap.bpm;
      const phase = (snap.tick % beatMs) / beatMs;
      this._beat = 1 - phase;
      this.judgeLine.scale.y = 1 + (1 - phase) * 0.6;
    }

    // Lane surface flows with the notes (same world speed), so the beat rungs
    // read as a moving floor; idle drift on menus.
    if (animated && this.laneMats[0].map) {
      const worldPerTile = (TRACK_LEN + 8) / this.laneTex.repeat.y;
      const dist = snap && snap.running ? (snap.tick / leadMs) * TRACK_LEN : this._time * 3;
      this.laneTex.offset.y = (dist / worldPerTile) % 1;
    }

    // Pulse effects.
    for (const p of this.pulsePool) {
      if (!p.active) continue;
      p.age += dt * (this.reducedMotion ? 2.5 : 1.6);
      if (p.age >= 1) { p.active = false; p.mesh.visible = false; continue; }
      const s = 1 + p.age * 5 * p.strength;
      p.mesh.scale.setScalar(s);
      p.mat.opacity = 0.85 * (1 - p.age);
    }
    this._updateParticles(dt, animated);

    // Environment life: arches drift slowly toward camera (deterministic phase).
    if (animated) {
      for (let i = 0; i < this.arches.length; i++) {
        const a = this.arches[i];
        a.position.z += dt * 1.2;
        if (a.position.z > 6) a.position.z -= 16 * this.arches.length;
        a.material.opacity = 0.4 + 0.3 * Math.sin(this._time * 0.8 + i);
      }
      this.stars.rotation.y = this._time * 0.004;
      this.skyU.uTime.value = this._time;
      this.skyU.uBeat.value = this._beat;
      this._hdr(this.capMat.color, this.theme.accent, 1.1 + this._beat * 1.2);
    } else {
      this.skyU.uBeat.value = 0;
    }

    // Camera: authored base + seeded sway + tiered shake. Never cumulative lerp.
    const camPos = this._baseCamPos.clone();
    const lookAt = this._baseLookAt.clone();
    if (!this.reducedMotion && this.cameraSway && snap && snap.running) {
      const sway = 0.22;
      camPos.x += Math.sin(this._time * 0.5 + this._swayPhase) * sway;
      camPos.y += Math.sin(this._time * 0.33 + this._swayPhase * 2) * sway * 0.4;
    }
    if (this._shake > 0 && !this.reducedMotion) {
      this._shake = Math.max(0, this._shake - dt * 2.2);
      const amp = this._shake * 0.12; // low amplitude, never changes raycast truth
      camPos.x += (this._rng.next() - 0.5) * amp;
      camPos.y += (this._rng.next() - 0.5) * amp;
    }
    this.camera.position.copy(camPos);
    this.camera.lookAt(lookAt);

    this._render(dtMs);
  }

  resize() {
    if (!this.renderer) return;
    // Fall back to the viewport when the host is not yet laid out, so the
    // playfield canvas is never left at the default 1x1.
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this._applyFraming();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.size = [w, h];
    this.composer?.setSize(w, h);
    this.postKey = null;
  }

  get is3D() { return true; }

  hide() { if (this.renderer) this.renderer.domElement.style.visibility = 'hidden'; }
  show() { if (this.renderer) this.renderer.domElement.style.visibility = 'visible'; }

  dispose() {
    this._disposed = true;
    this.composer?.dispose();
    this.scene?.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    this.envMap?.dispose();
    this.laneTex?.dispose(); this.gridTex?.dispose(); this.sparkTex?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
  }
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

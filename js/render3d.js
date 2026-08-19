// Three.js renderer: the reactive concert causeway made of light.
// Rendering consumes immutable session snapshots + interpolation alpha only;
// it never mutates rules state. Cosmetic particles never intercept raycasts
// (lane picking uses a dedicated interaction layer).

import * as THREE from './vendor/three.module.min.js';
import { makeRng, streamSeed } from './rng.js';

export const LANES = 4;
const LANE_W = 1.7;
const TRACK_LEN = 64;          // world units from receptor to horizon
const RECEPTOR_Z = 0;
const NOTE_Y = 0.12;

// Authored framing constants (exposed, not magic offsets).
export const FRAMING = {
  portrait: { camPos: [0, 9.2, 12.5], lookAt: [0, 1.8, -15], fov: 56 },
  landscape: { camPos: [0, 7.5, 11.5], lookAt: [0, 1.4, -14], fov: 50 },
};

const GRADE_COLORS = { perfect: 0xfff6a8, great: 0x7dffb0, good: 0x8ab8ff, miss: 0x666a75 };

export function laneX(lane) { return (lane - (LANES - 1) / 2) * LANE_W; }

export class Renderer3D {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.theme = options.theme;
    this.cvd = !!options.cvdPalette;
    this.reducedMotion = !!options.reducedMotion;
    this.cameraSway = options.cameraSway !== false;
    this.noteSpeed = options.noteSpeed || 1;
    this.quality = options.quality || 'high';
    this.onLaneInput = options.onLaneInput || (() => {});
    this._rng = makeRng(streamSeed(options.seed || 1, 'visual'));
    this._time = 0;
    this._disposed = false;
    this._swayPhase = this._rng.next() * Math.PI * 2;
    this._shake = 0;
    this._laneFlash = [0, 0, 0, 0];
    this._laneHeld = [false, false, false, false];
    this._effects = []; // active transient effects
    this._buildRenderer();
    this._buildScene();
    this._bindPointer();
  }

  // -------------------------------------------------------------------------
  _buildRenderer() {
    const dprCap = { high: 2, medium: 1.5, low: 1 }[this.quality] || 2;
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = this.quality === 'high';
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

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    this._applyFraming();

    // Lighting: one dominant key, soft environment fill, contact grounding.
    this.keyLight = new THREE.DirectionalLight(t.keyLight, 2.2);
    this.keyLight.position.set(6, 14, 8);
    this.keyLight.castShadow = this.quality === 'high';
    this.keyLight.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.keyLight);
    this.hemi = new THREE.HemisphereLight(t.fog, t.sky, 0.9);
    this.scene.add(this.hemi);

    // --- Causeway: lane strips ---
    this.laneGroup = new THREE.Group();
    this.scene.add(this.laneGroup);
    const laneGeo = new THREE.BoxGeometry(LANE_W - 0.12, 0.08, TRACK_LEN + 8);
    this.laneMeshes = [];
    this.laneMats = [];
    for (let i = 0; i < LANES; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: t.lane, roughness: 0.35, metalness: 0.6,
        emissive: t.laneEdge, emissiveIntensity: 0.06,
      });
      const m = new THREE.Mesh(laneGeo, mat);
      m.position.set(laneX(i), 0, -TRACK_LEN / 2 + 4);
      m.receiveShadow = true;
      m.userData.lane = i;
      this.laneGroup.add(m);
      this.laneMeshes.push(m);
      this.laneMats.push(mat);
    }
    // Lane edge light strips.
    const edgeGeo = new THREE.BoxGeometry(0.05, 0.1, TRACK_LEN + 8);
    const edgeMat = new THREE.MeshBasicMaterial({ color: this.cvd ? this.options.cvdColors.laneEdge : t.laneEdge });
    for (let i = 0; i <= LANES; i++) {
      const e = new THREE.Mesh(edgeGeo, edgeMat);
      e.position.set(laneX(i - 0.5) - LANE_W / 2 + LANE_W * 0 + (i === 0 ? 0 : 0), 0.02, -TRACK_LEN / 2 + 4);
      e.position.x = laneX(0) - LANE_W / 2 + i * LANE_W;
      this.laneGroup.add(e);
    }

    // --- Judgment line + receptors ---
    const lineGeo = new THREE.BoxGeometry(LANE_W * LANES + 0.4, 0.12, 0.18);
    const lineMat = new THREE.MeshBasicMaterial({ color: this.cvd ? this.options.cvdColors.receptor : t.receptor });
    this.judgeLine = new THREE.Mesh(lineGeo, lineMat);
    this.judgeLine.position.set(0, 0.08, RECEPTOR_Z);
    this.scene.add(this.judgeLine);

    this.receptors = [];
    const recGeo = new THREE.CylinderGeometry(0.55, 0.62, 0.1, 24);
    for (let i = 0; i < LANES; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x0a0a12, roughness: 0.3, metalness: 0.8,
        emissive: this.cvd ? this.options.cvdColors.receptor : t.receptor, emissiveIntensity: 0.7,
      });
      const r = new THREE.Mesh(recGeo, mat);
      r.position.set(laneX(i), 0.1, RECEPTOR_Z);
      this.scene.add(r);
      this.receptors.push(r);
    }

    // --- Note pools (tap gems + hold bars) ---
    this.notePool = [];
    const tapGeo = new THREE.OctahedronGeometry(0.5);
    tapGeo.scale(1, 0.55, 1);
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: this._noteColor(), roughness: 0.2, metalness: 0.4,
        emissive: this._noteColor(), emissiveIntensity: 1.6,
      });
      const m = new THREE.Mesh(tapGeo, mat);
      m.visible = false;
      m.castShadow = this.quality === 'high';
      this.scene.add(m);
      this.notePool.push({ mesh: m, mat, inUse: false, noteId: -1, kind: 'tap' });
    }
    this.holdPool = [];
    const holdGeo = new THREE.BoxGeometry(0.5, 0.16, 1); // z scaled per note
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: this._holdColor(), roughness: 0.25, metalness: 0.4,
        emissive: this._holdColor(), emissiveIntensity: 1.2, transparent: true, opacity: 0.95,
      });
      const m = new THREE.Mesh(holdGeo, mat);
      m.visible = false;
      this.scene.add(m);
      this.holdPool.push({ mesh: m, mat, inUse: false, noteId: -1 });
    }

    // --- Environment: instanced pylons + arches, deterministic placement ---
    this.envGroup = new THREE.Group();
    this.scene.add(this.envGroup);
    const pylonCount = this.quality === 'low' ? 12 : 24;
    const pylonGeo = new THREE.CylinderGeometry(0.3, 0.55, 7, 6);
    const pylonMat = new THREE.MeshStandardMaterial({
      color: t.env, roughness: 0.6, metalness: 0.3, emissive: t.env, emissiveIntensity: 0.25,
    });
    const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, pylonCount * 2);
    const mtx = new THREE.Matrix4();
    let idx = 0;
    const envRng = makeRng(streamSeed(this.options.seed || 1, 'env'));
    for (let i = 0; i < pylonCount; i++) {
      const z = -8 - i * 7 - envRng.next() * 3;
      for (const side of [-1, 1]) {
        const x = side * (LANE_W * LANES * 0.5 + 2.2 + envRng.next() * 2.5);
        const s = 0.7 + envRng.next() * 0.9;
        mtx.makeScale(s, s * (0.8 + envRng.next() * 0.6), s);
        mtx.setPosition(x, 3 * s, z);
        pylons.setMatrixAt(idx++, mtx);
      }
    }
    pylons.instanceMatrix.needsUpdate = true;
    this.envGroup.add(pylons);

    // Light arches across the causeway every so often.
    const archCount = this.quality === 'low' ? 4 : 8;
    const archGeo = new THREE.TorusGeometry(LANE_W * LANES * 0.62, 0.09, 8, 40, Math.PI);
    const archMat = new THREE.MeshBasicMaterial({ color: t.accent, transparent: true, opacity: 0.65 });
    this.arches = [];
    for (let i = 0; i < archCount; i++) {
      const a = new THREE.Mesh(archGeo, archMat);
      a.position.set(0, 0, -18 - i * 16);
      this.envGroup.add(a);
      this.arches.push(a);
    }

    // Starfield / sky dust (cosmetic layer; never raycast).
    const starCount = this.quality === 'low' ? 200 : 700;
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
      color: 0xaFC8ff, size: 0.35, sizeAttenuation: true, transparent: true, opacity: 0.8, fog: false,
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
    this.hemi.color.set(theme.fog);
    this.hemi.groundColor.set(theme.sky);
    for (const m of this.laneMats) { m.color.set(theme.lane); m.emissive.set(cvd ? this.options.cvdColors.laneEdge : theme.laneEdge); }
    this.judgeLine.material.color.set(cvd ? this.options.cvdColors.receptor : theme.receptor);
    for (const r of this.receptors) r.material.emissive.set(cvd ? this.options.cvdColors.receptor : theme.receptor);
    for (const p of this.notePool) { p.mat.color.set(this._noteColor()); p.mat.emissive.set(this._noteColor()); }
    for (const p of this.holdPool) { p.mat.color.set(this._holdColor()); p.mat.emissive.set(this._holdColor()); }
    for (const a of this.arches) a.material.color.set(theme.accent);
  }

  setQuality(q) {
    this.quality = q;
    const dprCap = { high: 2, medium: 1.5, low: 1 }[q] || 2;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
    this.envGroup.visible = q !== 'low';
    this.stars.visible = q !== 'low';
    this.resize();
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
    const lane = Math.round(x / LANE_W + (LANES - 1) / 2);
    return lane >= 0 && lane < LANES ? lane : null;
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
      this._laneFlash[evt.lane] = 1;
      if (!this.reducedMotion && evt.combo > 0 && evt.combo % 25 === 0) this._shake = Math.min(1, this._shake + 0.35);
    } else if (evt.type === 'miss' || evt.type === 'early-release') {
      this._spawnPulse(evt.lane, GRADE_COLORS.miss, 0.8);
      if (!this.reducedMotion) this._shake = Math.min(1, this._shake + 0.15);
    } else if (evt.type === 'hold-complete') {
      this._spawnPulse(evt.lane, this._holdColor(), 1.2);
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
    p.mesh.position.set(laneX(lane), 0.14, RECEPTOR_Z);
    p.mat.color.set(color);
    p.mat.opacity = 0.85;
  }

  // -------------------------------------------------------------------------
  update(snap, dtMs) {
    if (this._disposed) return;
    const dt = Math.min(dtMs, 100) / 1000;
    this._time += dt;
    const leadMs = 2400 / this.noteSpeed;

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
          p.mesh.position.set(laneX(n.lane), NOTE_Y + 0.3, Math.min(z, RECEPTOR_Z));
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
          h.mesh.position.set(laneX(n.lane), NOTE_Y + 0.15, (clampedHead + tailZ) / 2);
          h.mat.emissiveIntensity = n.state === 'holding' ? 1.9 : 1.2;
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

    // Judgment line breathes with the beat.
    if (snap && snap.running) {
      const beatMs = 60000 / snap.bpm;
      const phase = (snap.tick % beatMs) / beatMs;
      this.judgeLine.material.color.set(this.cvd ? this.options.cvdColors.receptor : this.theme.receptor);
      this.judgeLine.scale.y = 1 + (1 - phase) * 0.6;
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

    // Environment life: arches drift slowly toward camera (deterministic phase).
    if (!this.reducedMotion) {
      for (let i = 0; i < this.arches.length; i++) {
        const a = this.arches[i];
        a.position.z += dt * 1.2;
        if (a.position.z > 6) a.position.z -= 16 * this.arches.length;
        a.material.opacity = 0.4 + 0.3 * Math.sin(this._time * 0.8 + i);
      }
      this.stars.rotation.y = this._time * 0.004;
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

    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    if (!this.renderer) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this._applyFraming();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  hide() { if (this.renderer) this.renderer.domElement.style.visibility = 'hidden'; }
  show() { if (this.renderer) this.renderer.domElement.style.visibility = 'visible'; }

  dispose() {
    this._disposed = true;
    this.scene?.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
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

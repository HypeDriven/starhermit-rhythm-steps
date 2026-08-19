// 2D canvas fallback renderer. Same interface as Renderer3D so the game stays
// fully playable when WebGL is unavailable (compatibility message is shown
// by the UI layer; session state is preserved).

const GRADE_COLORS = { perfect: '#fff6a8', great: '#7dffb0', good: '#8ab8ff', miss: '#666a75' };

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }

export class Renderer2D {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.theme = options.theme;
    this.cvd = !!options.cvdPalette;
    this.reducedMotion = !!options.reducedMotion;
    this.noteSpeed = options.noteSpeed || 1;
    this.onLaneInput = options.onLaneInput || (() => {});
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas game-canvas-2d';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._laneFlash = [0, 0, 0, 0];
    this._laneHeld = [false, false, false, false];
    this._effects = [];
    this._time = 0;
    this._bindPointer();
    this.resize();
  }

  get is3D() { return false; }

  _bindPointer() {
    this._activePointers = new Map();
    this.canvas.addEventListener('pointerdown', (e) => {
      const lane = this.laneAt(e.clientX, e.clientY);
      if (lane == null) return;
      this.canvas.setPointerCapture(e.pointerId);
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
    this.canvas.addEventListener('pointerup', (e) => release(e, false));
    this.canvas.addEventListener('pointercancel', (e) => release(e, true));
  }

  laneAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const laneW = rect.width / 4;
    const lane = Math.floor((clientX - rect.left) / laneW);
    return lane >= 0 && lane < 4 ? lane : null;
  }

  pressLane(lane, held) { this._laneHeld[lane] = held; if (held) this._laneFlash[lane] = 1; }

  setTheme(theme, cvd = this.cvd) { this.theme = theme; this.cvd = cvd; }
  setQuality() {}
  setReducedMotion(v) { this.reducedMotion = v; }
  setNoteSpeed(v) { this.noteSpeed = v; }

  event(evt) {
    if (evt.type === 'hit' || evt.type === 'miss' || evt.type === 'hold-complete' || evt.type === 'early-release') {
      const color = evt.type === 'hit' ? GRADE_COLORS[evt.grade]
        : evt.type === 'hold-complete' ? hex(this.cvd ? this.options.cvdColors.hold : this.theme.hold)
        : GRADE_COLORS.miss;
      this._effects.push({ lane: evt.lane, age: 0, color });
      this._laneFlash[evt.lane] = 1;
    }
  }

  update(snap, dtMs) {
    const dt = Math.min(dtMs, 100) / 1000;
    this._time += dt;
    const { ctx, canvas } = this;
    const w = canvas.width / (devicePixelRatio || 1);
    const h = canvas.height / (devicePixelRatio || 1);
    const t = this.theme;
    const laneW = w / 4;
    const judgeY = h * 0.85;
    const leadMs = 2400 / this.noteSpeed;

    ctx.fillStyle = hex(t.sky);
    ctx.fillRect(0, 0, w, h);

    // Lanes.
    for (let i = 0; i < 4; i++) {
      const flash = this._laneFlash[i];
      ctx.fillStyle = hex(t.lane);
      ctx.fillRect(i * laneW + 2, 0, laneW - 4, h);
      if (flash > 0 || this._laneHeld[i]) {
        ctx.fillStyle = hex(this.cvd ? this.options.cvdColors.laneEdge : t.laneEdge);
        ctx.globalAlpha = Math.min(0.5, flash * 0.4 + (this._laneHeld[i] ? 0.15 : 0));
        ctx.fillRect(i * laneW + 2, 0, laneW - 4, h);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = hex(this.cvd ? this.options.cvdColors.laneEdge : t.laneEdge);
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(i * laneW + 2, 0, laneW - 4, h);
      ctx.globalAlpha = 1;
    }

    // Judgment line + receptors.
    ctx.fillStyle = hex(this.cvd ? this.options.cvdColors.receptor : t.receptor);
    ctx.fillRect(0, judgeY - 2, w, 4);
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(i * laneW + laneW / 2, judgeY, laneW * 0.28 * (this._laneHeld[i] ? 1.15 : 1), 0, Math.PI * 2);
      ctx.strokeStyle = hex(this.cvd ? this.options.cvdColors.receptor : t.receptor);
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Notes.
    if (snap) {
      for (const n of snap.notes) {
        if (n.state === 'missed' || n.state === 'hit' || n.state === 'released') continue;
        const timeUntil = n.time - snap.tick;
        if (n.state === 'pending' && timeUntil > leadMs) continue;
        const yFor = (until) => judgeY - (Math.max(until, 0) / leadMs) * judgeY;
        const x = n.lane * laneW + laneW / 2;
        if (n.kind === 'tap') {
          const y = n.state === 'holding' ? judgeY : yFor(timeUntil);
          ctx.fillStyle = hex(this.cvd ? this.options.cvdColors.note : t.note);
          ctx.beginPath();
          ctx.arc(x, y, laneW * 0.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const headY = n.state === 'holding' ? judgeY : yFor(timeUntil);
          const tailY = Math.min(yFor(timeUntil + n.duration), judgeY);
          ctx.fillStyle = hex(this.cvd ? this.options.cvdColors.hold : t.hold);
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x - laneW * 0.12, headY, laneW * 0.24, Math.max(6, tailY - headY));
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, headY, laneW * 0.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Hit effects.
    this._effects = this._effects.filter((fx) => fx.age < 1);
    for (const fx of this._effects) {
      fx.age += dt * (this.reducedMotion ? 2.5 : 1.6);
      const x = fx.lane * laneW + laneW / 2;
      ctx.beginPath();
      ctx.arc(x, judgeY, laneW * (0.25 + fx.age * 0.5), 0, Math.PI * 2);
      ctx.strokeStyle = fx.color;
      ctx.globalAlpha = 0.9 * (1 - fx.age);
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (let i = 0; i < 4; i++) this._laneFlash[i] = Math.max(0, this._laneFlash[i] - dt * 5);
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  hide() { this.canvas.style.visibility = 'hidden'; }
  show() { this.canvas.style.visibility = 'visible'; }
  dispose() { this.canvas.remove(); }
}

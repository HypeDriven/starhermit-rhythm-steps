// Graphics section of the Settings panel: quality preset, render scale,
// per-effect overrides, adaptive resolution, frame-rate readout and a cost
// summary. Every control carries a stable id and data-gfx attribute.

import { PRESETS, CATEGORIES, resolve, presetTier, choosePreset, describe } from './gfx.js';
import { gfxStrings, fmt } from './gfx-i18n.js';

let ctl = null;
let T = gfxStrings();
let summaryTimer = null;

const $ = (id) => document.getElementById(id);

export function initGraphicsPanel(controller) {
  ctl = controller;
  T = gfxStrings();
  $('gfx-legend').textContent = T.legend;
  buildGraphicsPanel();
  clearInterval(summaryTimer);
  // Keep the summary (pixels, adaptive scale) current while the panel is open.
  summaryTimer = setInterval(() => {
    if (!$('screen-settings')?.classList.contains('hidden')) refreshSummary();
  }, 1000);
}

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

function field(labelText, control, cls = 'field') {
  const l = document.createElement('label');
  l.className = cls;
  const span = document.createElement('span');
  span.textContent = labelText;
  if (cls === 'check') { l.append(control, span); } else { l.append(span, control); }
  return l;
}

export function buildGraphicsPanel() {
  if (!ctl) return;
  const host = $('gfx-controls');
  host.innerHTML = '';
  const saved = ctl.getGfx() || {};
  const detected = ctl.detectedPreset();
  const r = resolve(saved, detected);

  // Quality preset.
  const q = document.createElement('select');
  q.id = 'set-quality';
  q.dataset.gfx = 'preset';
  q.append(option('auto', fmt(T.auto, { tier: T.presets[detected] }), r.auto));
  for (const p of PRESETS) q.append(option(p, T.presets[p], !r.auto && r.preset === p));
  q.addEventListener('change', () => { commit(choosePreset(ctl.getGfx(), q.value)); });
  host.append(field(T.quality, q));

  // Render scale 50–200 %.
  const scaleWrap = document.createElement('label');
  scaleWrap.className = 'field gfx-range';
  const head = document.createElement('span');
  head.className = 'gfx-range-head';
  const name = document.createElement('span');
  name.textContent = T.renderScale;
  const out = document.createElement('output');
  out.id = 'gfx-render-scale-value';
  const pct = Math.round((Number(saved.render_scale) || 1) * 100);
  out.textContent = `${pct}%`;
  head.append(name, out);
  const range = document.createElement('input');
  Object.assign(range, { type: 'range', id: 'gfx-render-scale', min: '50', max: '200', step: '5', value: String(pct) });
  range.dataset.gfx = 'render_scale';
  range.addEventListener('input', () => { out.textContent = `${range.value}%`; });
  range.addEventListener('change', () => commit({ ...ctl.getGfx(), render_scale: Number(range.value) / 100 }, false));
  scaleWrap.append(head, range);
  host.append(scaleWrap);

  // Per-category overrides.
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = document.createElement('select');
    sel.id = `gfx-${cat}`;
    sel.dataset.gfx = cat;
    const own = tiers.includes(saved[cat]) ? saved[cat] : 'preset';
    sel.append(option('preset', fmt(T.fromPreset, { tier: T.tiers[presetTier(r.preset, cat)] }), own === 'preset'));
    for (const t of tiers) sel.append(option(t, T.tiers[t], own === t));
    sel.addEventListener('change', () => {
      const next = { ...ctl.getGfx() };
      if (sel.value === 'preset') delete next[cat]; else next[cat] = sel.value;
      commit(next, false);
    });
    host.append(field(T.cats[cat], sel));
  }

  const toggles = document.createElement('div');
  toggles.className = 'gfx-toggles';
  const adaptive = document.createElement('input');
  Object.assign(adaptive, { type: 'checkbox', id: 'gfx-adaptive', checked: r.adaptive });
  adaptive.dataset.gfx = 'adaptive';
  adaptive.addEventListener('change', () => commit({ ...ctl.getGfx(), adaptive: adaptive.checked }, false));
  const fps = document.createElement('input');
  Object.assign(fps, { type: 'checkbox', id: 'gfx-show-fps', checked: r.showFps });
  fps.dataset.gfx = 'show_fps';
  fps.addEventListener('change', () => commit({ ...ctl.getGfx(), show_fps: fps.checked }, false));
  toggles.append(field(T.adaptive, adaptive, 'check'), field(T.showFps, fps, 'check'));
  host.append(toggles);

  const summary = document.createElement('p');
  summary.id = 'gfx-summary';
  summary.className = 'muted gfx-summary';
  summary.setAttribute('aria-live', 'polite');
  const note = document.createElement('p');
  note.id = 'gfx-post-note';
  note.className = 'gfx-note hidden';
  host.append(summary, note);
  refreshSummary();
}

// Apply + persist; a preset change rebuilds the controls so labels follow it.
function commit(next, rebuild = true) {
  ctl.setGfx(next);
  if (rebuild) {
    const focusId = document.activeElement?.id;
    buildGraphicsPanel();
    if (focusId) $(focusId)?.focus();
  } else {
    refreshSummary();
  }
}

export function refreshSummary() {
  const el = $('gfx-summary');
  if (!el || !ctl) return;
  const info = ctl.graphicsInfo();
  const note = $('gfx-post-note');
  if (!info) {
    el.textContent = '';
    note.textContent = T.fallback;
    note.classList.remove('hidden');
    return;
  }
  el.textContent = `${info.gpu} · ${describe(info.resolved, info.pixels, T.words)}`;
  note.textContent = T.postFailed;
  note.classList.toggle('hidden', !info.postFailed);
}

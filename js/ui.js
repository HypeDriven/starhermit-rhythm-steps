// UI: semantic HTML shell over the canvas. Menus, forms, settings, help, and
// assistive descriptions are real DOM. UI state is fully separate from
// simulation state — closing a drawer can never affect a match.

import { JOURNEY_STAGES, CHALLENGES, PRACTICE_DIFFICULTIES, THEMES, LESSONS, dailyInfo } from './content.js';
import { ACHIEVEMENTS } from './persistence.js';
import { isHosted, fetchGameInfo, fetchLeaderboard } from './platform.js';
import { compareResults, chaseEntry } from './rules.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['title', 'setup', 'journey', 'practice', 'challenge', 'learn', 'chase', 'results', 'settings', 'help', 'profile'];

let ctl = null; // controller callbacks provided by main.js
let navStack = [];
let lastFocused = null;

export function initUI(controller) {
  ctl = controller;

  // Navigation buttons.
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      ctl.uiSound('back');
      if (target === 'back') navBack();
      else showScreen(target);
    });
  });
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.openMode(btn.dataset.mode); });
  });

  $('btn-play').addEventListener('click', () => { ctl.uiSound('confirm'); ctl.quickPlay(); });
  $('btn-setup-start').addEventListener('click', () => { ctl.uiSound('confirm'); ctl.confirmSetup(); });
  $('btn-pause').addEventListener('click', () => ctl.pauseGame());
  $('btn-resume').addEventListener('click', () => ctl.resumeGame());
  $('btn-pause-restart').addEventListener('click', () => ctl.restartTrack());
  $('btn-pause-settings').addEventListener('click', () => { showScreen('settings', { overlay: true }); });
  $('btn-pause-help').addEventListener('click', () => { showScreen('help', { overlay: true }); });
  $('btn-leave').addEventListener('click', () => ctl.leaveGame());
  $('btn-retry').addEventListener('click', () => { ctl.uiSound('confirm'); ctl.retry(); });
  $('btn-next').addEventListener('click', () => { ctl.uiSound('confirm'); ctl.nextStage(); });
  $('btn-chase-start').addEventListener('click', () => {
    const seed = parseInt($('chase-seed').value, 10);
    if (!Number.isFinite(seed)) { toast('Enter a numeric seed'); ctl.uiSound('error'); return; }
    ctl.startChase(seed >>> 0, $('chase-difficulty').value);
  });
  $('btn-chase-random').addEventListener('click', () => {
    $('chase-seed').value = String(Math.floor(Math.random() * 1e9));
    renderChaseBoard();
  });
  // The local board always reflects the seed currently in the field.
  $('chase-seed').addEventListener('input', () => renderChaseBoard());
  $('btn-replay-tutorial').addEventListener('click', () => ctl.openMode('learn'));
  $('btn-reset-save').addEventListener('click', () => {
    if (confirm('Reset ALL local progress, settings, and achievements?')) ctl.resetSave();
  });
  $('profile-name').addEventListener('change', () => {
    ctl.updateProfile({ displayName: $('profile-name').value.slice(0, 24) || 'Guest' });
  });

  buildSettingsPanel();
  buildHelpCards();
}

// ---------------------------------------------------------------------------
// Screen routing with focus management (restore focus after every modal).
// ---------------------------------------------------------------------------
export function showScreen(name, { overlay = false } = {}) {
  if (!overlay) {
    for (const s of SCREENS) $(`screen-${s}`).classList.toggle('hidden', s !== name);
    // The playfield/canvas stays laid out as the backdrop behind the opaque
    // screens (z-index 10) so the renderer keeps a real viewport size. It is
    // made inert so its lane/pause buttons stay out of the tab order and out of
    // the accessibility tree while a menu covers them.
    setPlayfieldInert(true);
    hidePause();
    navStack = navStack.filter((n) => n !== name);
    navStack.push(name);
    if (navStack.length > 8) navStack.shift();
  } else {
    $(`screen-${name}`).classList.remove('hidden');
    $(`screen-${name}`).style.zIndex = 50;
  }
  lastFocused = document.activeElement;
  const heading = $(`screen-${name}`)?.querySelector('h1, h2');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  announce(heading ? heading.textContent : name);
  if (name === 'journey') renderJourney();
  if (name === 'practice') renderPractice();
  if (name === 'challenge') renderChallenges();
  if (name === 'learn') renderLessons();
  if (name === 'chase') renderChase();
  if (name === 'profile') renderProfile();
  if (name === 'title') renderTitle();
}

function findOverlayScreen() {
  return SCREENS.map((s) => $(`screen-${s}`)).find((el) => el.style.zIndex === '50' && !el.classList.contains('hidden'));
}

// True when settings/help is stacked over the pause menu.
export function overlayScreenVisible() { return !!findOverlayScreen(); }

export function navBack() {
  // Close an overlay screen (settings/help opened over pause) first.
  const overlayScreen = findOverlayScreen();
  if (overlayScreen) {
    overlayScreen.classList.add('hidden');
    overlayScreen.style.zIndex = '';
    if (lastFocused?.focus) lastFocused.focus();
    return 'overlay';
  }
  const current = navStack.pop();
  const prev = navStack[navStack.length - 1] || 'title';
  setPlayfieldInert(true);
  for (const s of SCREENS) {
    const el = $(`screen-${s}`);
    el.classList.toggle('hidden', s !== prev);
    el.style.zIndex = '';
  }
  if (prev === 'title') renderTitle();
  const heading = $(`screen-${prev}`)?.querySelector('h1, h2');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  return current;
}

function setPlayfieldInert(inert) {
  const pf = $('playfield');
  if (!pf) return;
  pf.inert = inert;
  pf.setAttribute('aria-hidden', inert ? 'true' : 'false');
}

export function showPlayfield() {
  for (const s of SCREENS) $(`screen-${s}`).classList.add('hidden');
  $('playfield').classList.remove('hidden');
  setPlayfieldInert(false);
  navStack = [];
}

export function anyScreenVisible() {
  return SCREENS.some((s) => !$(`screen-${s}`).classList.contains('hidden'));
}

// ---------------------------------------------------------------------------
// Title / lists
// ---------------------------------------------------------------------------
function renderTitle() {
  const save = ctl.getSave();
  const total = JOURNEY_STAGES.length;
  const unlocked = save.journey.unlocked;
  $('title-journey-status').textContent = `Stage ${Math.min(unlocked, total)}/${total}`;
  const today = ctl.utcToday();
  $('title-daily-status').textContent = save.daily.history[today] ? `Done — ${save.daily.history[today].grade}` : 'Not played';
  $('compat-note').classList.toggle('hidden', !ctl.usingFallbackRenderer());
}

function renderJourney() {
  const save = ctl.getSave();
  const grid = $('journey-grid');
  grid.innerHTML = '';
  JOURNEY_STAGES.forEach((s, i) => {
    const btn = document.createElement('button');
    const locked = i >= save.journey.unlocked;
    btn.className = 'stage-btn' + (s.mastery ? ' mastery' : '') + (locked ? ' locked' : '');
    btn.disabled = locked;
    const stars = save.journey.stars[i] || 0;
    btn.innerHTML = `<strong>${i + 1}</strong><small>${s.name}</small><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', locked ? `Stage ${i + 1}, locked` : `Stage ${i + 1}: ${s.name}, ${stars} of 3 stars${s.mastery ? ', mastery stage' : ''}`);
    if (!locked) btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.startJourneyStage(i); });
    grid.appendChild(btn);
  });
}

function renderPractice() {
  const list = $('practice-list');
  list.innerHTML = '';
  PRACTICE_DIFFICULTIES.forEach((d) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = `${d.label} — ${d.params.bpm} BPM`;
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.startPractice(d.key, $('practice-theme').value); });
    list.appendChild(btn);
  });
  const themeSel = $('practice-theme');
  if (!themeSel.options.length) {
    for (const [key, t] of Object.entries(THEMES)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = t.name;
      themeSel.appendChild(o);
    }
  }
}

function renderChallenges() {
  const list = $('challenge-list');
  list.innerHTML = '';
  for (const c of CHALLENGES) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.innerHTML = `<strong>${c.name}</strong><br><small class="muted">${c.description}</small>`;
    btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.startChallenge(c.key); });
    list.appendChild(btn);
  }
}

function renderLessons() {
  const save = ctl.getSave();
  const list = $('lesson-list');
  list.innerHTML = '';
  for (const l of LESSONS) {
    const done = !!save.lessons[l.id];
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.innerHTML = `<strong>${l.title}</strong> ${done ? '✓' : ''}`;
    btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.startLesson(l.id); });
    list.appendChild(btn);
  }
}

function renderChase() {
  const sel = $('chase-difficulty');
  if (!sel.options.length) {
    for (const d of PRACTICE_DIFFICULTIES) {
      const o = document.createElement('option');
      o.value = d.key; o.textContent = d.label;
      sel.appendChild(o);
    }
    sel.value = 'brisk';
  }
  $('chase-hosted-note').classList.toggle('hidden', false);
  renderChaseBoard();
  renderGlobalBoard();
}

// Platform boards are read-only: entries come from the game info's
// leaderboardId, with userIds resolved to nicknames. Hidden entirely when
// there is no hosted board.
async function renderGlobalBoard() {
  const head = $('chase-global-h');
  const list = $('chase-global-board');
  head.classList.add('hidden');
  list.classList.add('hidden');
  list.innerHTML = '';
  if (!isHosted()) return;
  const info = await fetchGameInfo();
  const boardId = info.ok && info.data && info.data.leaderboardId;
  if (!boardId) return;
  const r = await fetchLeaderboard(boardId, { page: 1, pageSize: 10 });
  if (!r.ok || !r.entries.length) return;
  head.classList.remove('hidden');
  list.classList.remove('hidden');
  r.entries.forEach((e, i) => {
    const li = document.createElement('li');
    li.textContent = `${e.rank != null ? e.rank : i + 1}. ${e.name} — ${e.score.toLocaleString()}`;
    list.appendChild(li);
  });
}

export function renderChaseBoard(chartId = null) {
  const save = ctl.getSave();
  const board = $('chase-board');
  board.innerHTML = '';
  // Boards are keyed by the normalized seed that startChase actually used, so
  // look up the same normalization rather than the raw field text.
  const typed = parseInt($('chase-seed').value, 10);
  const id = chartId || (Number.isFinite(typed) ? String(typed >>> 0) : $('chase-seed').value);
  const entries = (save.chaseBoards[id] || []).slice().sort((a, b) => compareResults(chaseEntry(a), chaseEntry(b))).slice(0, 10);
  if (!entries.length) {
    board.innerHTML = '<li class="muted">No local scores for this seed yet.</li>';
    return;
  }
  for (const e of entries) {
    const li = document.createElement('li');
    const score = e.total ?? e.score ?? 0;
    li.textContent = `${e.name || 'Guest'} — ${score.toLocaleString()} (${e.grade || '—'})`;
    board.appendChild(li);
  }
}

function renderProfile() {
  const save = ctl.getSave();
  const linked = !!save.profile.accountLinked;
  $('profile-name').value = save.profile.displayName;
  $('profile-name').disabled = linked;
  $('profile-name-note').textContent = linked
    ? 'Name comes from your StarHermit account.'
    : 'Local guest name, shown only on this device.';
  $('profile-sync').textContent = isHosted() ? 'Connecting…' : 'Local save only';
  $('profile-avatar').style.background = `hsl(${save.profile.avatarHue}, 70%, 55%)`;
  $('profile-mastery').textContent = `Level ${save.mastery.level} (${save.mastery.xp} XP)`;
  $('profile-sessions').textContent = String(save.stats.sessionsPlayed);
  $('profile-combo').textContent = String(save.stats.bestCombo);
  $('profile-days').textContent = String(Object.keys(save.stats.daysPlayed || {}).length);
  const ul = $('profile-achievements');
  ul.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const li = document.createElement('li');
    const unlocked = !!save.achievements[a.key];
    li.className = unlocked ? '' : 'locked';
    li.innerHTML = `<span><strong>${a.name}</strong> — ${a.description}</span><span>${unlocked ? '✓' : ''}</span>`;
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------
export function showSetup({ title, description, rules, durationMs, ranked, assists }) {
  $('setup-h').textContent = title;
  $('setup-desc').textContent = description;
  const ul = $('setup-rules');
  ul.innerHTML = '';
  for (const r of rules) {
    const li = document.createElement('li');
    li.textContent = r;
    ul.appendChild(li);
  }
  $('setup-duration').textContent = `~${Math.round(durationMs / 1000)}s`;
  $('setup-ranked').textContent = ranked ? 'Yes' : 'No';
  $('setup-assists').textContent = assists;
  showScreen('setup');
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
export function setObjective(text) { $('hud-objective').textContent = text; }

export function updateHud(snap) {
  $('hud-score').textContent = snap.score.total.toLocaleString();
  $('hud-combo').textContent = snap.combo >= 2 ? `${snap.combo}×` : '';
  const total = snap.counts.perfect + snap.counts.great + snap.counts.good + snap.counts.miss;
  if (total > 0) {
    const acc = (snap.counts.perfect + snap.counts.great * 0.7 + snap.counts.good * 0.4) / total;
    $('hud-acc').textContent = `${(acc * 100).toFixed(1)}%`;
  } else {
    $('hud-acc').textContent = ''; // nothing judged yet — never show the last run's accuracy
  }
  $('hud-progress-fill').style.width = `${Math.min(100, (snap.tick / snap.durationMs) * 100)}%`;
  const healthEl = $('hud-health');
  if (snap.failEnabled) {
    healthEl.classList.remove('hidden');
    healthEl.textContent = `♥ ${Math.round(snap.health)}`;
  } else healthEl.classList.add('hidden');
}

let judgeTimer = null;
export function judgment(grade, extra = '') {
  const el = $('judgment-pop');
  el.textContent = grade === 'miss' ? 'Miss' : grade[0].toUpperCase() + grade.slice(1) + (extra ? ` ${extra}` : '');
  el.className = `show ${grade}`;
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(() => el.classList.remove('show'), 450);
}

export function countdown(text) {
  const el = $('countdown-overlay');
  if (text == null) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = text;
}

export function caption(text) {
  const el = $('caption-line');
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 1800);
}

export function lessonStep(text, progress) {
  $('lesson-overlay').classList.remove('hidden');
  $('lesson-text').textContent = text;
  $('lesson-progress').textContent = progress || '';
  announce(text);
}

export function hideLesson() { $('lesson-overlay').classList.add('hidden'); }

export function showPause(show) {
  $('overlay-pause').classList.toggle('hidden', !show);
  // The pause dialog is modal: keep focus out of the playfield behind it.
  setPlayfieldInert(show);
  if (show) { lastFocused = document.activeElement; $('btn-resume').focus(); }
  else if (lastFocused?.focus) lastFocused.focus();
}
function hidePause() { $('overlay-pause').classList.add('hidden'); }

export function laneButtonState(lane, active) {
  const btn = document.querySelector(`.lane-btn[data-lane="${lane}"]`);
  if (btn) btn.classList.toggle('active', active);
}

export function setLaneKeyLabels(keys) {
  document.querySelectorAll('.lane-btn').forEach((btn) => {
    const lane = parseInt(btn.dataset.lane, 10);
    btn.querySelector('.lane-key').textContent = (keys[lane] || '?').toUpperCase();
    btn.setAttribute('aria-label', `Lane ${lane + 1} (${(keys[lane] || '?').toUpperCase()})`);
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
export function showResults(breakdown, { headline, canNext, achievements = [], xpText = '', detail = '' }) {
  showPlayfieldHiddenThen('results');
  $('results-grade').textContent = breakdown.grade;
  $('results-headline').textContent = headline;
  $('res-base').textContent = breakdown.base.toLocaleString();
  $('res-combo-bonus').textContent = breakdown.comboBonus.toLocaleString();
  $('res-hold').textContent = breakdown.holdBonus.toLocaleString();
  $('res-total').textContent = breakdown.total.toLocaleString();
  const c = breakdown.counts;
  $('res-counts').innerHTML =
    `<span>Perfect ${c.perfect}</span><span>Great ${c.great}</span><span>Good ${c.good}</span>` +
    `<span>Miss ${c.miss}</span><span>Max combo ${breakdown.maxCombo}</span>` +
    `<span>Accuracy ${(breakdown.accuracy * 100).toFixed(1)}%</span>`;
  $('res-detail').textContent = detail;
  const achRow = $('res-achievements');
  achRow.innerHTML = '';
  for (const a of achievements) {
    const chip = document.createElement('span');
    chip.className = 'ach-chip';
    chip.textContent = `🏆 ${a.name}`;
    achRow.appendChild(chip);
  }
  $('res-xp').textContent = xpText;
  $('btn-next').classList.toggle('hidden', !canNext);
  announce(`Results. Grade ${breakdown.grade}. Total ${breakdown.total} points. ${headline}`);
}

function showPlayfieldHiddenThen(name) {
  hidePause();
  hideLesson();
  countdown(null);
  showScreen(name);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function buildSettingsPanel() {
  const save = ctl.getSave();
  const s = save.settings;
  const bind = (id, key, isCheck = false) => {
    const el = $(id);
    if (isCheck) el.checked = !!s[key];
    else el.value = s[key];
    el.addEventListener(isCheck ? 'change' : 'input', () => {
      ctl.applySetting(key, isCheck ? el.checked : (id === 'set-note-speed' ? parseFloat(el.value) : el.value));
    });
  };
  bind('set-vol-music', 'volMusic'); bind('set-vol-effects', 'volEffects');
  bind('set-vol-ambience', 'volAmbience'); bind('set-vol-voice', 'volVoice');
  bind('set-muted', 'muted', true);
  bind('set-quality', 'qualityTier');
  bind('set-reduced-motion', 'reducedMotion', true);
  bind('set-camera-sway', 'cameraSway', true);
  bind('set-note-speed', 'noteSpeed');
  bind('set-high-contrast', 'highContrast', true);
  bind('set-cvd', 'cvdPalette', true);
  bind('set-large-text', 'largeText', true);
  bind('set-left-handed', 'leftHanded', true);
  bind('set-captions', 'captions', true);
  bind('set-haptics', 'haptics', true);
  bind('set-hold-mode', 'holdMode');
  bind('set-timing-assist', 'timingAssist');
  bind('set-telemetry', 'telemetryConsent', true);

  // Key bindings.
  const kb = $('key-bindings');
  kb.innerHTML = '';
  s.keys.forEach((key, lane) => {
    const btn = document.createElement('button');
    btn.className = 'btn keybind-btn';
    btn.innerHTML = `<span>Lane ${lane + 1}</span><kbd>${key.toUpperCase()}</kbd>`;
    btn.addEventListener('click', () => {
      btn.innerHTML = `<span>Lane ${lane + 1}</span><kbd>press a key…</kbd>`;
      const handler = (e) => {
        e.preventDefault();
        document.removeEventListener('keydown', handler, true);
        ctl.rebindKey(lane, e.key.toLowerCase());
        buildSettingsPanel();
      };
      document.addEventListener('keydown', handler, true);
    });
    kb.appendChild(btn);
  });
}

export function refreshSettingsPanel() { buildSettingsPanel(); }

// ---------------------------------------------------------------------------
// Help: rule cards generated from current control mappings.
// ---------------------------------------------------------------------------
function buildHelpCards() {
  const s = ctl.getSave().settings;
  const keys = s.keys.map((k) => k.toUpperCase());
  const cards = [
    { title: 'Tap notes', body: `Notes descend toward the glowing line. Press the lane when the note touches it. Keys: ${keys.map((k, i) => `<kbd>${k}</kbd>`).join(' ')} or tap the lane buttons.`, demo: ['tap'] },
    { title: 'Hold notes', body: `Long glowing bars must be held from head to tail, then released. Releasing early breaks your combo. Hold style: ${s.holdMode}.`, demo: ['hold'] },
    { title: 'Timing grades', body: 'Perfect ±45ms, Great ±90ms, Good ±135ms. Later than that is a miss and resets your combo.', demo: [] },
    { title: 'Combo & score', body: 'Score = notes + combo bonus + hold bonus. Every 10 combo raises the per-note bonus. Results always show the full breakdown.', demo: [] },
    { title: 'Pause', body: `Press <kbd>${(s.pauseKey || 'Escape').toUpperCase()}</kbd> or the ⏸ button to pause. Backgrounding the tab pauses automatically.`, demo: [] },
    { title: 'Keyboard & gamepad', body: 'Menus: arrows + Enter to confirm, Escape to go back. Gamepad: D-pad or face buttons hit lanes, Start pauses.', demo: [] },
  ];
  const host = $('help-cards');
  host.innerHTML = '';
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'help-card';
    div.innerHTML = `<h3>${c.title}</h3><p>${c.body}</p>` +
      (c.demo.length ? `<div class="demo-row">${c.demo.map((d) => `<span class="demo-note ${d}"></span>`).join('')}</div>` : '');
    host.appendChild(div);
  }
}

export function refreshHelpCards() { buildHelpCards(); }

// ---------------------------------------------------------------------------
// Toasts + announcements
// ---------------------------------------------------------------------------
const SYNC_TEXT = {
  connecting: 'Connecting…',
  saving: 'Saving…',
  synced: 'Synced',
  offline: 'Offline — local save',
  error: 'Sync error — will retry',
};

// Cloud mirror status, surfaced on the profile screen.
export function setSyncStatus(status) {
  const el = $('profile-sync');
  if (el) el.textContent = SYNC_TEXT[status] || String(status);
}

export function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toast-host').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function announce(msg) { $('sr-announcer').textContent = msg; }

// UI: semantic HTML shell over the canvas. Menus, forms, settings, help, and
// assistive descriptions are real DOM. UI state is fully separate from
// simulation state — closing a drawer can never affect a match.

import { JOURNEY_STAGES, CHALLENGES, PRACTICE_DIFFICULTIES, THEMES, LESSONS, dailyInfo } from './content.js';
import { ACHIEVEMENTS } from './persistence.js';
import { isHosted, fetchGameInfo, fetchLeaderboard, keyLabel } from './platform.js';
import { shText } from './sh-i18n.js';
import { T, N } from './lang.js';

export { shText };
// Text arguments may be functions so they re-render in a new language.
const txt = (v) => (typeof v === 'function' ? v() : v);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
  $('btn-signin').textContent = shText('signIn');
  $('btn-invite').textContent = shText('invite');
  $('btn-signin').addEventListener('click', () => { ctl.uiSound('confirm'); ctl.signIn(); });
  $('btn-invite').addEventListener('click', () => { ctl.uiSound('confirm'); ctl.invite(); });
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
    if (!Number.isFinite(seed)) { toast(T('Enter a numeric seed')); ctl.uiSound('error'); return; }
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
    if (confirm(T('Reset ALL local progress, settings, and achievements?'))) ctl.resetSave();
  });
  $('profile-name').addEventListener('change', () => {
    ctl.updateProfile({ displayName: $('profile-name').value.slice(0, 24) || T('Guest') });
  });

  bindSettingsInputs();
  buildSettingsPanel();
  buildHelpCards();
}

/** Language changed: re-render everything written from code, in place. */
export function relabel() {
  if (!ctl) return;
  $('btn-signin').textContent = shText('signIn');
  $('btn-invite').textContent = shText('invite');
  renderTitle();
  for (const [name, fn] of [['journey', renderJourney], ['practice', renderPractice], ['challenge', renderChallenges],
    ['learn', renderLessons], ['chase', renderChase], ['profile', renderProfile]]) {
    if (!$(`screen-${name}`).classList.contains('hidden')) fn();
  }
  const themeSel = $('practice-theme');
  for (const o of themeSel.options) o.textContent = T(THEMES[o.value].name);
  const diffSel = $('chase-difficulty');
  for (const o of diffSel.options) o.textContent = T(PRACTICE_DIFFICULTIES.find((d) => d.key === o.value).label);
  if (lastSetup) renderSetup(lastSetup);
  if (lastObjective != null) setObjective(lastObjective);
  if (lastLesson) lessonStep(...lastLesson, true);
  if (lastResults) renderResults(...lastResults);
  renderLeaderboardLine();
  if (lastSync) setSyncStatus(lastSync);
  setLaneKeyLabels(ctl.getSave().settings.keys);
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
  $('title-journey-status').textContent = T('Stage {n}/{total}', { n: Math.min(unlocked, total), total });
  const today = ctl.utcToday();
  $('title-daily-status').textContent = save.daily.history[today] ? T('Done — {grade}', { grade: save.daily.history[today].grade }) : T('Not played');
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
    btn.innerHTML = `<strong>${i + 1}</strong><small>${esc(T(s.name))}</small><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-label', locked ? T('Stage {n}, locked', { n: i + 1 })
      : T(s.mastery ? 'Stage {n}: {name}, {stars} of 3 stars, mastery stage' : 'Stage {n}: {name}, {stars} of 3 stars', { n: i + 1, name: T(s.name), stars }));
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
    btn.textContent = T('{level} — {bpm} BPM', { level: T(d.label), bpm: d.params.bpm });
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.startPractice(d.key, $('practice-theme').value); });
    list.appendChild(btn);
  });
  const themeSel = $('practice-theme');
  if (!themeSel.options.length) {
    for (const [key, t] of Object.entries(THEMES)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = T(t.name);
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
    btn.innerHTML = `<strong>${esc(T(c.name))}</strong><br><small class="muted">${esc(T(c.description))}</small>`;
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
    btn.innerHTML = `<strong>${esc(T(l.title))}</strong> ${done ? '✓' : ''}`;
    btn.addEventListener('click', () => { ctl.uiSound('confirm'); ctl.startLesson(l.id); });
    list.appendChild(btn);
  }
}

function renderChase() {
  const sel = $('chase-difficulty');
  if (!sel.options.length) {
    for (const d of PRACTICE_DIFFICULTIES) {
      const o = document.createElement('option');
      o.value = d.key; o.textContent = T(d.label);
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
    board.innerHTML = `<li class="muted">${esc(T('No local scores for this seed yet.'))}</li>`;
    return;
  }
  for (const e of entries) {
    const li = document.createElement('li');
    const score = e.total ?? e.score ?? 0;
    li.textContent = `${e.name || T('Guest')} — ${score.toLocaleString()} (${e.grade || '—'})`;
    board.appendChild(li);
  }
}

function renderProfile() {
  const save = ctl.getSave();
  const linked = !!save.profile.accountLinked;
  $('profile-name').value = save.profile.guest && save.profile.displayName === 'Guest' ? T('Guest') : save.profile.displayName;
  $('profile-name').disabled = linked;
  $('profile-name-note').textContent = linked
    ? T('Name comes from your StarHermit account.')
    : T('Local guest name, shown only on this device.');
  $('profile-sync').textContent = isHosted() ? T(SYNC_TEXT[lastSync] || SYNC_TEXT.connecting) : T('Local save only');
  const av = $('profile-avatar');
  av.style.background = `hsl(${save.profile.avatarHue}, 70%, 55%)`;
  if (isHosted() && ctl.avatarUrl) {
    ctl.avatarUrl().then((url) => { if (url) av.style.background = `center / cover no-repeat url("${url}")`; });
  }
  $('profile-mastery').textContent = T('Level {level} ({xp} XP)', { level: save.mastery.level, xp: save.mastery.xp });
  $('profile-sessions').textContent = String(save.stats.sessionsPlayed);
  $('profile-combo').textContent = String(save.stats.bestCombo);
  $('profile-days').textContent = String(Object.keys(save.stats.daysPlayed || {}).length);
  const ul = $('profile-achievements');
  ul.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const li = document.createElement('li');
    const unlocked = !!save.achievements[a.key];
    li.className = unlocked ? '' : 'locked';
    li.innerHTML = `<span><strong>${esc(T(a.name))}</strong> — ${esc(T(a.description))}</span><span>${unlocked ? '✓' : ''}</span>`;
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------------
let lastSetup = null;
export function showSetup(setup) {
  renderSetup(setup);
  showScreen('setup');
}
function renderSetup(setup) {
  lastSetup = setup;
  const { durationMs, ranked } = setup;
  $('setup-h').textContent = txt(setup.title);
  $('setup-desc').textContent = txt(setup.description);
  const ul = $('setup-rules');
  ul.innerHTML = '';
  for (const r of txt(setup.rules)) {
    const li = document.createElement('li');
    li.textContent = txt(r);
    ul.appendChild(li);
  }
  $('setup-duration').textContent = `~${Math.round(durationMs / 1000)} s`;
  $('setup-ranked').textContent = ranked ? T('Yes') : T('No');
  $('setup-assists').textContent = txt(setup.assists);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
let lastObjective = null;
export function setObjective(text) { lastObjective = text; $('hud-objective').textContent = txt(text); }

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
  el.textContent = T(GRADE_NAMES[grade] || grade) + (extra ? ` ${T(extra)}` : '');
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

let lastLesson = null;
export function lessonStep(text, progress, quiet = false) {
  lastLesson = [text, progress];
  $('lesson-overlay').classList.remove('hidden');
  $('lesson-text').textContent = txt(text);
  $('lesson-progress').textContent = progress || '';
  if (!quiet) announce(txt(text));
}

export function hideLesson() { lastLesson = null; $('lesson-overlay').classList.add('hidden'); }

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
    btn.querySelector('.lane-key').textContent = keyLabel(keys[lane]);
    btn.setAttribute('aria-label', T('Lane {n} ({key})', { n: lane + 1, key: keyLabel(keys[lane]) }));
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
let lastResults = null;
export function showResults(breakdown, opts) {
  showPlayfieldHiddenThen('results');
  lbState = null;
  $('res-lb').hidden = true;
  renderResults(breakdown, opts);
  announce(T('Results. Grade {grade}. Total {n} points. {headline}', { grade: breakdown.grade, n: breakdown.total, headline: txt(opts.headline) }));
}
function renderResults(breakdown, { headline, canNext, achievements = [], xpText = '', detail = '' }) {
  lastResults = [breakdown, { headline, canNext, achievements, xpText, detail }];
  $('results-grade').textContent = breakdown.grade;
  $('results-headline').textContent = txt(headline);
  $('res-base').textContent = breakdown.base.toLocaleString();
  $('res-combo-bonus').textContent = breakdown.comboBonus.toLocaleString();
  $('res-hold').textContent = breakdown.holdBonus.toLocaleString();
  $('res-total').textContent = breakdown.total.toLocaleString();
  const c = breakdown.counts;
  $('res-counts').innerHTML = [
    T('Perfect {n}', { n: c.perfect }), T('Great {n}', { n: c.great }), T('Good {n}', { n: c.good }),
    T('Miss {n}', { n: c.miss }), T('Max combo {n}', { n: breakdown.maxCombo }),
    T('Accuracy {n}%', { n: (breakdown.accuracy * 100).toFixed(1) }),
  ].map((x) => `<span>${esc(x)}</span>`).join('');
  $('res-detail').textContent = txt(detail);
  const achRow = $('res-achievements');
  achRow.innerHTML = '';
  for (const a of achievements) {
    const chip = document.createElement('span');
    chip.className = 'ach-chip';
    chip.textContent = `🏆 ${T(a.name)}`;
    achRow.appendChild(chip);
  }
  $('res-xp').textContent = txt(xpText);
  $('btn-next').classList.toggle('hidden', !canNext);
}

/** Hosted: the results line for the StarHermit high-score board. */
let lbState = null;
export function showLeaderboardPosting(promise) {
  const mine = lbState = { pending: true };
  $('res-lb').hidden = false;
  renderLeaderboardLine();
  promise.then((r) => {
    if (lbState !== mine) return;
    lbState = r;
    renderLeaderboardLine();
  });
}
function renderLeaderboardLine() {
  const line = $('res-lb');
  const r = lbState;
  if (!r || line.hidden) return;
  line.textContent = r.pending ? shText('lbPosting') : !r.posted ? shText('lbNotPosted')
    : r.rank ? shText('lbRank', { rank: r.rank }) : shText('lbPosted');
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
// Settings inputs: listeners are attached once; buildSettingsPanel() only
// syncs their values and rebuilds the key-binding list.
const SETTING_INPUTS = [
  ['set-vol-music', 'volMusic'], ['set-vol-effects', 'volEffects'], ['set-vol-ambience', 'volAmbience'], ['set-vol-voice', 'volVoice'],
  ['set-muted', 'muted', true], ['set-reduced-motion', 'reducedMotion', true], ['set-camera-sway', 'cameraSway', true],
  ['set-note-speed', 'noteSpeed'], ['set-high-contrast', 'highContrast', true], ['set-cvd', 'cvdPalette', true],
  ['set-large-text', 'largeText', true], ['set-left-handed', 'leftHanded', true], ['set-captions', 'captions', true],
  ['set-haptics', 'haptics', true], ['set-hold-mode', 'holdMode'], ['set-timing-assist', 'timingAssist'],
  ['set-telemetry', 'telemetryConsent', true],
];
function bindSettingsInputs() {
  for (const [id, key, isCheck] of SETTING_INPUTS) {
    const el = $(id);
    el.addEventListener(isCheck ? 'change' : 'input', () => {
      ctl.applySetting(key, isCheck ? el.checked : (id === 'set-note-speed' ? parseFloat(el.value) : el.value));
    });
  }
}

function buildSettingsPanel() {
  const save = ctl.getSave();
  const s = save.settings;
  const bind = (id, key, isCheck = false) => {
    const el = $(id);
    if (isCheck) el.checked = !!s[key];
    else el.value = s[key];
  };
  bind('set-vol-music', 'volMusic'); bind('set-vol-effects', 'volEffects');
  bind('set-vol-ambience', 'volAmbience'); bind('set-vol-voice', 'volVoice');
  bind('set-muted', 'muted', true);
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
    btn.innerHTML = `<span>${esc(T('Lane {n}', { n: lane + 1 }))}</span><kbd></kbd>`;
    btn.querySelector('kbd').textContent = keyLabel(key);
    btn.addEventListener('click', () => {
      btn.querySelector('kbd').textContent = shText('pressKey');
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.removeEventListener('keydown', handler, true);
        // Escape cancels; lanes bind by KeyboardEvent.code.
        if (e.code !== 'Escape' && e.code) ctl.rebindKey(lane, e.code);
        buildSettingsPanel();
      };
      document.addEventListener('keydown', handler, true);
    });
    kb.appendChild(btn);
  });
  const reset = document.createElement('button');
  reset.className = 'btn btn-ghost';
  reset.id = 'btn-reset-keys';
  reset.textContent = shText('resetKeys');
  reset.addEventListener('click', () => { ctl.resetKeys(); buildSettingsPanel(); });
  kb.appendChild(reset);
}

export function refreshSettingsPanel() { buildSettingsPanel(); }

// ---------------------------------------------------------------------------
// Help: rule cards generated from current control mappings.
// ---------------------------------------------------------------------------
function buildHelpCards() {
  const s = ctl.getSave().settings;
  const keys = s.keys.map((k) => keyLabel(k));
  const kbd = (k) => `<kbd>${esc(k)}</kbd>`;
  const cards = [
    { title: T('Tap notes'), body: esc(T('Notes descend toward the glowing line. Press the lane when the note touches it. Keys: {keys} or tap the lane buttons.', { keys: '\u0000' })).replace('\u0000', keys.map(kbd).join(' ')), demo: ['tap'] },
    { title: T('Hold notes'), body: esc(T('Long glowing bars must be held from head to tail, then released. Releasing early breaks your combo. Hold style: {style}.', { style: T(s.holdMode === 'toggle' ? 'Toggle' : 'Hold') })), demo: ['hold'] },
    { title: T('Timing grades'), body: esc(T('Perfect ±45ms, Great ±90ms, Good ±135ms. Later than that is a miss and resets your combo.')), demo: [] },
    { title: T('Combo & score'), body: esc(T('Score = notes + combo bonus + hold bonus. Every 10 combo raises the per-note bonus. Results always show the full breakdown.')), demo: [] },
    { title: T('Pause'), body: esc(T('Press {key} or the ⏸ button to pause. Backgrounding the tab pauses automatically.', { key: '\u0000' })).replace('\u0000', kbd(keyLabel((ctl.pauseKeys && ctl.pauseKeys()[0]) || 'Escape'))), demo: [] },
    { title: T('Keyboard & gamepad'), body: esc(T('Menus: arrows + Enter to confirm, Escape to go back. Gamepad: D-pad or face buttons hit lanes, Start pauses.')), demo: [] },
  ];
  const host = $('help-cards');
  host.innerHTML = '';
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'help-card';
    div.innerHTML = `<h3>${esc(c.title)}</h3><p>${c.body}</p>` +
      (c.demo.length ? `<div class="demo-row">${c.demo.map((d) => `<span class="demo-note ${d}"></span>`).join('')}</div>` : '');
    host.appendChild(div);
  }
}

export function refreshHelpCards() { buildHelpCards(); }

// ---------------------------------------------------------------------------
// Toasts + announcements
// ---------------------------------------------------------------------------
const SYNC_TEXT = {
  connecting: N('Connecting…'),
  saving: N('Saving…'),
  synced: N('Synced'),
  offline: N('Offline — local save'),
  error: N('Sync error — will retry'),
};
const GRADE_NAMES = { perfect: N('Perfect'), great: N('Great'), good: N('Good'), miss: N('Miss') };

// Cloud mirror status, surfaced on the profile screen.
// StarHermit account chrome on the title: sign-in when possible, invite when signed in.
export function setAccount() {
  const signedIn = ctl.isSignedIn();
  $('btn-signin').classList.toggle('hidden', signedIn || !ctl.canSignIn());
  $('btn-invite').classList.toggle('hidden', !signedIn);
}

let lastSync = null; // the profile screen re-renders with the latest status, not "Connecting…"
export function setSyncStatus(status) {
  lastSync = status;
  const el = $('profile-sync');
  if (el) el.textContent = SYNC_TEXT[status] ? T(SYNC_TEXT[status]) : String(status);
}

export function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = txt(msg);
  $('toast-host').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function announce(msg) { $('sr-announcer').textContent = msg; }

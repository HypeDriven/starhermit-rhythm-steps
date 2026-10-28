// The browser build's DOM shell (index.html + js/ui.js) as starhermit:ui,
// built every frame over the causeway: the title (logo, tagline, Play, the
// six mode buttons with the Journey and Daily status, Settings / Help /
// Profile, Invite or Sign in) on its see-through panel; the setup card
// (rules, duration, players, ranked, assists, Start / Back); the Journey
// grid of 40 stages with stars, locks and accent-bordered mastery stages;
// Practice (difficulties and the theme); the Challenges; Learn's lessons;
// Score Chase (seed, difficulty, local seed board, the read-only platform
// board); the results (grade, headline, the score breakdown, counts,
// achievements, mastery XP, the leaderboard line, Retry / Next / Home);
// Settings (the game's options; the rest is the runtime's Options); How to
// play with the effective keys; the profile; the pause dialog with Settings
// and Help over it; and the playfield HUD (objective, progress bar, pause
// button, score / combo / accuracy / health, the judgment pop, captions, the
// countdown, the lesson card, the lane buttons, toasts). The old media
// queries are layouts picked by the window's logical size: wide (≥ 1024 px:
// the HUD's objective rail, a 640 px lane tray), phone portrait (≤ 700 px
// wide: taller lane buttons, tighter panels) and short landscape (≤ 500 px
// tall: a compact title, two-column setup and results, a 44 px lane strip).
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Persist, Rules, type ChaseEntry } from "./game.ts";
import { num, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  app, confirmSetup, copyInvite, goTitle, laneButtonActivated, leaderboardLine, leaveGame, navBack, nextStage, objective,
  openMode, openOverlay, options, pauseGame, playerName, progress, quickPlay, randomSeed, resetProgress, restartTrack, resumeGame,
  setGuestName, show, signIn, startChallenge, startChase, startJourneyStage, startLesson, startPractice, today, click,
  type Screen,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale || 1;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, phone: lw <= 700 && lh >= lw, short: lh <= 500 && lw > lh };
}
const lastSize = new Map<string, number>();
const fresh = (): boolean => frame().frame !== app.openedFrame;
const acts: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
function later(fn: () => void): void { acts.push(fn); }
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style }).width / (ui.preferences().scale || 1);
}
/** Text up to `width` wide: one label when it fits, else a wrapped paragraph. */
function para(text: string, width: number, cls = "body", id?: string, align: "start" | "center" = "start"): void {
  if (!text) return;
  let u = ui.style(cls, { text: { align } });
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(text: string, width: number, cls = "h2", align: "start" | "center" = "start"): void {
  if (textWidth(text, cls, "heading") <= width) ui.style(cls).heading(text);
  else ui.style(cls, { text: { align } }).paragraph(text, width);
}
interface Btn { id: string; text: string; cls?: string; act: () => void; disabled?: boolean; name?: string; sub?: string; selected?: boolean }
const btnWidth = (b: Btn): number => Math.max(textWidth(b.text, b.cls ?? "btn", "button"), b.sub ? textWidth(b.sub, "mode-small") + 30 : 0) + 4;
/** A button `width` wide (null: its text's); a long label wraps inside; `sub` a small second line. */
function button(b: Btn, width: number | null = null): void {
  const cls = b.cls ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const inner = width != null ? Math.max(20, width - 40) : 0;
  if (b.sub !== undefined) {
    opts.content = () => {
      ui.style("mode-title", { text: { align: "center" } }).label(b.text);
      if (b.sub) ui.style("mode-small", { text: { align: "center" } }).label(b.sub);
    };
  } else if (width != null && btnWidth(b) > width) {
    opts.content = () => { ui.style({ text: { align: "center", weight: cls === "btn" || cls === "btn-ghost" ? "normal" : "bold" } }).paragraph(b.text, inner); };
  }
  const style: ui.Style = width != null ? { width } : {};
  if (ui.style(cls, style).id(b.id).button(b.name ?? b.text, opts) && fresh() && !b.disabled) later(b.act);
}
/** Buttons at their own widths in rows that wrap at `width` (.row: flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" = "start"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, btnWidth(b));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gap, width, justify }));
  }, { spacing: gap, width });
}
/** Buttons in `cols` equal columns (CSS grid). */
function gridOf(label: string, list: Btn[], width: number, cols: number, gap = 10): void {
  const cw = (width - (cols - 1) * gap) / cols;
  ui.column(label, () => {
    for (let r = 0; r * cols < list.length; r++) {
      ui.row(`${label}-r${r}`, () => { for (const b of list.slice(r * cols, (r + 1) * cols)) button(b, cw); }, { spacing: gap });
    }
  }, { spacing: gap, width });
}
const gap = (h: number): void => { ui.widget("", { role: "none", size: { width: 1, height: h } }); };

/** The screen's wash over the whole window: a placed role-"none" widget. */
function backdrop(cls: string, L: Layout): void {
  const f = frame();
  ui.place("backdrop", { anchor: "top-start", x: -f.safeArea.left / L.sc, y: -f.safeArea.top / L.sc }, () => {
    ui.widget("", { role: "none", size: { width: f.width / L.sc, height: f.height / L.sc }, draw: () => draw.box(0, 0, f.width, f.height, cls) });
  });
}
/** A .screen: its panel at most `width` wide, centred, scrolling when taller than the window. */
function page(key: string, L: Layout, build: (w: number) => void, width = 480): void {
  const margin = L.short ? 8 : 16;
  const outer = Math.min(width, L.lw - 2 * margin);
  const pad = L.short ? 14 : L.phone ? 16 : 24;
  const avail = Math.max(80, L.lh - 2 * margin);
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - 2 * pad - (scroll ? 14 : 0) - 2;
  const opening = frame().frame - app.openedFrame <= 6;
  const y = margin + (scroll ? 0 : Math.max(0, (avail - h) / 2));
  ui.place(`page-${key}`, { anchor: "top", y }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => build(inner), { width: outer - (scroll ? 14 : 0), spacing: L.short ? 8 : 12, padding: pad, style: "panel" });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}

// ------------------------------------------------------------------ the frame
let lanes: (ui.Rect | null)[] = [null, null, null, null];
let pause: ui.Rect | null = null;
/** The lane buttons' rectangles (window pixels) as last drawn, for presses. */
export function laneRects(): (ui.Rect | null)[] { return lanes; }
export function pauseRect(): ui.Rect | null { return pause; }

export function drawScreens(): void {
  const L = layoutNow();
  lanes = [null, null, null, null];
  pause = null;
  if (app.screen === null) playfield(L);
  else {
    backdrop(app.screen === "title" ? "title-wash" : "screen", L);
    screenFor(app.screen, L);
  }
  if (app.phase === "paused" && app.screen === null) {
    if (app.overlay) {
      backdrop("screen", L);
      screenFor(app.overlay, L);
    } else pauseDialog(L);
  }
  toasts(L);
  for (const fn of acts.splice(0)) fn();
  const f = frame();
  if (app.focusNext) {
    // until the widget takes it (a browser's first frames may come before the UI shows)
    const age = f.frame - app.openedFrame;
    if (age >= 1 && ui.focused() === null) ui.setFocus(app.focusNext);
    else if (age >= 3 && ui.focused() !== null) app.focusNext = null;
    if (age >= 120) app.focusNext = null;
  }
}
function screenFor(s: Screen | "settings" | "help", L: Layout): void {
  switch (s) {
    case "title": titleScreen(L); break;
    case "setup": page("setup", L, setupScreen(L), L.short ? 760 : 480); break;
    case "journey": page("journey", L, journeyScreen, 880); break;
    case "practice": page("practice", L, practiceScreen); break;
    case "challenge": page("challenge", L, challengeScreen); break;
    case "learn": page("learn", L, learnScreen); break;
    case "chase": page("chase", L, chaseScreen); break;
    case "results": page("results", L, resultsScreen(L), L.short ? 760 : 480); break;
    case "settings": page("settings", L, settingsScreen, 880); break;
    case "help": page("help", L, helpScreen, 880); break;
    case "profile": page("profile", L, profileScreen); break;
  }
}
const backBtn = (): Btn => ({ id: "btn-back", text: T("Back"), cls: "btn-ghost", act: navBack });
const homeBack = (): Btn => ({ id: "btn-back", text: T("Back"), cls: "btn-ghost", act: () => { click("back"); goTitle(); } });

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const p = progress();
  const total = Content.JOURNEY_STAGES.length;
  const todayRun = p.daily.history[today()];
  const logo = L.short ? 29 : Math.min(64, Math.max(38, L.lw * 0.08));
  page("title", L, (w) => {
    ui.column("title-core", () => {
      // .game-logo: "Rhythm" and the accent "Steps", on one line when they fit
      const a = "Rhythm", b = "Steps"; // the name, never translated
      const one = textWidth(`${a} ${b}`, "game-logo") * (logo / 64) <= w;
      const words = (): void => {
        ui.style("game-logo", { text: { size: logo } }).id("title-logo").heading(a);
        ui.style("game-logo-accent", { text: { size: logo } }).id("title-logo-2").label(b);
      };
      if (one) ui.row("logo", words, { spacing: logo * 0.28, align: "end" });
      else ui.column("logo", words, { spacing: 0, align: "center" });
      para(T("A concert causeway made of light. Tap on beat, hold the glow, keep the streak."), w, L.short ? "muted" : "tagline", "tagline", "center");
      gap(L.short ? 0 : 6);
      button({ id: "btn-play", text: T("Play"), cls: "btn-big", act: quickPlay });
      gap(L.short ? 0 : 6);
      const modes: Btn[] = [
        { id: "mode-journey", text: T("Journey"), sub: T("Stage {n}/{total}", { n: Math.min(p.journey.unlocked, total), total }), cls: "mode-btn", act: () => openMode("journey") },
        { id: "mode-daily", text: T("Daily"), sub: todayRun ? T("Done — {grade}", { grade: todayRun.grade }) : T("Not played"), cls: "mode-btn", act: () => openMode("daily") },
        { id: "mode-practice", text: T("Practice"), sub: "", cls: "mode-btn", act: () => openMode("practice") },
        { id: "mode-challenge", text: T("Challenge"), sub: "", cls: "mode-btn", act: () => openMode("challenge") },
        { id: "mode-chase", text: T("Score Chase"), sub: "", cls: "mode-btn", act: () => openMode("chase") },
        { id: "mode-learn", text: T("Learn"), sub: "", cls: "mode-btn", act: () => openMode("learn") },
      ];
      if (L.short) for (const m of modes) { if (m.sub) m.text = `${m.text} · ${m.sub}`; m.sub = ""; }
      gridOf("title-grid", modes, w, L.short ? 3 : 2, L.short ? 6 : 10);
      const foot: Btn[] = [
        { id: "btn-settings", text: T("Settings"), cls: "btn-ghost", act: () => { click("move"); show("settings"); } },
        { id: "btn-help", text: T("Help"), cls: "btn-ghost", act: () => { click("move"); show("help"); } },
        { id: "btn-profile", text: T("Profile"), cls: "btn-ghost", act: () => { click("move"); show("profile"); } },
      ];
      if (platform.inviteLink()) foot.push({ id: "btn-invite", text: S("invite"), cls: "btn-ghost", act: copyInvite });
      flow("title-footer", foot, w, 10, "center");
      if (!platform.signedIn()) button({ id: "btn-signin", text: S("signIn"), act: signIn });
      if (app.accountNote) para(app.accountNote(), w, "muted", "account-note", "center");
    }, { spacing: L.short ? 6 : 12, width: w, align: "center" });
  }, L.short ? 640 : 480);
}

// ------------------------------------------------------------------ setup
function metaGrid(label: string, items: [string, string][], w: number): void {
  const cols = Math.max(1, Math.min(items.length, Math.floor((w + 8) / (110 + 8))));
  const cw = (w - (cols - 1) * 8) / cols;
  ui.column(label, () => {
    for (let r = 0; r * cols < items.length; r++) {
      ui.row(`${label}-r${r}`, () => items.slice(r * cols, (r + 1) * cols).forEach(([dt, dd], j) => {
        ui.column(`${label}-${r * cols + j}`, () => {
          ui.style("meta-dt").label(dt);
          para(dd, cw - 20, "meta-dd", `${label}-${r * cols + j}-dd`);
        }, { style: "meta", width: cw, spacing: 2 });
      }), { spacing: 8, align: "stretch" });
    }
  }, { spacing: 8, width: w });
}
function bullets(label: string, lines: string[], w: number): void {
  ui.column(label, () => lines.forEach((l, i) => ui.row(`${label}-${i}`, () => {
    ui.style("rule").label("•");
    para(l, w - 20, "rule", `${label}-${i}-t`);
  }, { spacing: 8 })), { spacing: 4, width: w });
}
function setupScreen(L: Layout): (w: number) => void {
  return (w) => {
    const s = app.setup;
    if (!s) return;
    const left = (cw: number): void => {
      heading(s.title(), cw);
      para(s.description(), cw, "body", "setup-desc");
      bullets("setup-rules", s.rules(), cw);
    };
    const right = (cw: number): void => {
      metaGrid("setup-meta", [
        [T("Duration"), `~${Math.round(s.durationMs / 1000)} s`], [T("Players"), "1"], [T("Ranked"), s.ranked ? T("Yes") : T("No")], [T("Assists"), s.assists()],
      ], cw);
      flow("setup-row", [
        { id: "btn-setup-start", text: T("Start"), cls: "btn-primary", act: confirmSetup },
        { id: "btn-back", text: T("Back"), cls: "btn-ghost", act: navBack },
      ], cw);
    };
    columns("setup", L, w, left, right);
  };
}
/** Two columns in short landscape (.ls-col), else one after the other. */
function columns(key: string, L: Layout, w: number, left: (w: number) => void, right: (w: number) => void): void {
  if (L.short) {
    const cw = (w - 20) / 2;
    ui.row(`${key}-cols`, () => {
      ui.column(`${key}-l`, () => left(cw), { width: cw, spacing: 8 });
      ui.column(`${key}-r`, () => right(cw), { width: cw, spacing: 8 });
    }, { spacing: 20, align: "center" });
  } else { left(w); right(w); }
}

// ------------------------------------------------------------------ journey, practice, challenge, learn
function journeyScreen(w: number): void {
  heading(T("Journey"), w);
  para(T("Forty stages across five causeways. Mastery stages test everything learned so far."), w);
  const p = progress();
  const gapX = 8;
  const cols = Math.max(2, Math.floor((w + gapX) / (90 + gapX)));
  const cw = (w - (cols - 1) * gapX) / cols;
  const n = Content.JOURNEY_STAGES.length;
  ui.column("journey-grid", () => {
    for (let r = 0; r * cols < n; r++) {
      ui.row(`jg-${r}`, () => {
        for (let i = r * cols; i < Math.min(n, (r + 1) * cols); i++) {
          const s = Content.JOURNEY_STAGES[i]!;
          const locked = i >= p.journey.unlocked;
          const stars = p.journey.stars[i] ?? 0;
          const name = locked ? T("Stage {n}, locked", { n: i + 1 })
            : T(s.mastery ? "Stage {n}: {name}, {stars} of 3 stars, mastery stage" : "Stage {n}: {name}, {stars} of 3 stars", { n: i + 1, name: T(s.name), stars });
          const opts: ui.ButtonOptions = {
            content: () => {
              ui.style("stage-num").label(String(i + 1));
              ui.style("stage-name", { text: { align: "center" } }).paragraph(T(s.name), cw - 16);
              ui.style("stage-stars").label("★".repeat(stars) + "☆".repeat(3 - stars));
            },
          };
          if (locked) opts.disabled = true;
          const st: ui.Style = { width: cw, ...(locked ? { opacity: 0.35 } : {}) };
          if (ui.style(s.mastery ? "stage-mastery" : "stage-btn", st).id(`stage-${i + 1}`).button(name, opts) && fresh() && !locked) later(() => { click(); startJourneyStage(i); });
        }
      }, { spacing: gapX, align: "stretch" });
    }
  }, { spacing: gapX, width: w });
  flow("journey-back", [homeBack()], w);
}
function practiceScreen(w: number): void {
  heading(T("Practice"), w);
  para(T("Unranked. Pick a difficulty; restart as often as you like."), w);
  ui.column("practice-list", () => Content.PRACTICE_DIFFICULTIES.forEach((d, i) => button({
    id: `practice-${i}`, text: T("{level} — {bpm} BPM", { level: T(d.label), bpm: d.params.bpm }), cls: "choice", act: () => { click(); startPractice(d.key); },
  }, w)), { spacing: 8, width: w });
  ui.style("field-label").label(T("Theme"));
  const keys = Object.keys(Content.THEMES);
  const idx = ui.id("practice-theme").select(T("Theme"), app.practiceTheme, keys.map((k) => T(Content.THEMES[k]!.name)));
  if (idx !== app.practiceTheme) later(() => { app.practiceTheme = idx; });
  flow("practice-back", [homeBack()], w);
}
function choiceCard(id: string, title: string, text: string, w: number, act: () => void): void {
  const opts: ui.ButtonOptions = {
    content: () => {
      ui.style("choice-title").paragraph(title, w - 40);
      if (text) ui.style("choice-text").paragraph(text, w - 40);
    },
  };
  if (ui.style("choice", { width: w }).id(id).button(title, opts) && fresh()) later(act);
}
function challengeScreen(w: number): void {
  heading(T("Challenges"), w);
  para(T("Constrained goals for a sharpened run."), w);
  ui.column("challenge-list", () => Content.CHALLENGES.forEach((c, i) => choiceCard(`challenge-${i}`, T(c.name), T(c.description), w, () => { click(); startChallenge(c.key); })), { spacing: 8, width: w });
  flow("challenge-back", [homeBack()], w);
}
function learnScreen(w: number): void {
  heading(T("Learn"), w);
  para(T("Interactive lessons — one rule at a time. You must perform each action to advance."), w);
  const done = progress().lessons;
  ui.column("lesson-list", () => Content.LESSONS.forEach((l, i) => choiceCard(`lesson-${i}`, T(l.title) + (done[l.id] ? " ✓" : ""), "", w, () => startLesson(l.id))), { spacing: 8, width: w });
  flow("learn-back", [homeBack()], w);
}

// ------------------------------------------------------------------ score chase
function chaseScreen(w: number): void {
  heading(T("Score Chase"), w);
  para(T("Same seed, same chart — compare scores asynchronously. Share the seed with friends."), w);
  ui.style("field-label").label(T("Seed"));
  const seed = ui.textField("chase-seed", app.chaseSeed, { maxChars: 12, width: w, placeholder: T("e.g. 123456") });
  if (seed !== app.chaseSeed) later(() => { app.chaseSeed = seed.replace(/[^0-9]/g, ""); });
  if (ui.submitted("chase-seed")) later(startChase);
  ui.style("field-label").label(T("Difficulty"));
  const idx = ui.id("chase-difficulty").select(T("Difficulty"), app.chaseDifficulty, Content.PRACTICE_DIFFICULTIES.map((d) => T(d.label)));
  if (idx !== app.chaseDifficulty) later(() => { app.chaseDifficulty = idx; });
  flow("chase-row", [
    { id: "btn-chase-start", text: T("Play this seed"), cls: "btn-primary", act: startChase },
    { id: "btn-chase-random", text: T("Random seed"), act: randomSeed },
  ], w);
  heading(T("Local board"), w, "h3");
  const typed = parseInt(app.chaseSeed, 10);
  const key = Number.isFinite(typed) ? String(typed >>> 0) : app.chaseSeed;
  const entries = (progress().chaseBoards[key] ?? []).slice().sort((a: ChaseEntry, b: ChaseEntry) => Rules.compareResults(Rules.chaseEntry(a), Rules.chaseEntry(b))).slice(0, 10);
  if (!entries.length) para(T("No local scores for this seed yet."), w, "muted", "chase-empty");
  entries.forEach((e, i) => para(`${i + 1}. ${e.name || T("Guest")} — ${num(e.total ?? e.score ?? 0)} (${e.grade || "—"})`, w, "board-line", `chase-${i}`));
  const rows = app.board;
  if (Array.isArray(rows) && rows.length) {
    heading(`${T("Platform board")} ${T("(read-only)")}`, w, "h3");
    rows.forEach((e, i) => para(`${e.rank}. ${e.name} — ${num(e.score)}`, w, "board-line", `board-${i}`));
  }
  para(T("On-platform boards are read-only. Local and cloud-saved boards are casual."), w, "muted", "chase-note");
  flow("chase-back", [homeBack()], w);
}

// ------------------------------------------------------------------ results
function resultsScreen(L: Layout): (w: number) => void {
  return (w) => {
    const R = app.results;
    if (!R) return;
    const b = R.breakdown;
    const left = (cw: number): void => {
      heading(T("Results"), cw);
      ui.column("grade", () => ui.style("grade-badge", L.short ? { text: { size: 48 } } : {}).id("results-grade").label(b.grade), { width: cw, align: "center" });
      para(R.headline(), cw, "body", "results-headline");
      const rows: [string, number, boolean][] = [
        [T("Notes"), b.base, false], [T("Combo bonus"), b.comboBonus, false], [T("Hold bonus"), b.holdBonus, false], [T("Total"), b.total, true],
      ];
      ui.column("results-table", () => rows.forEach(([k, v, total], i) => ui.row(`res-${i}`, () => {
        ui.style(total ? "th-total" : "th").label(k);
        ui.spacer();
        ui.style(total ? "td-total" : "td").id(`res-${i}-v`).label(num(v));
      }, { style: total ? "tr-total" : "tr", width: cw, align: "center" })), { spacing: 0, width: cw });
    };
    const right = (cw: number): void => {
      const c = b.counts;
      chips("res-counts", [
        T("Perfect {n}", { n: c.perfect }), T("Great {n}", { n: c.great }), T("Good {n}", { n: c.good }), T("Miss {n}", { n: c.miss }),
        T("Max combo {n}", { n: b.maxCombo }), T("Accuracy {n}%", { n: (b.accuracy * 100).toFixed(1) }),
      ], cw, "chip", "chip-text");
      const detail = R.detail();
      if (detail) para(detail, cw, "muted", "res-detail");
      if (R.achievements.length) chips("res-ach", R.achievements.map((a) => `🏆 ${T(a)}`), cw, "ach-chip", "ach-text");
      para(R.xpText(), cw, "muted", "res-xp");
      const lb = leaderboardLine();
      if (lb) para(lb, cw, "muted", "res-lb");
      const list: Btn[] = [{ id: "btn-retry", text: T("Retry"), cls: "btn-primary", act: restartTrack }];
      if (R.canNext) list.push({ id: "btn-next", text: T("Next stage"), act: nextStage });
      list.push({ id: "btn-home", text: T("Home"), cls: "btn-ghost", act: () => { click("back"); goTitle(); } });
      flow("results-btns", list, cw);
    };
    columns("results", L, w, left, right);
  };
}
/** Pills that wrap (.counts-row / .ach-row). */
function chips(label: string, items: string[], w: number, cls: string, textCls: string): void {
  const rows: string[][] = [[]];
  let used = 0;
  const cw = (t: string): number => textWidth(t, textCls) + 24;
  for (const t of items) {
    if (rows[rows.length - 1]!.length && used + 10 + cw(t) > w) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? 10 : 0) + cw(t);
    rows[rows.length - 1]!.push(t);
  }
  ui.column(label, () => rows.forEach((r, i) => ui.row(`${label}-${i}`, () => r.forEach((t) => ui.column(`${label}-${t}`, () => ui.style(textCls).label(t), { style: cls })), { spacing: 10, justify: "center", width: w })), { spacing: 8, width: w });
}

// ------------------------------------------------------------------ settings
function settingsScreen(w: number): void {
  heading(T("Settings"), w);
  const o = options();
  const cols = w >= 560 ? 2 : 1;
  const fw = (w - (cols - 1) * 16) / cols;
  const check = (key: "cameraSway" | "cvdPalette" | "leftHanded" | "captions" | "haptics", text: string): void => {
    const cur = o[key];
    const next = ui.id(`set-${key}`).checkbox(T(text), cur);
    if (next !== cur && fresh()) later(() => { platform.setOption(key, next); click("move"); });
  };
  const sections: [string, (fw: number) => void][] = [
    [T("Gameplay"), (fw) => {
      ui.style("field-label").label(`${T("Note speed")} ${o.noteSpeed.toFixed(1)}×`);
      const ns = ui.id("set-noteSpeed").slider(T("Note speed"), o.noteSpeed, { min: 0.6, max: 1.6, step: 0.1, width: fw - 26 });
      const r = Math.round(ns * 10) / 10;
      if (Math.abs(r - o.noteSpeed) > 0.001) later(() => platform.setOption("noteSpeed", r));
      check("cameraSway", "Camera sway");
      ui.style("field-label").label(T("Hold style"));
      const hm = ui.id("set-holdMode").select(T("Hold style"), o.holdMode === "toggle" ? 1 : 0, [T("Hold"), T("Toggle")]);
      if ((hm === 1 ? "toggle" : "hold") !== o.holdMode) later(() => platform.setOption("holdMode", hm === 1 ? "toggle" : "hold"));
      ui.style("field-label").label(T("Timing assist"));
      const ta = ui.id("set-timingAssist").select(T("Timing assist"), o.timingAssist === "wide" ? 1 : 0, [T("Off"), T("Wide windows (unranked)")]);
      if ((ta === 1 ? "wide" : "off") !== o.timingAssist) later(() => platform.setOption("timingAssist", ta === 1 ? "wide" : "off"));
    }],
    [T("Accessibility"), () => {
      check("cvdPalette", "Color-vision-safe palette");
      check("leftHanded", "Left-handed lanes");
      check("captions", "Audio captions");
      check("haptics", "Haptics");
    }],
    [T("StarHermit Options"), (fw) => {
      para(T("Sound, graphics, controls, language, reduced motion, high contrast and larger text are in the StarHermit Options."), fw - 26, "muted", "options-note");
      button({ id: "btn-options", text: T("Open Options"), act: () => { click("move"); openMenu(); } });
    }],
    [T("Data"), (fw) => {
      button({ id: "btn-replay-tutorial", text: T("Replay tutorial"), act: () => { click(); app.overlay = null; if (app.phase === "paused") leaveGame(); show("learn"); } });
      if (!app.confirmReset) button({ id: "btn-reset-save", text: T("Reset all progress"), cls: "btn-danger", act: () => { click("error"); app.confirmReset = true; } });
      else {
        para(T("Reset ALL local progress, settings, and achievements?"), fw - 26, "body", "reset-q");
        flow("reset-row", [
          { id: "btn-reset-yes", text: T("Yes"), cls: "btn-danger", act: () => { app.confirmReset = false; resetProgress(); } },
          { id: "btn-reset-no", text: T("Cancel"), cls: "btn-ghost", act: () => { click("back"); app.confirmReset = false; } },
        ], fw - 26);
      }
    }],
  ];
  const fieldset = (title: string, build: (fw: number) => void, i: number): void => {
    ui.column(`fs-${i}`, () => { ui.style("legend").label(title); build(fw); }, { style: "fieldset", width: fw, spacing: 8 });
  };
  ui.column("settings-cols", () => {
    for (let r = 0; r * cols < sections.length; r++) {
      ui.row(`settings-r${r}`, () => sections.slice(r * cols, (r + 1) * cols).forEach(([t, b], j) => fieldset(t, b, r * cols + j)), { spacing: 16, align: "stretch" });
    }
  }, { spacing: 16, width: w });
  flow("settings-back", [app.overlay ? backBtn() : { ...backBtn(), act: navBack }], w);
}

// ------------------------------------------------------------------ help
const KEY_NAMES: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
function keyOf(action: string): string {
  let label = "";
  try { label = bindingLabel(action); } catch { /* not declared */ }
  return KEY_NAMES[label] ?? label ?? "?";
}
export function laneKeys(): string[] { return ["lane1", "lane2", "lane3", "lane4"].map(keyOf); }
function helpScreen(w: number): void {
  heading(T("How to play"), w);
  const keys = laneKeys().join(" ");
  let pauseKey = "Esc";
  try { pauseKey = bindings("pause").filter((b) => b.device === "keyboard").map((b) => KEY_NAMES[b.label] ?? b.label)[0] ?? pauseKey; } catch { /* default */ }
  const cards: [string, string, ("tap" | "hold")[]][] = [
    [T("Tap notes"), T("Notes descend toward the glowing line. Press the lane when the note touches it. Keys: {keys} or tap the lane buttons.", { keys }), ["tap"]],
    [T("Hold notes"), T("Long glowing bars must be held from head to tail, then released. Releasing early breaks your combo. Hold style: {style}.", { style: T(options().holdMode === "toggle" ? "Toggle" : "Hold") }), ["hold"]],
    [T("Timing grades"), T("Perfect ±45ms, Great ±90ms, Good ±135ms. Later than that is a miss and resets your combo."), []],
    [T("Combo & score"), T("Score = notes + combo bonus + hold bonus. Every 10 combo raises the per-note bonus. Results always show the full breakdown."), []],
    [T("Pause"), T("Press {key} or the ⏸ button to pause. Backgrounding the tab pauses automatically.", { key: pauseKey }), []],
    [T("Keyboard & gamepad"), T("Menus: arrows + Enter to confirm, Escape to go back. Gamepad: D-pad or face buttons hit lanes, Start pauses."), []],
  ];
  const gapX = 12;
  const cols = Math.max(1, Math.min(3, Math.floor((w + gapX) / (230 + gapX))));
  const cw = (w - (cols - 1) * gapX) / cols;
  ui.column("help-cards", () => {
    for (let r = 0; r * cols < cards.length; r++) {
      ui.row(`help-r${r}`, () => cards.slice(r * cols, (r + 1) * cols).forEach(([title, text, demo], j) => {
        ui.column(`help-${r * cols + j}`, () => {
          para(title, cw - 30, "help-h3", `help-${r * cols + j}-h`);
          para(text, cw - 30, "help-text", `help-${r * cols + j}-t`);
          if (demo.length) ui.widget("", {
            role: "none", size: { width: 60, height: 22 },
            draw: (rr) => {
              const s = rr.height;
              if (demo[0] === "tap") draw.circle(rr.x + s / 2, rr.y + s / 2, s / 2, "#59f2ff");
              else draw.roundRect(rr.x, rr.y, s * 2, s, s * 0.23, "#8affc1");
            },
          });
        }, { style: "help-card", width: cw, spacing: 6 });
      }), { spacing: gapX, align: "stretch" });
    }
  }, { spacing: gapX, width: w });
  flow("help-back", [backBtn()], w);
}

// ------------------------------------------------------------------ profile
const SYNC_TEXT: Record<string, string> = { saving: "Saving…", synced: "Synced", offline: "Offline — local save" };
function profileScreen(w: number): void {
  heading(T("Profile"), w);
  const p = progress();
  const signed = platform.signedIn();
  ui.row("profile-head", () => {
    const hue = p.profile.avatarHue ?? 200;
    ui.widget("", {
      role: "none", size: { width: 64, height: 64 },
      draw: (r) => {
        const bmp = platform.avatarBitmap();
        if (bmp) draw.image(bmp, r.x, r.y, r.width, r.height);
        else draw.circle(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, `hsl(${hue} 70% 55%)`);
      },
    });
    ui.column("profile-name", () => {
      ui.style("field-label").label(T("Display name"));
      if (signed) para(playerName(), w - 90, "meta-dd", "profile-account-name");
      else {
        const shown = p.profile.guest && p.profile.displayName === "Guest" ? T("Guest") : p.profile.displayName;
        const v = ui.textField("profile-name-field", shown, { maxChars: 24, width: w - 90 });
        if (v !== shown) later(() => setGuestName(v || T("Guest")));
      }
      para(signed ? T("Name comes from your StarHermit account.") : T("Local guest name, shown only on this device."), w - 90, "muted", "profile-name-note");
    }, { spacing: 4, width: w - 80 });
  }, { spacing: 16, align: "center" });
  const st = platform.syncState();
  metaGrid("profile-meta", [
    [T("Mastery level"), T("Level {level} ({xp} XP)", { level: p.mastery.level, xp: p.mastery.xp })],
    [T("Sessions"), String(p.stats.sessionsPlayed)],
    [T("Best combo"), String(p.stats.bestCombo)],
    [T("Days played"), String(Object.keys(p.stats.daysPlayed ?? {}).length)],
    [T("Cloud sync"), signed ? T(SYNC_TEXT[st ?? "saving"] ?? "Connecting…") : T("Local save only")],
  ], w);
  heading(T("Achievements"), w, "h3");
  ui.column("profile-ach", () => Persist.ACHIEVEMENTS.forEach((a, i) => {
    const got = !!p.achievements[a.key];
    ui.row(`ach-${i}`, () => {
      ui.column(`ach-${i}-t`, () => {
        para(T(a.name), w - 40, got ? "ach-name" : "ach-locked-name", `ach-${i}-name`);
        para(T(a.description), w - 40, got ? "ach-desc" : "ach-locked-desc", `ach-${i}-desc`);
      }, { spacing: 2, width: w - 30 });
      ui.style("ach-name").label(got ? "✓" : "");
    }, { style: "ach-row", width: w, align: "center" });
  }), { spacing: 0, width: w });
  flow("profile-back", [homeBack()], w);
}

// ------------------------------------------------------------------ pause
function pauseDialog(L: Layout): void {
  const w = Math.min(360, L.lw - 32) - 48;
  const open = ui.style("pause-dialog").dialog(T("Paused"), null, true, () => {
    ui.column("pause-col", () => {
      heading(T("Paused"), w);
      ui.column("pause-stack", () => {
        button({ id: "btn-resume", text: T("Resume"), cls: "btn-primary", act: () => { click(); resumeGame(); } }, w);
        button({ id: "btn-pause-restart", text: T("Restart track"), act: restartTrack }, w);
        button({ id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings") }, w);
        button({ id: "btn-pause-help", text: T("Help"), act: () => openOverlay("help") }, w);
        button({ id: "btn-leave", text: T("Leave track"), cls: "btn-danger", act: leaveGame }, w);
      }, { spacing: 8, width: w });
    }, { spacing: 12, width: w });
  });
  if (!open && fresh()) later(() => { click("back"); resumeGame(); });
}

// ------------------------------------------------------------------ the playfield
const JUDGE_NAMES: Record<string, string> = { perfect: "Perfect", great: "Great", good: "Good", miss: "Miss" };
function playfield(L: Layout): void {
  const s = app.session;
  const live = app.phase === "active";
  const f = frame();
  const pad = 12;
  const st = s?.state;
  // the HUD's top: objective, progress bar, pause button (a rail at the left on wide windows)
  const objective_ = objective();
  const pct = st && app.chart ? Math.min(1, Math.max(0, (live ? app.step * (1000 / 60) : 0) / app.chart.durationMs)) : 0;
  const bar = (bw: number): void => {
    ui.widget(T("Track progress"), {
      role: "meter", size: { width: bw, height: 6 }, value: Math.round(pct * 100), min: 0, max: 100,
      draw: (r, ws) => {
        draw.box(r.x, r.y, r.width, r.height, { background: "#ffffff1f", radius: 3 });
        if (pct > 0) draw.box(r.x, r.y, Math.max(1, r.width * pct), r.height, { background: ws.highContrast ? "#4deaff" : "#35e0ff", radius: 3 });
      },
    });
  };
  const pauseBtn = (): void => {
    const opts: ui.ButtonOptions = { content: pauseBars };
    if (!live) opts.disabled = true;
    const r = ui.column("pause-wrap", () => {
      if (ui.style("icon-btn").id("btn-pause").button(T("Pause (Escape)"), opts) && fresh() && live) later(() => { ui.setFocus(null); pauseGame(); });
    });
    pause = r;
  };
  const objW = (w: number): number => Math.min(w, textWidth(objective_, "hud-objective-text") + 26);
  if (L.wide) {
    const rw = Math.min(360, L.lw * 0.3);
    ui.place("hud-top", { anchor: "top-start", x: pad, y: 8 }, () => {
      ui.column("hud-obj", () => para(objective_, rw - 26, "hud-objective-text", "hud-objective"), { style: "hud-objective", width: objW(rw) });
      bar(rw);
      pauseBtn();
    }, { spacing: 8, width: rw });
  } else {
    const ow = Math.min(L.lw * 0.46, 420);
    ui.place("hud-top", { anchor: "top-start", x: pad, y: 8 }, () => {
      ui.row("hud-row", () => {
        ui.column("hud-obj", () => {
          const t = textWidth(objective_, "hud-objective-text") <= ow - 26 ? objective_ : clip(objective_, ow - 26, "hud-objective-text");
          ui.style("hud-objective-text").id("hud-objective").label(t);
        }, { style: "hud-objective", width: objW(ow) });
        bar(Math.max(40, L.lw - 2 * pad - objW(ow) - 44 - 24));
        pauseBtn();
      }, { spacing: 12, align: "center", width: L.lw - 2 * pad });
    });
  }
  // score, combo, accuracy, health (top end)
  if (st) {
    ui.place("hud-score", { anchor: "top-end", x: pad, y: L.wide ? 16 : 60 }, () => {
      ui.style("hud-score").id("hud-score").label(num(st.score.total));
      ui.style("hud-combo").id("hud-combo").label(st.combo >= 2 ? `${st.combo}×` : " ");
      const c = st.counts;
      const judged = c.perfect + c.great + c.good + c.miss;
      if (judged > 0) ui.style("hud-acc").id("hud-acc").label(`${(((c.perfect + c.great * 0.7 + c.good * 0.4) / judged) * 100).toFixed(1)}%`);
      if (st.failEnabled) ui.style("hud-health").id("hud-health").label(`♥ ${Math.round(st.health)}`);
    }, { spacing: 2, align: "end" });
  }
  // the lesson card
  if (app.lessonText) {
    const lw = Math.min(520, L.lw * 0.92);
    ui.place("lesson", { anchor: "top", y: L.wide ? 64 : L.short ? 60 : 160 }, () => {
      para(app.lessonText!.text(), lw - 40, "lesson-text", "lesson-text", "center");
      if (app.lessonText!.progress) ui.style("lesson-progress").id("lesson-progress").label(app.lessonText!.progress);
    }, { style: "lesson", spacing: 4, align: "center" });
  }
  // the judgment pop (450 ms) at 62 % of the height
  const j = app.judgment;
  if (j && f.frame - j.frame < 27) {
    const text = T(JUDGE_NAMES[j.grade] ?? j.grade) + (j.extra ? ` ${T(j.extra)}` : "");
    const size = L.phone ? 24 : 32;
    ui.place("judgment", { anchor: "top", y: L.lh * 0.62 - size / 2 }, () => {
      ui.style(`judge-${j.grade}`, { text: { size } }).id("judgment").label(text);
    });
  }
  // the countdown
  if (app.countdownText) {
    const size = Math.max(64, Math.min(144, L.lw * 0.18));
    ui.place("countdown", "center", () => ui.style("countdown", { text: { size } }).id("countdown-text").label(app.countdownText!));
  }
  // the lane buttons (the thumb-zone tray; mirrored for the left-handed)
  laneTray(L);
  // the caption line above the tray
  const c = app.caption;
  if (c && f.frame - c.frame < 108) {
    ui.place("caption", { anchor: "bottom", y: L.short ? 56 : 96 }, () => ui.style("caption-text").id("caption").label(c.text), { style: "caption" });
  }
}
function clip(text: string, width: number, cls: string): string {
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, cls) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
function pauseBars(): void {
  ui.widget("", {
    role: "none", size: { width: 12, height: 14 },
    draw: (r, s) => {
      const c = s.highContrast ? "#ffffff" : "#e8eeff";
      const bw = r.width * 0.32;
      draw.box(r.x, r.y, bw, r.height, { background: c, radius: 1 });
      draw.box(r.x + r.width - bw, r.y, bw, r.height, { background: c, radius: 1 });
    },
  });
}
function laneTray(L: Layout): void {
  const keys = laneKeys();
  const order = options().leftHanded ? [3, 2, 1, 0] : [0, 1, 2, 3];
  const trayW = L.short ? Math.min(L.lw * 0.62, 560) : L.wide ? Math.min(640, L.lw - 16) : L.lw - 16;
  const h = L.short ? 44 : L.phone ? 76 : 64;
  const big = ui.preferences().textScale > 1.1 && !L.short ? 84 : h;
  const g = 8;
  const bw = (trayW - 3 * g) / 4;
  const live = app.phase === "active";
  ui.place("lane-tray", { anchor: "bottom", y: L.short ? 4 : 8 }, () => {
    ui.row("lanes", () => {
      for (const lane of order) {
        const r = ui.column(`lane-${lane}`, () => {
          const name = T("Lane {n} ({key})", { n: lane + 1, key: keys[lane] ?? "" });
          const opts: ui.ButtonOptions = { selected: app.held[lane], content: () => { ui.style("lane-key").label(keys[lane] ?? ""); } };
          if (!live) opts.disabled = true;
          if (ui.style("lane-btn", { width: bw, minHeight: big }).id(`lane-btn-${lane + 1}`).button(name, opts) && live) laneButtonActivated(lane);
        });
        lanes[lane] = r;
      }
    }, { spacing: g });
  });
}
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  ui.place("toasts", { anchor: "bottom", y: L.short ? 60 : 90 }, () => {
    app.toasts.forEach((t, i) => ui.column(`toast-${i}`, () => para(t.text(), Math.min(420, L.lw - 60), "toast-text", `toast-${i}-t`, "center"), { style: "toast" }));
  }, { spacing: 6, align: "center" });
}


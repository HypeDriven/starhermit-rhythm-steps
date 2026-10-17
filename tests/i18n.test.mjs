// Localization coverage: every English key the markup and code use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, content (stages, challenges, lessons,
// themes, practice levels, achievements) is covered, and the language
// follows sh-language.js and switches live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';
import { JOURNEY_STAGES, CHALLENGES, PRACTICE_DIFFICULTIES, THEMES, LESSONS } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/persistence.js';
import { GFX_STRINGS } from '../js/gfx-i18n.js';
import { shText } from '../js/sh-i18n.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/main.js', 'js/ui.js', 'js/platform.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  for (const s of JOURNEY_STAGES) keys.add(s.name);
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.description); }
  for (const d of PRACTICE_DIFFICULTIES) keys.add(d.label);
  for (const t of Object.values(THEMES)) keys.add(t.name);
  for (const l of LESSONS) { keys.add(l.title); for (const s of l.steps) keys.add(s.text); }
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.description); }
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  const used = usedKeys();
  assert.ok(used.length > 250, 'keys found: ' + used.length);
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'RS_STRINGS'), used), []);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'RSI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Paused'), 'Pausiert');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Score'), 'Pointage');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Color-vision-safe palette'), 'Colour-vision-safe palette');
  I18N.language.setChoice('it-IT');
  assert.equal(I18N.T('Lane {n}', { n: 2 }), 'Corsia 2');
});

test('Graphics and StarHermit strings cover all nine locales', () => {
  for (const l of LOCALES) assert.ok(GFX_STRINGS[l], l);
  assert.equal(shText('signIn'), 'Sign in with StarHermit');
});

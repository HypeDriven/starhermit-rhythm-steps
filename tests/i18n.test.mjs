// Every string the client draws is translated: the T("…") / N("…") keys in
// native/*.ts, the content names (stages, difficulties, challenges, lessons,
// themes, achievements) and the audio captions are rows of assets/strings.json
// for es-419, de-DE, fr-FR, pt-BR and it-IT (en-GB, es-ES and fr-CA fall back
// through the engine's chain); the account strings are the engine's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JOURNEY_STAGES, PRACTICE_DIFFICULTIES, CHALLENGES, LESSONS, THEMES } from '../js/content.js';
import { ACHIEVEMENTS } from '../js/persistence.js';

const root = new URL('..', import.meta.url);
const TABLES = JSON.parse(readFileSync(new URL('assets/strings.json', root), 'utf8'));
const LOCALES = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

function clientKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', root)).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(new URL(`native/${f}`, root), 'utf8');
    for (const m of src.matchAll(/\b[TN]\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
    // captions: onCaption("key") in audio.ts; check() / sections' option labels
    for (const m of src.matchAll(/onCaption\(\s*(?:n === 0 \? )?"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/check\("\w+", "((?:[^"\\]|\\.)*)"\)/g)) keys.add(m[1]);
  }
  for (const s of JOURNEY_STAGES) keys.add(s.name);
  for (const d of PRACTICE_DIFFICULTIES) keys.add(d.label);
  for (const c of CHALLENGES) { keys.add(c.name); keys.add(c.description); }
  for (const l of LESSONS) { keys.add(l.title); for (const s of l.steps) keys.add(s.text); }
  for (const t of Object.values(THEMES)) keys.add(t.name);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.description); }
  for (const k of ['Combo {n}!', 'Miss', 'Go!', 'Track complete', 'Track ended']) keys.add(k);
  return [...keys].filter((k) => /[A-Za-z]/.test(k));
}

test('every client string is translated in every locale', () => {
  const missing = [];
  for (const k of clientKeys()) for (const loc of LOCALES) if (!Object.prototype.hasOwnProperty.call(TABLES[loc], k)) missing.push(`${loc}: ${k}`);
  assert.deepEqual(missing, []);
});

test('translations keep their placeholders', () => {
  for (const loc of LOCALES) {
    for (const [k, v] of Object.entries(TABLES[loc])) {
      const want = (k.match(/\{\w+\}/g) || []).sort().join();
      const got = (v.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(got, want, `${loc}: ${k}`);
    }
  }
});

// Localization: the browser build's string tables (js/strings.js, English
// text as the key; en-GB, es-ES and fr-CA list only their differences from
// en-US, es-419 and fr-FR) and the account strings (js/sh-i18n.js), in the
// interface language the runtime reports (preferences().language: the
// player's choice in Options › Language, else the account's preferred
// language or the device's). The runtime's Options replaced the game's
// Language setting (sh-language.js) and the DOM re-labelling (js/i18n.js):
// every string is drawn through T() each frame, so a change shows on the
// next frame without touching the run.
import { onPreferencesChange, preferences } from "starhermit:engine";
import { loadClassic } from "starhermit:script";
import * as ui from "starhermit:ui";
import { shText } from "../js/sh-i18n.js";

loadClassic("js/strings.js");
type Table = Record<string, string>;
const TABLES = (globalThis as unknown as { RS_STRINGS: Record<string, Table> }).RS_STRINGS;
const PARENT: Record<string, string> = { "en-GB": "en-US", "es-ES": "es-419", "fr-CA": "fr-FR" };
export const LOCALES = ["en-US", "en-GB", "es-419", "es-ES", "de-DE", "fr-FR", "fr-CA", "pt-BR", "it-IT"];

/** A BCP 47 tag → one of the nine locales (language match, then region). */
export function pickLocale(tag: string): string {
  const t = String(tag || "").replace("_", "-");
  if (LOCALES.includes(t)) return t;
  const [lang, region = ""] = t.split("-");
  const l = (lang ?? "").toLowerCase(), r = region.toUpperCase();
  if (l === "en") return r === "GB" || r === "IE" || r === "AU" || r === "NZ" ? "en-GB" : "en-US";
  if (l === "es") return r === "ES" ? "es-ES" : "es-419";
  if (l === "fr") return r === "CA" ? "fr-CA" : "fr-FR";
  if (l === "de") return "de-DE";
  if (l === "pt") return "pt-BR";
  if (l === "it") return "it-IT";
  return "en-US";
}

let locale = "en-US";
let applied = false;
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale && applied) return;
  applied = true;
  locale = next;
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

function lookup(key: string): string {
  for (let l: string | undefined = locale; l; l = PARENT[l]) {
    const t = TABLES[l];
    if (t && Object.prototype.hasOwnProperty.call(t, key)) return t[key]!;
  }
  return key;
}
export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  const s = lookup(key);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)) : s;
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account strings (sign in, invite, leaderboard line, …). */
export function S(key: string, vars?: Vars): string {
  return (shText as (l: string, k: string, v?: Vars) => string)(locale, key, vars);
}
/** A number in the player's locale (grouped thousands, as toLocaleString did). */
export function num(n: number, digits = 0): string {
  try { return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  catch { return digits ? n.toFixed(digits) : String(Math.round(n)); }
}

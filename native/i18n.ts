// Localization: the engine's string tables (assets/strings.json, English text
// as the key; en-GB, es-ES and fr-CA list only their differences) in the
// interface language the runtime reports (the player's choice in Options ›
// Language, else the account's preferred language or the device's); the
// engine's fallback chain picks the table. Every string is drawn through T()
// each frame, so a change shows on the next frame without touching the run.
// The account lines are the engine's own `starhermit.*` strings.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));
export function currentLocale(): string { return strings.locale; }

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
const ACCOUNT = {
  signIn: "signIn", invite: "invite", inviteCopied: "inviteCopied", inviteLink: "inviteLink", signedOut: "signedOut",
  lbPosting: "leaderboardPosting", lbRank: "leaderboardRank", lbPosted: "leaderboardPosted", lbNotPosted: "leaderboardNotPosted",
} as const;
/** An account line (the engine's) in the player's language. */
export function S(key: keyof typeof ACCOUNT, vars?: Vars): string { return strings.t(`starhermit.${ACCOUNT[key]}`, vars); }
/** A number in the player's locale (grouped thousands, as toLocaleString did). */
export function num(n: number, digits = 0): string {
  try { return n.toLocaleString(strings.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  catch { return digits ? n.toFixed(digits) : String(Math.round(n)); }
}

// The look of the screens, HUD and lane buttons: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (dialogs,
// scroll bars, check boxes, selects, text fields) take. The old
// body.high-contrast palette is a token set applied while the runtime's
// high-contrast option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** css/style.css body.high-contrast. */
const HIGH_CONTRAST: Tokens = { panel: "#000000f5", edge: "#9db8ff", text: "#ffffff", muted: "#c8d4f0", accent: "#4deaff" };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setFont({ family: "system-ui" });
  ui.setTheme({
    fontSize: 16, smallSize: 14.4, headingSize: 24, padding: 8, spacing: 10, radius: 10,
    text: "#e8eeff", muted: "#93a0c4", panel: "#0e1428", control: "#1a2648", hovered: "#2a3d6e",
    pressed: "#0e1428", field: "#060a16", accent: "#35e0ff", focus: "#ffe45e", outline: "#3a4f80",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "#ffe45e", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#93a0c4", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$text" }, radius: 6, padding: 6 },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}

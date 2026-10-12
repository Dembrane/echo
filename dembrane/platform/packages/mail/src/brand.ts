/**
 * The design system for what dembrane sends: offers, invoices, emails and the PDFs signed
 * copies are made of. It is the app's system (frontend/src/styles/rules.css, theme.tsx,
 * colors.ts) carried into media the app's CSS cannot reach, so a customer meets one
 * dembrane from the email to the account page to the signed PDF. Change a value in the app
 * first, then here; brand/CALL_TO_CASH.md says what each one is for.
 */

/** Colour roles. Every colour a surface draws is one of these. */
export const color = {
  /** The page behind a card: email background, the account page. */
  parchment: "#f6f4f1",
  /** The card itself, and the printed page. */
  surface: "#ffffff",
  /** All text. Never pure black. */
  text: "#2d2d2c",
  /** Labels, captions, secondary facts. AA on white and parchment. */
  muted: "#5f646f",
  /** Faint rules: above and below anything to read. */
  quiet: "#e6e3df",
  /** Rules around a place to write or type (3.28:1). */
  control: "#878785",
  /** Links and the one primary action. AA as text (royal blue is not). */
  action: "#2957df",
  actionTint: "#e9f1ff",
  onFill: "#ffffff",
  /** Status: only where something is wrong, late or done. Accents never stand in. */
  danger: "#c0434e",
  warning: "#7a5200",
  success: "#0e6e47",
  /** Decorative and categorical only, never meaning. */
  accent: { cyan: "#00ffff", springGreen: "#1effa1", mauve: "#ffc2ff", lime: "#f4ff81" },
} as const;

/**
 * One family, one weight. DM Sans at 320 for everything; size and space make the
 * hierarchy, never bold. 600 only for a word that must stand out inside a sentence.
 */
export const font = {
  family: "'DM Sans','DM Sans Variable',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  weight: 320,
  /** Email loads no web font (privacy, and few clients honour it); where DM Sans is installed, 300 is the nearest static cut. */
  emailWeight: 300,
  emphasis: 600,
  /** The warm single-storey a, g, u, y. The PDF cuts have them frozen in. */
  features: '"ss01","ss02","ss03","ss04","ss05","ss06"',
} as const;

/**
 * The type ladder: a perfect fourth (1.333) a step. Screen and email take the app's ladder
 * in px; print takes the same ratio in pt from 10, so a printed page reads at the size of a
 * letter. Running text is body; a title is a step or two up with space above, never bold.
 */
export const type = {
  screen: { caption: 14, body: 16, lead: 18.66, title: 24.88, display: 33.17 },
  print: { caption: 7.5, body: 10, lead: 13.33, title: 17.77, display: 23.69 },
  /** Line height of running text; titles sit tighter. */
  leading: { body: 1.55, title: 1.2 },
} as const;

/** Space in steps of 4 (px on screen, pt in print). */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48, 16: 64 } as const;

/**
 * Lines and corners. A rule is one stroke (1px, 0.5pt in print); its shape says what the
 * thing is: top and bottom for something to read, sides for something to fill in, a full
 * box for something to press. Everything is square except the primary pill.
 */
export const shape = {
  stroke: { screen: 1, print: 0.5 },
  radius: 0,
  pill: 9999,
} as const;

/** The marks, hosted where an email can load them. */
export const asset = {
  /** The wordmark on a light background, 147 x 30 at 1x. */
  wordmark: "https://dashboard.dembrane.com/dembrane-logo-email.png",
} as const;

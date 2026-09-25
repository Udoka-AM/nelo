/**
 * Nelo's design tokens: every colour, size and space the apps use.
 *
 * Both apps are dark, and used at a market stall in daylight on a mid-range
 * phone turned down to save battery. So contrast is not a preference: every
 * text colour here is tested (test/tokens.test.ts) to reach WCAG AA, 4.5:1,
 * on every surface it is used on. There is no "faint" grey below that line.
 *
 * Colour carries meaning, and only one meaning each:
 *
 *   positive   money that has arrived; the one primary action
 *   caution    needs attention, nothing lost: owed, waiting, an example figure
 *   danger     money that will not come; a refusal
 *
 * A hint is never green, because green is what "paid" looks like.
 */

export const color = {
  bg: "#101113",
  surface: "#17191b",
  surfaceHigh: "#1f2124",
  border: "#2c2f33",
  borderStrong: "#41454b",

  text: "#e8e9ea",
  textMuted: "#9ba1a8",

  positive: "#4fb98f",
  positiveSurface: "#12211a",
  primary: "#1a6b4c",
  primaryPressed: "#14543c",
  onPrimary: "#ffffff",

  caution: "#e0b45c",
  cautionSurface: "#221c10",
  danger: "#e8906a",
  dangerSurface: "#26170f",

  disabledSurface: "#1b1d20",
  disabledText: "#8d9299",

  /** What sits under a QR code: scanners want white. */
  qrBackground: "#ffffff",
  qrForeground: "#101113",
} as const;

export type ColorName = keyof typeof color;

/**
 * The text-on-surface pairs the components actually use. The test holds each
 * to 4.5:1. Adding a colour means adding its pairs here.
 */
export const PAIRS: readonly (readonly [ColorName, ColorName])[] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "surfaceHigh"],
  ["textMuted", "bg"],
  ["textMuted", "surface"],
  ["textMuted", "surfaceHigh"],
  ["positive", "bg"],
  ["positive", "surface"],
  ["positive", "positiveSurface"],
  ["onPrimary", "primary"],
  ["onPrimary", "primaryPressed"],
  ["caution", "bg"],
  ["caution", "surface"],
  ["caution", "cautionSurface"],
  ["danger", "bg"],
  ["danger", "surface"],
  ["danger", "dangerSurface"],
  ["text", "cautionSurface"],
  ["text", "dangerSurface"],
  ["text", "positiveSurface"],
  ["disabledText", "disabledSurface"],
  ["qrForeground", "qrBackground"],
];

/**
 * One type scale. Nothing smaller than 13: this is read at arm's length, in
 * sunlight, by people who did not choose to install a payments app.
 */
export const type = {
  /** The amount being charged. */
  display: 52,
  /** A headline amount: a balance, a total. */
  hero: 34,
  title: 26,
  heading: 19,
  body: 16,
  small: 14,
  caption: 13,
} as const;

export const weight = { regular: "400", medium: "600", bold: "700" } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, xxxl: 40 } as const;

export const radius = { sm: 10, md: 14, lg: 20 } as const;

/** Nothing a thumb has to hit is smaller than this, in dp. Android's own minimum. */
export const touch = 48;

/** WCAG relative luminance contrast between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

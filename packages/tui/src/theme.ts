/**
 * TUI theme — colors and glyphs in one place so the chat surface stays
 * consistent. chalk degrades gracefully when the terminal has no color.
 *
 * `config.tui.theme` names one of the palettes below. `setTheme` swaps the
 * values of the single exported `theme` object in place, so every call site
 * keeps reading `theme.bold` and simply gets the new color — none of them has
 * to know that a theme exists, or be threaded a palette through twenty
 * functions.
 */
import chalk, { Chalk, type ChalkInstance } from "chalk"

export interface Theme {
  /** Art, names, the word IMURUN. */
  brand: ChalkInstance
  /** Highlights that are not the brand: counts, paths in the panel. */
  accent: ChalkInstance
  bold: ChalkInstance
  /** Labels and secondary text on a dark background. */
  dim: ChalkInstance
  /** Text that is present but not the point of the line. */
  muted: ChalkInstance
  path: ChalkInstance
  ok: ChalkInstance
  warn: ChalkInstance
  error: ChalkInstance
}

/** The default: IMURUN's own colors, drawn for a dark terminal. */
const DARK: Theme = {
  brand: chalk.bold.cyan,
  accent: chalk.cyan,
  bold: chalk.bold,
  dim: chalk.gray,
  muted: chalk.dim,
  path: chalk.hex("#8ab4f8"),
  ok: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
}

/**
 * A light terminal. Cyan and yellow all but vanish on white, so the same hues
 * are taken down in brightness instead of being changed into different ones.
 */
const LIGHT: Theme = {
  brand: chalk.bold.blue,
  accent: chalk.blue,
  bold: chalk.bold,
  dim: chalk.hex("#4b5563"),
  muted: chalk.gray,
  path: chalk.hex("#1d4ed8"),
  ok: chalk.hex("#15803d"),
  warn: chalk.hex("#b45309"),
  error: chalk.hex("#b91c1c"),
}

/** No color at all — for logs, pipes, and terminals that mangle escapes. */
const NONE: Theme = (() => {
  const plain = new Chalk({ level: 0 })
  return {
    brand: plain.bold,
    accent: plain,
    bold: plain.bold,
    dim: plain.gray,
    muted: plain.dim,
    path: plain,
    ok: plain.green,
    warn: plain.yellow,
    error: plain.red,
  }
})()

/** The live theme. Every module reads this; `setTheme` rewrites it in place. */
export const theme: Theme = { ...DARK }

/** Theme names accepted in `config.tui.theme`. */
export const THEME_NAMES = ["imurun-dark", "imurun-light", "none"] as const

const PALETTES: Record<string, { palette: Theme; name: string }> = {
  "imurun-dark": { palette: DARK, name: "imurun-dark" },
  dark: { palette: DARK, name: "imurun-dark" },
  "imurun-light": { palette: LIGHT, name: "imurun-light" },
  light: { palette: LIGHT, name: "imurun-light" },
  none: { palette: NONE, name: "none" },
  plain: { palette: NONE, name: "none" },
}

/**
 * Applies a named theme and returns the one actually in effect. An unknown name
 * falls back to the default rather than leaving the previous theme half-applied,
 * so the caller can compare and tell the user.
 */
export function setTheme(name?: string): string {
  const wanted = (name ?? "imurun-dark").trim().toLowerCase()
  const chosen = PALETTES[wanted] ?? PALETTES["imurun-dark"]!
  Object.assign(theme, chosen.palette)
  return chosen.name
}

export const sym = {
  arrow: "\u276f", // ❯
  bullet: "\u25cf", // ●
  ok: "\u2714", // ✔
  fail: "\u2716", // ✖
  warn: "\u26a0", // ⚠
  star: "\u2605", // ★
  sub: "\u21b3", // ↳
  diamond: "\u25c6", // ◆
  queued: "\u25cb", // ○ a message that is waiting its turn
  undone: "\u2298", // ⊘ a queued message that was taken back
  chevronRight: "\u25b8", // ▸ a collapsed thinking block
  chevronDown: "\u25be", // ▾ an expanded thinking block
} as const

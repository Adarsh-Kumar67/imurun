/**
 * TUI theme — colors and glyphs in one place so the chat surface stays
 * consistent. chalk degrades gracefully when the terminal has no color.
 *
 * `config.tui.theme` names one of the palettes below. `setTheme` swaps the
 * values of the single exported `theme` object in place, so every call site
 * keeps reading `theme.bold` and simply gets the new color — none of them has
 * to know that a theme exists, or be threaded a palette through twenty
 * functions.
 *
 * The default palette is deliberately editorial rather than "terminal neon":
 * warm ivory text, a muted sand accent, a single brick red for the brand, and
 * quiet hairline rules. It reads like a printed page that happens to run code.
 */
import chalk, { Chalk, type ChalkInstance } from "chalk"

export interface Theme {
  /** Art, names, the word IMURUN. */
  brand: ChalkInstance
  /** Highlights that are not the brand: counts, paths in the panel. */
  accent: ChalkInstance
  /**
   * The one brand red. It marks the I and T in ImuTechz, the prompt chevron,
   * and the active edge of the interface — never body text.
   */
  red: ChalkInstance
  bold: ChalkInstance
  /** Labels and secondary text on a dark background. */
  dim: ChalkInstance
  /** Text that is present but not the point of the line. */
  muted: ChalkInstance
  path: ChalkInstance
  ok: ChalkInstance
  warn: ChalkInstance
  error: ChalkInstance
  /** Hairline rules, borders and other quiet structure. */
  rule: ChalkInstance
  /** A full-width title band (foreground + background). */
  bar: ChalkInstance
}

/** The default: IMURUN's own colors, drawn for a dark terminal. */
const DARK: Theme = {
  brand: chalk.bold.hex("#F4EFE5"),
  accent: chalk.hex("#D8C7A8"),
  red: chalk.red,
  bold: chalk.bold,
  dim: chalk.hex("#7C776E"),
  muted: chalk.hex("#B8B2A6"),
  path: chalk.hex("#9CB7C9"),
  ok: chalk.hex("#8FBF7F"),
  warn: chalk.hex("#E0A458"),
  error: chalk.hex("#E5484D"),
  rule: chalk.hex("#3A3733"),
  bar: chalk.bgHex("#161513").hex("#F2EDE3"),
}

/**
 * A light terminal, the same page under daylight: ink on warm paper, with the
 * brand red kept as the single loud color.
 */
const LIGHT: Theme = {
  brand: chalk.bold.hex("#24211C"),
  accent: chalk.hex("#8A5A2B"),
  red: chalk.red,
  bold: chalk.bold,
  dim: chalk.hex("#6E685E"),
  muted: chalk.hex("#3D3832"),
  path: chalk.hex("#255E8A"),
  ok: chalk.hex("#3F7A3A"),
  warn: chalk.hex("#9A6414"),
  error: chalk.hex("#A3232B"),
  rule: chalk.hex("#D8D1C5"),
  bar: chalk.bgHex("#EDE7DB").hex("#24211C"),
}

/** No color at all — for logs, pipes, and terminals that mangle escapes. */
const NONE: Theme = (() => {
  const plain = new Chalk({ level: 0 })
  return {
    brand: plain.bold,
    accent: plain,
    red: plain,
    bold: plain.bold,
    dim: plain.gray,
    muted: plain.dim,
    path: plain,
    ok: plain.green,
    warn: plain.yellow,
    error: plain.red,
    rule: plain.dim,
    bar: plain,
  }
})()

/** The live theme. Every module reads this; `setTheme` rewrites it in place. */
export const theme: Theme = { ...DARK }

/**
 * A horizontal gradient, painted across the characters of a line.
 *
 * A terminal cannot do glass, but it can do a gradient — and a band that
 * fades from one colour to another reads as depth rather than as a flat bar.
 *
 * Two things this has to get right:
 *
 *   1. **It must not break the text it is painting.** The line it is given
 *      usually already carries colour — the wordmark has a red "I" and a red
 *      "T" in it. Walking the string one character at a time would cut an
 *      escape sequence in half, and the tail of it would appear on screen as
 *      literal text. So escape sequences are copied whole.
 *   2. **It must paint the background, not the foreground.** The band is a
 *      gradient of colour *behind* the text; the text keeps the colour it
 *      was given, which is why the red "I" is still red on the gradient.
 *
 * It must also be cheap: a frame is redrawn several times a second, and a
 * wide band is hundreds of characters. The ramp is therefore computed once
 * into a small table of ready-made escape sequences, and each character
 * picks one — no colour maths and no chalk calls per character.
 */
export function gradientBand(text: string, from: string, to: string, foreground = "#F2EDE3"): string {
  const start = hexToRgb(from)
  const end = hexToRgb(to)
  if (!start || !end) return text
  // A truecolor gradient needs a terminal that understands 24-bit colour.
  // Where it does not, the band is simply the flat colour it was before.
  if (chalk.level < 3) return text

  const ink = hexToRgb(foreground)
  const steps = 24
  const ramp: string[] = []
  const rampPlain: string[] = []
  for (let step = 0; step < steps; step++) {
    const ratio = step / (steps - 1)
    const r = Math.round(start.r + (end.r - start.r) * ratio)
    const g = Math.round(start.g + (end.g - start.g) * ratio)
    const b = Math.round(start.b + (end.b - start.b) * ratio)
    const background = `\u001b[48;2;${r};${g};${b}m`
    // The band's own foreground, for the parts that carry no colour of their own.
    rampPlain.push(ink ? `${background}\u001b[38;2;${ink.r};${ink.g};${ink.b}m` : background)
    // And a version without it, for the parts that do.
    ramp.push(background)
  }

  const plain = visibleLength(text)
  const length = Math.max(plain - 1, 1)
  let out = ""
  let index = 0
  let painted = 0
  /** True while the text is inside a run of its own colour. */
  let styled = false

  while (index < text.length) {
    // An escape sequence is copied whole, so the styling it carries survives.
    if (text[index] === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(text.slice(index))
      if (match) {
        out += match[0]
        // A closing sequence ends the run; anything else starts or continues it.
        styled = !/^\u001b\[(?:0|39|22|23|24|27|28|29)m$/.test(match[0])
        index += match[0].length
        continue
      }
    }
    const step = Math.min(ramp.length - 1, Math.round((painted / length) * (ramp.length - 1)))
    // The band's foreground is only applied where the text has none of its own.
    out += (styled ? ramp[step]! : rampPlain[step]!) + text[index]!
    painted++
    index++
  }
  return `${out}\u001b[39m\u001b[49m`
}

/** The number of visible characters in a string. */
function visibleLength(text: string): number {
  let count = 0
  let index = 0
  while (index < text.length) {
    if (text[index] === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(text.slice(index))
      if (match) {
        index += match[0].length
        continue
      }
    }
    count++
    index++
  }
  return count
}

/** The gradient used for the title band: warm light into the brand red. */
export const TITLE_GRADIENT_FROM = "#F4EFE5"
export const TITLE_GRADIENT_TO = "#E5484D"

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return undefined
  const value = Number.parseInt(match[1]!, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

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
  dot: "\u00b7", // ·
  rule: "\u2500", // ─
  vbar: "\u2502", // │
} as const

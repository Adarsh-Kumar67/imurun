/**
 * The IMURUN wordmark.
 *
 * The art is built from per-glyph bitmaps rather than pasted in as a wall of
 * text, so the letters always line up and the "I" can be coloured on its own.
 * Colouring a single letter inside a multi-line banner is normally fiddly;
 * building the word glyph by glyph makes it trivial — the first glyph is the
 * one we paint red.
 *
 * Small terminals get the compact form, so the welcome never wraps.
 */
import { theme } from "./theme"
import { clampVisible } from "./text"

const SHADOW: Record<string, string[]> = {
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚══╝"],
}

const COMPACT: Record<string, string[]> = {
  I: ["█", "█", "▀"],
  M: ["█▀▄▀█", "█ ░ █", "▀ ░ ▀"],
  U: ["█ █", "█ █", "▀▀▀"],
  R: ["█▀▄", "█▀▄", "▀ ▀"],
  N: ["█▄ █", "█ ▀█", "▀  ▀"],
}

/** Joins glyph bitmaps into a word, padding rows so every line lines up. */
function buildWord(word: string, glyphs: Record<string, string[]>, gap = " "): string[] {
  const built = [...word].map((char) => {
    const glyph = glyphs[char] ?? [" ".repeat(1), " ".repeat(1), " ".repeat(1), " ".repeat(1), " ".repeat(1), " ".repeat(1)]
    const height = glyph.length
    const width = Math.max(...glyph.map((row) => row.length))
    return glyph.map((row) => row + " ".repeat(Math.max(0, width - row.length)))
  })
  const height = Math.max(...built.map((glyph) => glyph.length))
  const lines: string[] = []
  for (let row = 0; row < height; row++) {
    lines.push(built.map((glyph) => glyph[row] ?? " ".repeat(glyph[0]?.length ?? 0)).join(gap))
  }
  return lines
}

/** Big ASCII wordmark (plain, no colour). The first 3 columns are the "I". */
export const LOGO_ART: readonly string[] = buildWord("IMURUN", SHADOW)
const COMPACT_ART: readonly string[] = buildWord("IMURUN", COMPACT, " ")

export const LOGO_WIDTH = LOGO_ART[0]?.length ?? 0
export const COMPACT_WIDTH = COMPACT_ART[0]?.length ?? 0

/** Width of the red "I" at the start of every big-logo line. */
const I_WIDTH = 3

/** Paints one line of the big art, with the "I" in red. */
export function paintLogoLine(line: string): string {
  const head = line.slice(0, I_WIDTH)
  const rest = line.slice(I_WIDTH)
  return theme.error(head) + theme.brand(rest)
}

/** The wordmark, coloured: the "I" red, the rest brand-coloured. */
export function logoLines(): string[] {
  return LOGO_ART.map(paintLogoLine)
}

/** The wordmark, falling back to the compact form, ready to print. */
export function renderWordmark(budget: number): string[] {
  if (budget >= LOGO_WIDTH) return logoLines()
  return COMPACT_ART.map((line) => theme.brand(line))
}

/** "by ImuTechz" — the maker's mark, with the I and the T in red. */
export function creditLine(): string {
  return theme.dim("by ") + theme.error("I") + theme.dim("mu") + theme.error("T") + theme.dim("echz")
}

/** Visible width of the credit line. */
export const CREDIT_WIDTH = "by ImuTechz".length

export interface WelcomeOptions {
  /** Available columns in the transcript area. */
  width: number
  version: string
  model: string
  agent: string
  workingDir: string
}

/**
 * The first screen: the wordmark, the credit, and the three facts that matter
 * (which model, which agent, which directory). Centred when there is room.
 *
 * Every line is clamped to `width`, so the welcome can never push the frame
 * wider than the terminal on a narrow window.
 */
export function welcomeLines(options: WelcomeOptions): string[] {
  const width = Math.max(options.width, 20)
  const art = renderWordmark(width)
  const out: string[] = [""]

  if (width >= LOGO_WIDTH) {
    const indent = " ".repeat(Math.max(0, Math.floor((width - LOGO_WIDTH) / 2)))
    for (const line of art) out.push(indent + line)
    const creditPad = " ".repeat(Math.max(0, Math.floor((width - CREDIT_WIDTH) / 2)))
    out.push(creditPad + creditLine())
  } else {
    for (const line of art) out.push(`  ${line}`)
    out.push(`  ${creditLine()}`)
  }

  out.push("")
  out.push(`  ${theme.dim("model")}  ${theme.accent(options.model)}`)
  out.push(`  ${theme.dim("agent")}  ${theme.accent(options.agent)}`)
  out.push(`  ${theme.dim("cwd")}    ${theme.muted(options.workingDir)}`)
  out.push("")
  out.push(`  ${theme.dim(`IMURUN v${options.version} \u00b7 your code, your machine, your model`)}`)
  out.push(`  ${theme.dim("Type a message to start, or / for commands.")}`)
  out.push(`  ${theme.dim("shift+tab switches agent \u00b7 enter sends \u00b7 esc interrupts")}`)
  out.push("")
  return out.map((line) => clampVisible(line, width))
}

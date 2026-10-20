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
import { clampVisible, padVisible, visibleWidth } from "./text"

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
  return theme.red(head) + theme.brand(rest)
}

/** The wordmark, coloured: the "I" red, the rest brand-coloured. */
export function logoLines(): string[] {
  return LOGO_ART.map(paintLogoLine)
}

/**
 * "ImuTechz" as a lockup: the I and the T carry the brand red, the rest of the
 * name stays in the surrounding colour. Used by the header and the credit.
 */
export function techzMark(base: (text: string) => string = theme.brand): string {
  return theme.red("I") + base("mu") + theme.red("T") + base("echz")
}

/** "by ImuTechz" — the maker's mark, with the I and the T in red. */
export function creditLine(): string {
  return theme.dim("by ") + theme.red("I") + theme.dim("mu") + theme.red("T") + theme.dim("echz")
}

/** Visible width of the credit line. */
export const CREDIT_WIDTH = "by ImuTechz".length

/** The wordmark, falling back to the compact form, ready to print. */
export function renderWordmark(budget: number): string[] {
  if (budget >= LOGO_WIDTH) return logoLines()
  return COMPACT_ART.map((line) => theme.brand(line))
}

export interface WelcomeOptions {
  /** Available columns in the transcript area. */
  width: number
  version: string
  model: string
  agent: string
  workingDir: string
}

/** A rounded card of the three facts that matter, drawn to `width`. */
function infoCard(width: number, rows: Array<[string, string]>): string[] {
  const total = Math.min(Math.max(width - 2, 20), 64)
  const inner = total - 2
  const indent = " ".repeat(Math.max(Math.floor((width - total) / 2), 0))
  const chip = " ready "
  const left = Math.max(Math.floor((inner - chip.length) / 2), 1)
  const right = Math.max(inner - chip.length - left, 1)
  const top = theme.rule("\u256d" + "\u2500".repeat(left)) + theme.dim(chip) + theme.rule("\u2500".repeat(right) + "\u256e")

  const lines = [indent + top]
  for (const [label, value] of rows) {
    const labelText = theme.dim(label.padEnd(8))
    const room = Math.max(inner - 10, 4)
    const text = clampVisible(value, room)
    lines.push(indent + theme.rule("\u2502") + padVisible(` ${labelText} ${text}`, inner) + theme.rule("\u2502"))
  }

  const site = " imutechz.in "
  if (inner >= site.length + 8) {
    const before = Math.floor((inner - site.length) / 2)
    const after = inner - site.length - before
    lines.push(
      indent +
        theme.rule("\u2570" + "\u2500".repeat(before)) +
        theme.dim(site) +
        theme.rule("\u2500".repeat(after) + "\u256f"),
    )
  } else {
    lines.push(indent + theme.rule("\u2570" + "\u2500".repeat(inner) + "\u256f"))
  }
  return lines
}

/** Centres a styled line within `width`, keeping its visible width intact. */
function centred(text: string, width: number): string {
  const pad = Math.max(Math.floor((width - visibleWidth(text)) / 2), 0)
  return " ".repeat(pad) + text
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
  out.push(...infoCard(width, [
    ["model", theme.accent(options.model)],
    ["agent", theme.accent(options.agent)],
    ["cwd", theme.muted(options.workingDir)],
  ]))
  out.push("")
  out.push(
    centred(
      `${theme.red("\u25c6")} ${theme.dim("Type a message to start")} ${theme.rule("\u00b7")} ${theme.dim("/ for commands")}`,
      width,
    ),
  )
  out.push(
    centred(
      `${theme.dim("shift+tab")} agent ${theme.rule("\u00b7")} ${theme.dim("enter")} send ${theme.rule("\u00b7")} ${theme.dim("esc")} interrupt`,
      width,
    ),
  )
  out.push(
    centred(
      `${theme.dim(`IMURUN v${options.version}`)} ${theme.rule("\u00b7")} ${theme.muted("your code, your machine, your model")}`,
      width,
    ),
  )
  out.push("")
  return out.map((line) => clampVisible(line, width))
}

/** A compact inline lockup for the header: "ImuTechz · IMURUN". */
export function headerMark(version: string): string {
  return `${techzMark()}  ${theme.bold("IMURUN")} ${theme.dim(`v${version}`)}`
}

/** Visible width of the header lockup, for layout decisions. */
export const HEADER_MARK_WIDTH = "ImuTechz  IMURUN v".length

/** The three window dots, red / amber / green, as a small chrome motif. */
export function chromeDots(): string {
  return `${theme.red("\u25cf")} ${theme.warn("\u25cf")} ${theme.ok("\u25cf")}`
}

/** Visible width of `chromeDots`. */
export const CHROME_DOTS_WIDTH = 5

/** A right-aligned agent badge: "AGENT 03/05". */
export function agentBadge(index: number, total: number): string {
  const pad = (value: number): string => String(Math.max(value, 0)).padStart(2, "0")
  return `${theme.dim("AGENT")} ${theme.accent(pad(index))}${theme.dim(`/${pad(total)}`)}`
}

/** Visible width of an agent badge with two-digit numbers. */
export const AGENT_BADGE_WIDTH = "AGENT 00/00".length

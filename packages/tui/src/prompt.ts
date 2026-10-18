/**
 * The prompt box — a bordered, multi-line input.
 *
 * It is deliberately a pure function: given the text, the caret index and a
 * width it returns the exact lines to draw plus where the terminal caret goes.
 * That keeps the fiddly parts (vertical scrolling for multi-line input,
 * horizontal scrolling for long lines, the caret column) testable without a
 * terminal, which is the only way to keep them correct.
 */
import { theme } from "./theme"
import { fitInput, padVisible, visibleWidth } from "./text"

export interface PromptBoxOptions {
  input: string
  cursor: number
  width: number
  /** Maximum text rows inside the box (borders excluded). */
  maxRows?: number
  placeholder?: string
  /** Right-aligned on the top border, e.g. "esc to interrupt". */
  hint?: string
  /** Styling applied to the text region; must not change its visible length. */
  paint?: (text: string) => string
  tone?: "normal" | "busy" | "queued"
}

export interface PromptBox {
  /** Top border, text rows, bottom border — each exactly `width` cells wide. */
  lines: string[]
  /** 1-based caret position inside `lines`. */
  cursor: { row: number; col: number }
  /** Text rows shown (borders excluded). */
  rows: number
  /** True when a line is horizontally scrolled to follow the caret. */
  scrolled: boolean
  /**
   * One entry per text row: which input line it shows, and the character index
   * that the left edge of the visible slice starts at. This is what makes a
   * mouse click land on the character that was actually clicked.
   */
  layout: Array<{ line: number; start: number }>
}

/** Number of text rows the box will use for the given input. */
export function promptRowCount(input: string, maxRows = 6): number {
  const explicit = input.split("\n").length
  return Math.min(Math.max(explicit, 1), Math.max(maxRows, 1))
}

function borderColor(tone: PromptBoxOptions["tone"]): (text: string) => string {
  if (tone === "busy") return theme.warn
  if (tone === "queued") return theme.accent
  return theme.dim
}

/**
 * Lays the caret out in `input`: which explicit line it is on and its offset
 * within that line. Splitting on "\n" first means the caret mapping is exact
 * for multi-line input, which wrapped-text mapping is not.
 */
export function caretPosition(input: string, cursor: number): { row: number; col: number } {
  const at = Math.min(Math.max(cursor, 0), input.length)
  const lines = input.split("\n")
  let consumed = 0
  for (let index = 0; index < lines.length; index++) {
    const length = lines[index]!.length
    if (at <= consumed + length) return { row: index, col: at - consumed }
    consumed += length + 1
  }
  const last = lines.length - 1
  return { row: last, col: lines[last]!.length }
}

export function buildPromptBox(options: PromptBoxOptions): PromptBox {
  const width = Math.max(options.width, 10)
  const inner = width - 2
  const maxRows = Math.max(options.maxRows ?? 6, 1)
  const paint = options.paint ?? ((text: string) => text)
  const border = borderColor(options.tone)
  const input = options.input
  const at = Math.min(Math.max(options.cursor, 0), input.length)
  const rawLines = input.split("\n")
  const caret = caretPosition(input, at)

  const shownRows = Math.min(Math.max(rawLines.length, 1), maxRows)
  let first = 0
  if (rawLines.length > shownRows) {
    first = Math.min(Math.max(caret.row - shownRows + 1, 0), rawLines.length - shownRows)
  }

  const budget = Math.max(inner - 3, 4) // one leading space + a two-cell marker
  const textRows: string[] = []
  const layout: Array<{ line: number; start: number }> = []
  let cursorCol = width
  let scrolled = false
  const empty = input.length === 0

  for (let index = 0; index < shownRows; index++) {
    const absolute = first + index
    const line = rawLines[absolute] ?? ""
    const prefix = absolute === 0 ? "\u276f " : "  "
    const isPlaceholder = empty && absolute === 0
    const source = isPlaceholder ? (options.placeholder ?? "") : line
    const offset = isPlaceholder ? source.length : absolute === caret.row ? caret.col : source.length

    const fitted = fitInput(source, offset, budget)
    if (fitted.text.startsWith("\u2026")) scrolled = true
    layout.push({ line: absolute, start: isPlaceholder ? 0 : fitted.start })

    const plain = ` ${prefix}${fitted.text}`
    const styled = isPlaceholder ? theme.muted(plain) : paint(plain)

    if (absolute === caret.row) cursorCol = 3 + prefix.length + (isPlaceholder ? source.length : fitted.cursor)
    textRows.push(`${border("\u2502")}${padVisible(styled, inner)}${border("\u2502")}`)
  }

  // top border: ╭─ message ──────── hint ─╮
  const title = " message "
  let hintText = options.hint ? ` ${options.hint} ` : ""
  if (inner - 1 - visibleWidth(title) - visibleWidth(hintText) < 2) hintText = ""
  const dashes = Math.max(0, inner - 1 - visibleWidth(title) - visibleWidth(hintText))
  const top =
    border("\u256d\u2500") + theme.dim(title) + border("\u2500".repeat(dashes)) + theme.dim(hintText) + border("\u256e")

  // bottom border: ╰────────────────╯
  const bottom = border(`\u2570${"\u2500".repeat(Math.max(0, width - 2))}\u256f`)

  return {
    lines: [top, ...textRows, bottom],
    cursor: { row: 1 + (caret.row - first), col: Math.min(Math.max(cursorCol, 1), width) },
    rows: shownRows,
    scrolled,
    layout,
  }
}

/**
 * Text helpers for the TUI. Everything here is pure so it can be unit tested
 * without a terminal.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "")
}

/** Width of a line in visible characters (ANSI sequences don't count). */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length
}

/** First non-empty line of a block, trimmed and truncated. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim()
  if (line.length <= max) return line
  return `${line.slice(0, Math.max(1, max - 1))}\u2026`
}

/** Truncates plain text to a visible width, adding an ellipsis. */
export function truncateVisible(text: string, max: number): string {
  const plain = stripAnsi(text)
  if (plain.length <= max) return text
  return `${plain.slice(0, Math.max(1, max - 1))}\u2026`
}

/** Right-pads text with spaces so it occupies exactly `width` visible cells. */
export function padVisible(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return text
  return text + " ".repeat(width - visible)
}

/** Truncates to a visible width and pads, so text fills the given cells. */
export function fitVisible(text: string, width: number): string {
  return padVisible(truncateVisible(text, width), width)
}

/**
 * Truncates styled text to a visible width, keeping the ANSI sequences intact
 * and ending with an ellipsis (unlike `truncateVisible`, which drops styling).
 */
export function clampVisible(text: string, max: number): string {
  const width = Math.max(max, 1)
  if (visibleWidth(text) <= width) return text
  const limit = Math.max(width - 1, 0)
  let out = ""
  let visible = 0
  let i = 0
  while (i < text.length && visible < limit) {
    if (text[i] === "\u001b") {
      const match = /^\u001b\[[0-9;]*m/.exec(text.slice(i))
      if (match) {
        out += match[0]
        i += match[0].length
        continue
      }
    }
    out += text[i]
    visible++
    i++
  }
  return `${out}\u001b[0m\u2026`
}

/**
 * Shows a slice of a line with the caret kept in view: the returned `text` is
 * at most `max` columns wide and `cursor` is its offset inside `text`.
 * `start` is the character index the slice begins at, so a click can be mapped
 * back to a real position in the source line.
 */
export function fitInput(
  value: string,
  cursor: number,
  max: number,
): { text: string; cursor: number; start: number } {
  const width = Math.max(1, Math.floor(max))
  const at = Math.min(Math.max(cursor, 0), value.length)
  if (value.length <= width) return { text: value, cursor: at, start: 0 }

  // Scroll just enough to keep the caret in the window…
  let start = Math.max(0, at - width + 1)
  // …but never past the end: the window must still reach the last character.
  if (start > 0 && value.length - start < width - 1) start = Math.max(0, value.length - (width - 1))

  const prefix = start > 0 ? "\u2026" : ""
  const visible = value.slice(start, start + width - prefix.length)
  const text = prefix + visible
  return { text, cursor: Math.min(Math.max(at - start + prefix.length, 0), text.length), start }
}

/** Wraps text to a width, splitting over-long words. Preserves blank lines. */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width)
  const out: string[] = []

  for (const raw of text.split(/\r?\n/)) {
    if (raw.length <= max) {
      out.push(raw)
      continue
    }

    let current = ""
    const flush = (): void => {
      out.push(current.replace(/\s+$/, ""))
      current = ""
    }

    for (const token of raw.split(/(\s+)/)) {
      if (token === "") continue
      if (token.trim() === "") {
        if (current && current.length + token.length <= max) current += token
        else if (current) flush()
        continue
      }
      if (current.length + token.length <= max) {
        current += token
        continue
      }
      if (current) flush()
      let word = token
      while (word.length > max) {
        out.push(word.slice(0, max))
        word = word.slice(max)
      }
      current = word
    }
    flush()
  }

  return out
}

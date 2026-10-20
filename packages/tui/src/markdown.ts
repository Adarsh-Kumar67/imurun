/**
 * Markdown → terminal lines.
 *
 * Local models answer in markdown, so the transcript has to render it: headings,
 * lists, quotes, tables, links, inline code, and fenced code with a little
 * syntax colour. Getting that wrong is worse than not doing it at all — a
 * half-rendered `**bold**` in the middle of a sentence looks broken — so the
 * inline parser is deliberately conservative: it only treats a marker as markup
 * when it is unambiguously markup (no `*` surrounded by spaces, no `_` inside an
 * identifier).
 *
 * Everything is a pure function of (text, width, palette). Wrapping happens on
 * *segments* rather than on styled strings, which is what makes inline styles
 * survive a line break correctly.
 */
import chalk from "chalk"
import { theme } from "./theme"
import { hyperlink } from "./hyperlink"

export interface MarkdownPalette {
  heading: (text: string) => string
  bold: (text: string) => string
  italic: (text: string) => string
  /** Inline `code`. */
  code: (text: string) => string
  keyword: (text: string) => string
  string: (text: string) => string
  number: (text: string) => string
  comment: (text: string) => string
  bullet: (text: string) => string
  quote: (text: string) => string
  rule: (text: string) => string
  link: (text: string) => string
  dim: (text: string) => string
}

export const DEFAULT_MARKDOWN_PALETTE: MarkdownPalette = {
  heading: chalk.bold.cyan,
  bold: chalk.bold,
  italic: chalk.italic,
  code: chalk.hex("#e5c07b"),
  keyword: chalk.cyan,
  string: chalk.green,
  number: chalk.magenta,
  comment: chalk.gray,
  bullet: chalk.cyan,
  quote: chalk.dim.gray,
  rule: chalk.gray,
  link: chalk.hex("#8ab4f8").underline,
  dim: theme.dim,
}

export interface MarkdownOptions {
  width: number
  palette?: Partial<MarkdownPalette>
  /** Appended to the last line — the streaming caret. */
  caret?: string
  /** Fenced code blocks longer than this are truncated. */
  maxCodeLines?: number
}

interface Segment {
  text: string
  style?: keyof MarkdownPalette
  /** The URL this segment points at, when it is a link. */
  link?: string
}

const DEFAULT_MAX_CODE_LINES = 60

/** Languages whose line comment is `#`. */
const HASH_COMMENTS = new Set([
  "py", "python", "sh", "bash", "zsh", "shell", "fish", "ps1", "powershell", "yaml", "yml", "toml",
  "rb", "ruby", "r", "makefile", "make", "dockerfile", "docker", "conf", "ini", "cfg", "env", "pl", "perl",
])

/** Languages whose line comment is `--`. */
const DASH_COMMENTS = new Set(["sql", "lua", "hs", "haskell", "elm", "ada"])

const KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "bool", "break", "case", "catch", "chan", "class", "const",
  "constructor", "continue", "def", "default", "defer", "delete", "do", "dyn", "elif", "else", "enum", "except",
  "export", "extends", "extern", "false", "finally", "fn", "for", "from", "func", "function", "global", "go",
  "if", "impl", "implements", "import", "in", "instanceof", "int", "interface", "is", "lambda", "let", "match",
  "mod", "mut", "new", "nil", "none", "not", "null", "number", "object", "or", "package", "pass", "private",
  "protected", "pub", "public", "raise", "readonly", "return", "select", "self", "static", "string", "struct",
  "super", "switch", "this", "throw", "trait", "true", "try", "type", "typeof", "undefined", "union", "unless",
  "until", "use", "var", "void", "when", "where", "while", "with", "yield",
])

// ── Inline parsing ──────────────────────────────────────────────────────────

const INLINE: Array<{ re: RegExp; style: keyof MarkdownPalette }> = [
  { re: /`([^`\n]+)`/, style: "code" },
  { re: /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/, style: "bold" },
  { re: /__(?!\s)([^_\n]+?)(?<!\s)__/, style: "bold" },
  { re: /~~(?!\s)([^~\n]+?)(?<!\s)~~/, style: "italic" },
  { re: /(?<![A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9_])/, style: "italic" },
  { re: /\*(?!\s)([^*\n]+?)(?<!\s)\*/, style: "italic" },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, style: "link" },
]

/** A bare URL in the text, which is worth making clickable. */
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+[^\s<>()[\]"'`.,;:!?]/

/** Splits a line of markdown into styled segments. */
export function inlineSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let index = 0

  while (index < text.length) {
    const rest = text.slice(index)
    let best: { at: number; raw: string; display: string; style: keyof MarkdownPalette; link?: string } | undefined

    for (const pattern of INLINE) {
      const match = pattern.re.exec(rest)
      if (!match) continue
      if (best && match.index >= best.at) continue

      let display = match[1] ?? match[0]
      let link: string | undefined
      if (pattern.style === "link") {
        const url = match[2] ?? ""
        if (url && display !== url && !display.includes("http")) display = `${display} (${url})`
        if (/^https?:\/\//i.test(url)) link = url
      }
      best = { at: match.index, raw: match[0], display, style: pattern.style, link }
    }

    // A bare URL is a link too — models write them without markdown.
    const bare = BARE_URL.exec(rest)
    if (bare && (!best || bare.index < best.at)) {
      best = { at: bare.index, raw: bare[0], display: bare[0], style: "link", link: bare[0] }
    }

    if (!best) {
      segments.push({ text: rest })
      break
    }
    if (best.at > 0) segments.push({ text: rest.slice(0, best.at) })
    segments.push({ text: best.display, style: best.style, link: best.link })
    index += best.at + best.raw.length
  }

  return mergeSegments(segments)
}

function mergeSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    if (segment.text === "") continue
    const last = out[out.length - 1]
    if (last && last.style === segment.style && last.link === segment.link) last.text += segment.text
    else out.push({ ...segment })
  }
  return out
}

function painted(segment: Segment, palette: MarkdownPalette): string {
  const styled = segment.style ? palette[segment.style](segment.text) : segment.text
  // The link escape wraps the styled text, so the colour survives and the
  // URL is still clickable.
  return segment.link ? hyperlink(segment.link, styled) : styled
}

function paintLine(segments: Segment[], palette: MarkdownPalette): string {
  return segments.map((segment) => painted(segment, palette)).join("")
}

/**
 * Wraps styled segments to a width.
 *
 * The unit of wrapping is a *word inside a segment*, so a `**bold phrase**`
 * that spans a line break is still bold on both lines.
 */
export function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const max = Math.max(width, 8)
  const lines: Segment[][] = []
  let line: Segment[] = []
  let length = 0

  const append = (segment: Segment): void => {
    if (segment.text === "") return
    const last = line[line.length - 1]
    // A link is only merged into a neighbour when it points at the same URL:
    // two different links side by side must stay two links.
    if (last && last.style === segment.style && last.link === segment.link) last.text += segment.text
    else line.push(segment)
    length += segment.text.length
  }
  const breakLine = (): void => {
    lines.push(line)
    line = []
    length = 0
  }

  for (const segment of segments) {
    // Every part of a segment keeps the segment's link, so a URL split across
    // a line break is still one clickable link.
    const part = (text: string): Segment => ({
      text,
      style: segment.style,
      link: segment.link,
    })
    for (const piece of segment.text.split(/(\s+)/)) {
      if (piece === "") continue
      if (piece.trim() === "") {
        if (length + piece.length <= max) append(part(piece))
        else breakLine()
        continue
      }
      if (length + piece.length <= max) {
        append(part(piece))
        continue
      }
      if (length > 0) breakLine()

      let word = piece
      while (word.length > max) {
        append(part(word.slice(0, max)))
        breakLine()
        word = word.slice(max)
      }
      if (word !== "") append(part(word))
    }
  }

  if (line.length > 0 || lines.length === 0) breakLine()
  return lines
}

/** Renders a paragraph with a fixed prefix on every line. */
function renderBlock(
  segments: Segment[],
  width: number,
  palette: MarkdownPalette,
  prefix: string,
  continuation = " ".repeat(prefix.length),
): string[] {
  const budget = Math.max(width - prefix.length, 8)
  const wrapped = wrapSegments(segments, budget)
  return wrapped.map((line, index) => (index === 0 ? prefix : continuation) + paintLine(line, palette))
}

// ── Code highlighting ───────────────────────────────────────────────────────

function commentStyle(lang: string): "hash" | "dash" | "slash" {
  if (HASH_COMMENTS.has(lang)) return "hash"
  if (DASH_COMMENTS.has(lang)) return "dash"
  return "slash"
}

/** A small, safe highlighter: strings and comments are never re-scanned. */
export function highlightCode(line: string, lang: string, palette: MarkdownPalette): string {
  const comments = commentStyle(lang)
  let out = ""
  let index = 0

  while (index < line.length) {
    const char = line[index]!
    const rest = line.slice(index)

    if (comments !== "hash" && comments !== "dash" && rest.startsWith("//")) {
      out += palette.comment(rest)
      break
    }
    if (comments === "hash" && char === "#") {
      out += palette.comment(rest)
      break
    }
    if (comments === "dash" && rest.startsWith("--")) {
      out += palette.comment(rest)
      break
    }
    if (comments !== "hash" && comments !== "dash" && rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2)
      const piece = end < 0 ? rest : rest.slice(0, end + 2)
      out += palette.comment(piece)
      index += piece.length
      continue
    }

    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1
      let value = char
      while (cursor < line.length) {
        const next = line[cursor]!
        value += next
        if (next === "\\" && cursor + 1 < line.length) {
          value += line[cursor + 1]
          cursor += 2
          continue
        }
        cursor++
        if (next === char) break
      }
      out += palette.string(value)
      index = cursor
      continue
    }

    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest)
    if (word) {
      out += KEYWORDS.has(word[0].toLowerCase()) ? palette.keyword(word[0]) : word[0]
      index += word[0].length
      continue
    }

    const number = /^\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (number) {
      out += palette.number(number[0])
      index += number[0].length
      continue
    }

    out += char
    index++
  }

  return out
}

function renderCode(body: string[], lang: string, width: number, palette: MarkdownPalette, maxLines: number): string[] {
  const label = lang ? ` ${lang} ` : ""
  const dashes = Math.max(0, width - 3 - label.length)
  const header =
    palette.dim("\u256d\u2500") + (lang ? palette.link(label) : "") + palette.dim(`${"\u2500".repeat(dashes)}\u256e`)
  const footer = palette.dim(`\u2570${"\u2500".repeat(Math.max(0, width - 2))}\u256f`)

  const shown = body.slice(0, maxLines)
  const lines = shown.map((code) => `${palette.dim("\u2502 ")}${highlightCode(code, lang, palette)}`)
  if (shown.length === 0) lines.push(palette.dim("\u2502"))
  if (body.length > shown.length) lines.push(palette.dim(`\u2502 \u2026 ${body.length - shown.length} more line(s)`))

  return [header, ...lines, footer]
}

// ── Tables ──────────────────────────────────────────────────────────────────

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** True when the line is a markdown table alignment row (`|---|:--:|`). */
export function isTableSeparator(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false
  return TABLE_SEPARATOR.test(line)
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

function alignmentOf(separator: string): Array<"left" | "center" | "right"> {
  return splitRow(separator).map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    return "left"
  })
}

function padCell(text: string, width: number, align: "left" | "center" | "right"): string {
  const plain = text.length
  if (plain >= width) return text
  const slack = width - plain
  if (align === "right") return " ".repeat(slack) + text
  if (align === "center") {
    const left = Math.floor(slack / 2)
    return " ".repeat(left) + text + " ".repeat(slack - left)
  }
  return text + " ".repeat(slack)
}

function renderTable(header: string[], rows: string[][], align: Array<"left" | "center" | "right">, width: number, palette: MarkdownPalette): string[] {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1)
  const widths = Array.from({ length: columns }, (_, index) => {
    const cells = [header[index] ?? "", ...rows.map((row) => row[index] ?? "")]
    return Math.min(Math.max(...cells.map((cell) => cell.length), 3), Math.max(Math.floor(width / columns) - 2, 6))
  })

  const separatorWidth = 3 * (columns - 1)
  const total = widths.reduce((sum, value) => sum + value, 0) + separatorWidth
  if (total > width) {
    const over = total - width
    widths[widths.length - 1] = Math.max(widths[widths.length - 1]! - over, 6)
  }

  const render = (cells: string[], paint: (text: string) => string): string =>
    cells
      .slice(0, columns)
      .map((cell, index) => paint(padCell(cell.slice(0, widths[index]!), widths[index]!, align[index] ?? "left")))
      .join(palette.dim(" \u2502 "))

  const rule = palette.dim(widths.map((value) => "\u2500".repeat(value)).join("\u2500\u253c\u2500"))
  return [render(header, palette.bold), rule, ...rows.map((row) => render(row, (text) => text))]
}

// ── Block parsing ───────────────────────────────────────────────────────────

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const CHECKBOX = /^\[( |x|X)\]\s+(.*)$/

/**
 * Renders markdown into styled terminal lines. It never produces a line wider
 * than `width` (code blocks are the one exception — code is truncated by the
 * frame rather than reflowed, because reflowing code is worse than clipping it).
 */
export function renderMarkdown(text: string, options: MarkdownOptions): string[] {
  const width = Math.max(options.width, 16)
  const palette: MarkdownPalette = { ...DEFAULT_MARKDOWN_PALETTE, ...options.palette }
  const maxCodeLines = options.maxCodeLines ?? DEFAULT_MAX_CODE_LINES
  const source = text.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  let index = 0

  const isBlockStart = (line: string): boolean =>
    FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line)

  while (index < source.length) {
    const line = source[index] ?? ""

    // Fenced code
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const lang = (fence[2] ?? "").toLowerCase()
      const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
      const body: string[] = []
      index++
      while (index < source.length) {
        const candidate = source[index] ?? ""
        index++
        if (closing.test(candidate)) break
        body.push(candidate)
      }
      out.push(...renderCode(body, lang, width, palette, maxCodeLines))
      continue
    }

    // Table
    if (line.includes("|") && isTableSeparator(source[index + 1] ?? "")) {
      const header = splitRow(line)
      const align = alignmentOf(source[index + 1] ?? "")
      index += 2
      const rows: string[][] = []
      while (index < source.length && (source[index] ?? "").includes("|") && (source[index] ?? "").trim() !== "") {
        rows.push(splitRow(source[index]!))
        index++
      }
      out.push(...renderTable(header, rows, align, width, palette))
      continue
    }

    // Heading
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1]!.length
      const prefix = level > 2 ? `${"#".repeat(level - 2)} ` : ""
      const wrapped = wrapSegments(inlineSegments(heading[2] ?? ""), Math.max(width - prefix.length, 8))
      wrapped.forEach((segments, row) => {
        // Headings are restyled wholesale, so inner runs are flattened first.
        const body = stripAnsiCodes(paintLine(segments, palette))
        out.push(palette.heading(row === 0 ? prefix + body : body))
      })
      if (level <= 2) out.push(palette.rule("\u2500".repeat(Math.min(width, 60))))
      index++
      continue
    }

    // Horizontal rule
    if (RULE.test(line) && line.trim() !== "") {
      out.push(palette.rule("\u2500".repeat(Math.min(width, 60))))
      index++
      continue
    }

    // Blockquote
    const quote = QUOTE.exec(line)
    if (quote) {
      const body: string[] = []
      while (index < source.length) {
        const candidate = QUOTE.exec(source[index] ?? "")
        if (!candidate) break
        body.push(candidate[1] ?? "")
        index++
      }
      const rendered = renderBlock(inlineSegments(body.join(" ")), width, palette, palette.quote("\u2502 "))
      out.push(...rendered)
      continue
    }

    // List item
    const list = LIST.exec(line)
    if (list) {
      const indent = (list[1] ?? "").replace(/\t/g, "  ")
      const level = Math.floor(indent.length / 2)
      const isOrdered = /\d/.test(list[2] ?? "")
      const body = list[3] ?? ""
      const checkbox = CHECKBOX.exec(body)
      const marker = checkbox
        ? checkbox[1]!.toLowerCase() === "x"
          ? "\u2611"
          : "\u2610"
        : isOrdered
          ? `${(list[2] ?? "").replace(/[.)]$/, "")}.`
          : "\u2022"
      const text = checkbox ? (checkbox[2] ?? "") : body
      const lead = "  ".repeat(level)
      const prefix = `${lead}${palette.bullet(marker)} `
      out.push(...renderBlock(inlineSegments(text), width, palette, prefix, " ".repeat(prefix.length)))
      index++
      continue
    }

    // Blank
    if (line.trim() === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("")
      index++
      continue
    }

    // Paragraph — consecutive plain lines reflow together, the way markdown says
    const paragraph: string[] = [line]
    index++
    while (index < source.length) {
      const candidate = source[index] ?? ""
      if (candidate.trim() === "" || isBlockStart(candidate)) break
      if (candidate.includes("|") && isTableSeparator(source[index + 1] ?? "")) break
      paragraph.push(candidate)
      index++
    }
    out.push(...renderBlock(inlineSegments(paragraph.join(" ")), width, palette, ""))
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  if (options.caret && out.length > 0) out[out.length - 1] = `${out[out.length - 1]}${options.caret}`
  else if (options.caret) out.push(options.caret)
  return out
}

/** Flattens styled text so it can be restyled as a whole (headings). */
function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

/**
 * Transcript rendering — turns conversation blocks into styled terminal lines.
 *
 * Pure: given the same blocks and width it always produces the same lines, so
 * the framing logic can be unit tested without a terminal.
 */
import { theme, sym } from "./theme"
import { clampVisible, padVisible, visibleWidth, wrapText } from "./text"
import { spinnerFrame } from "./animate"
import { DEFAULT_MARKDOWN_PALETTE, highlightCode, renderMarkdown } from "./markdown"
import { progressBar, progressFraction, progressPhrase } from "./progress"

export type Tone = "info" | "ok" | "warn" | "error"

export type Block =
  /** `state` marks a message that is queued ("pending") or taken back ("undone"). */
  | { kind: "user"; text: string; state?: "pending" | "undone" }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool"
      title: string
      status: "running" | "ok" | "fail"
      detail?: string
      /** Set while running, so the phrase and bar can advance with wall time. */
      startedAt?: number
      words?: readonly string[]
      estimateMs?: number
    }
  /** A preview of code the agent just wrote, so the edit is visible in the chat. */
  | { kind: "code"; text: string; lang?: string; title?: string; note?: string; maxLines?: number }
  /** Right-aligned one-liner (turn stats) — keeps the left gutter for chat. */
  | { kind: "meta"; text: string }
  | { kind: "notice"; text: string; tone?: Tone }
  | { kind: "raw"; text: string }
  | { kind: "gap" }

const TONE_COLOR: Record<Tone, (s: string) => string> = {
  info: theme.dim,
  ok: theme.ok,
  warn: theme.warn,
  error: theme.error,
}

const TONE_GLYPH: Record<Tone, string> = {
  info: sym.bullet,
  ok: sym.ok,
  warn: sym.warn,
  error: sym.fail,
}

/** Prefixes the first line and indents the rest, then clamps to `width`. */
function withPrefix(lines: string[], prefix: string, continuation: string, width: number): string[] {
  return lines.map((line, index) => clampVisible(`${index === 0 ? prefix : continuation}${line}`, width))
}

/** Options threaded through rendering (e.g. the streaming caret glyph). */
export interface RenderOptions {
  /** Caret appended to a streaming assistant message. */
  caret?: string
  /** Animation clock, so running tools can advance their phrase. */
  tick?: number
  /** Wall clock used for the same; injectable so rendering stays testable. */
  now?: number
}

/** Renders one block into styled lines no wider than `width`. */
export function renderBlock(block: Block, width: number, options: RenderOptions = {}): string[] {
  switch (block.kind) {
    case "gap":
      return [""]

    case "user": {
      const state = block.state
      const body = renderMarkdown(block.text, { width: Math.max(width - 2, 8) })
      const marker =
        state === "pending" ? theme.warn(sym.queued) : state === "undone" ? theme.dim(sym.undone) : theme.accent(sym.arrow)
      const lines = withPrefix(body, `${marker} `, "  ", width)
      if (state === "pending") return lines.map((line) => theme.muted(line))
      if (state === "undone") return lines.map((line) => theme.dim(line))
      return lines.map((line) => theme.muted(line))
    }

    case "assistant": {
      const caret = block.streaming ? (options.caret ?? "\u258c") : ""
      if (!block.text.trim() && !caret) return []
      return renderMarkdown(block.text, { width, caret: caret || undefined })
    }

    case "reasoning": {
      const wrapped = wrapText(block.text, Math.max(width - 4, 8))
      return wrapped.map((line) => clampVisible(`  ${theme.dim(line)}`, width))
    }

    case "tool": {
      const running = block.status === "running"
      const icon = running
        ? theme.warn(spinnerFrame(options.tick ?? 0))
        : block.status === "ok"
          ? theme.ok(sym.ok)
          : theme.error(sym.fail)

      const now = options.now ?? Date.now()
      const elapsed = running ? Math.max(now - (block.startedAt ?? now), 0) : 0
      const phrase =
        running && block.words && block.words.length > 0 ? progressPhrase(block.words, elapsed) : undefined

      const head = phrase
        ? `${theme.bold(block.title)} ${theme.dim("\u00b7")} ${theme.accent(phrase)}`
        : theme.bold(block.title)
      const lines = [`  ${icon} ${head}`]

      if (running && block.estimateMs) {
        const fraction = progressFraction(elapsed, block.estimateMs)
        const barWidth = Math.max(Math.min(width - 10, 28), 8)
        lines.push(`    ${theme.accent(progressBar(fraction, barWidth))} ${theme.dim(`${Math.round(fraction * 100)}%`)}`)
      }
      if (block.detail) {
        const wrapped = wrapText(block.detail, Math.max(width - 6, 8))
        for (const line of wrapped.slice(0, 4)) lines.push(`    ${theme.dim(line)}`)
      }
      return lines.map((line) => clampVisible(line, width))
    }

    case "code": {
      const label = block.title ?? block.lang ?? ""
      const head = label ? ` ${label} ` : ""
      const dashes = Math.max(width - 3 - head.length, 0)
      const lines = [theme.dim("\u256d\u2500") + theme.accent(head) + theme.dim(`${"\u2500".repeat(dashes)}\u256e`)]

      const body = block.text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")
      const maxLines = block.maxLines ?? 32
      const shown = body.slice(0, maxLines)
      for (const line of shown) {
        lines.push(`${theme.dim("\u2502 ")}${highlightCode(line, block.lang ?? "", DEFAULT_MARKDOWN_PALETTE)}`)
      }
      if (shown.length === 0) lines.push(theme.dim("\u2502"))
      if (body.length > shown.length) lines.push(theme.dim(`\u2502 \u2026 ${body.length - shown.length} more line(s)`))
      if (block.note) lines.push(theme.dim(`\u2502 ${block.note}`))
      lines.push(theme.dim(`\u2570${"\u2500".repeat(Math.max(width - 2, 0))}\u256f`))
      return lines.map((line) => clampVisible(line, width))
    }

    case "meta": {
      const text = clampVisible(block.text, Math.max(width - 2, 8))
      const pad = Math.max(width - visibleWidth(text) - 2, 0)
      return [`${" ".repeat(pad)}${theme.dim(text)}`]
    }

    case "notice": {
      const tone = block.tone ?? "info"
      const wrapped = wrapText(block.text, Math.max(width - 4, 8))
      const first = `  ${TONE_COLOR[tone](TONE_GLYPH[tone])} ${TONE_COLOR[tone](wrapped[0] ?? "")}`
      const rest = wrapped.slice(1).map((line) => `    ${TONE_COLOR[tone](line)}`)
      return [first, ...rest]
    }

    case "raw":
      // pre-formatted, possibly multi-line and already styled (command output)
      return block.text.split(/\r?\n/).map((line) => clampVisible(line, width))
  }
}

/** Flattens blocks into the full transcript line list. */
export function renderTranscript(blocks: Block[], width: number, options: RenderOptions = {}): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    const rendered = renderBlock(block, width, options)
    if (rendered.length === 0) continue
    lines.push(...rendered)
  }
  return lines
}

/** Takes the last `count` lines (the visible window of a scrollback view). */
export function tail(lines: string[], count: number): string[] {
  if (count <= 0) return []
  if (lines.length <= count) return lines
  return lines.slice(lines.length - count)
}

/**
 * The visible window of the transcript. `scroll` counts lines up from the
 * bottom, so 0 is "live" (newest at the bottom) and 20 shows the region that
 * ended twenty lines ago.
 */
export function windowSlice(lines: string[], count: number, scroll = 0): string[] {
  if (count <= 0) return []
  const maxScroll = Math.max(lines.length - count, 0)
  const offset = Math.min(Math.max(scroll, 0), maxScroll)
  const end = lines.length - offset
  const start = Math.max(end - count, 0)
  return lines.slice(start, end)
}

export interface SidebarPanel {
  /** Lines, already fitted to `width`. */
  lines: string[]
  /** Panel content width; a one-column divider is added by the frame. */
  width: number
}

export interface FrameOptions {
  width: number
  height: number
  /** Top bar (one line normally). */
  header: string[]
  /** Left panel, drawn beside transcript/overlay. */
  sidebar?: SidebarPanel
  /** Full transcript; the newest lines are shown. */
  transcript: string[]
  /** Palette / picker box, drawn just above the prompt box. */
  overlay: string[]
  /** The prompt box, borders included, each line exactly `width` wide. */
  prompt: string[]
  /** 1-based caret inside `prompt`. */
  promptCursor: { row: number; col: number }
  /** Status/hint line, below the prompt box. */
  status: string
  /** Lines scrolled up from the bottom of the transcript (0 = live). */
  scroll?: number
  /**
   * Absolute transcript line that should sit at the top of the viewport.
   * Takes precedence over `scroll`. Scrolling is driven by this index rather
   * than by a distance from the bottom, so output arriving while the user is
   * reading something earlier does not push it off the screen.
   */
  viewTop?: number
}

export interface Frame {
  /** Exactly `height` lines. */
  lines: string[]
  /** 1-based caret position, always inside the frame. */
  cursor: { row: number; col: number }
  /** 1-based row where the prompt box starts (for mouse hit-testing). */
  promptTop: number
  /** Transcript line index drawn on the first body row. */
  viewTop: number
  /** How many transcript lines are visible at once. */
  viewportRows: number
}

/**
 * Lays out one full-screen frame:
 *
 *   ┌ header ────────────────────────────────────────────────┐
 *   │ sidebar │ transcript (+ overlay at the bottom)          │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ prompt box                                              │
 *   │ status                                                  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The prompt box and status line are never dropped — on a very short terminal
 * the header and the sidebar shrink first, then the transcript, so the user can
 * always see and edit what they are typing.
 */
export function composeFrame(options: FrameOptions): Frame {
  const width = Math.max(options.width, 1)
  const height = Math.max(options.height, 1)

  let header = [...options.header]
  let overlay = [...options.overlay]

  let prompt = options.prompt.length > 0 ? [...options.prompt] : [""]
  // The prompt can never be taller than the frame minus the status line.
  if (prompt.length > height - 1) prompt = prompt.slice(-(Math.max(height - 1, 1)))

  // Drop the overlay first, then the header, so the prompt always survives.
  while (header.length + prompt.length + 1 > height && overlay.length > 0) overlay.pop()
  while (header.length + prompt.length + 1 > height && header.length > 0) header.pop()

  const bodyRows = Math.max(height - header.length - prompt.length - 1, 0)
  if (overlay.length > bodyRows) overlay = overlay.slice(0, bodyRows)

  const sidebarWidth = options.sidebar && options.sidebar.width > 0 ? options.sidebar.width : 0
  const divider = sidebarWidth > 0 ? 1 : 0
  const contentWidth = Math.max(width - sidebarWidth - divider, 1)

  const viewportRows = Math.max(bodyRows - overlay.length, 0)
  const maxTop = Math.max(options.transcript.length - viewportRows, 0)
  let viewTop: number
  let viewport: string[]
  if (options.viewTop !== undefined && viewportRows > 0) {
    viewTop = Math.min(Math.max(Math.trunc(options.viewTop), 0), maxTop)
    viewport = options.transcript.slice(viewTop, viewTop + viewportRows)
  } else {
    const offset = Math.min(Math.max(options.scroll ?? 0, 0), maxTop)
    viewTop = maxTop - offset
    viewport = windowSlice(options.transcript, viewportRows, options.scroll ?? 0)
  }

  // Slack goes above the transcript so the newest line sits just above the
  // prompt box, the way a chat log reads.
  const body: string[] = []
  for (let i = 0; i < viewportRows - viewport.length; i++) body.push("")
  body.push(...viewport)
  body.push(...overlay)

  const lines: string[] = [...header].map((line) => padVisible(clampVisible(line, width), width))
  for (let i = 0; i < bodyRows; i++) {
    const content = padVisible(clampVisible(body[i] ?? "", contentWidth), contentWidth)
    if (sidebarWidth > 0) {
      const left = padVisible(clampVisible(options.sidebar!.lines[i] ?? "", sidebarWidth), sidebarWidth)
      lines.push(padVisible(`${left}${theme.dim("\u2502")}${content}`, width))
    } else {
      lines.push(padVisible(content, width))
    }
  }

  for (const line of prompt) lines.push(padVisible(clampVisible(line, width), width))
  lines.push(padVisible(clampVisible(options.status, width), width))
  while (lines.length < height) lines.push(" ".repeat(width))

  const cursorRow = header.length + bodyRows + options.promptCursor.row
  const promptTop = header.length + bodyRows + 1
  return {
    lines: lines.slice(0, height),
    cursor: {
      row: Math.min(Math.max(cursorRow, 1), height),
      col: Math.min(Math.max(options.promptCursor.col, 1), width),
    },
    promptTop,
    viewTop,
    viewportRows,
  }
}

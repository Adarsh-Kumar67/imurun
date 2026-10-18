/**
 * The left panel: the session's vital signs at a glance — how much context is
 * left, which agent and model are active, the working directory, the approval
 * mode, open todos, and anything queued behind the current turn.
 *
 * Pure: `sidebarLines` takes a plain state object and returns lines already
 * fitted to the panel width, so the frame layout stays a simple concatenation.
 */
import { theme } from "./theme"
import { padVisible, truncateVisible } from "./text"

export interface SidebarState {
  /** Panel width in columns (content only — the frame draws the divider). */
  width: number
  model?: string
  agent: string
  session: string
  workingDir: string
  permissions: string
  /** Estimated context usage for the active session. */
  context?: { used: number; max: number }
  todos: string[]
  /** Number of messages waiting behind the current turn. */
  queue: number
  busy: boolean
}

/** Compact token count: 32768 → "32.8k". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`.replace(".0k", "k")
  return `${Math.round(value / 1000)}k`
}

/** A left-anchored usage bar plus its percentage. */
export function contextBar(used: number, max: number, width: number): { bar: string; percent: number } {
  const ratio = max > 0 ? Math.min(Math.max(used / max, 0), 1) : 0
  const cells = Math.max(width, 4)
  const filled = Math.round(ratio * cells)
  const color = ratio > 0.85 ? theme.error : ratio > 0.6 ? theme.warn : theme.ok
  return {
    bar: color("\u2588".repeat(filled)) + theme.dim("\u2591".repeat(Math.max(0, cells - filled))),
    percent: Math.round(ratio * 100),
  }
}

/** Keeps the end of a path, which is the part that identifies it. */
export function tailPath(path: string, max: number): string {
  if (path.length <= max) return path
  return `\u2026${path.slice(-(Math.max(1, max - 1)))}`
}

function title(text: string, width: number): string {
  return padVisible(` ${theme.dim(text.toUpperCase())}`, width)
}

function value(text: string, width: number): string {
  return padVisible(` ${text}`, width)
}

function blank(width: number): string {
  return " ".repeat(width)
}

/**
 * Builds every sidebar line. The frame clips to the available height, so this
 * can be generous and let the layout decide what fits.
 */
export function sidebarLines(state: SidebarState): string[] {
  const width = Math.max(state.width, 8)
  const inner = width - 2
  const lines: string[] = []

  lines.push(blank(width))

  // context window
  lines.push(title("context", width))
  if (state.context) {
    const { bar, percent } = contextBar(state.context.used, state.context.max, Math.max(inner - 6, 6))
    lines.push(value(`${bar} ${theme.dim(`${percent}%`)}`, width))
    lines.push(
      value(
        theme.dim(`${formatTokens(state.context.used)} / ${formatTokens(state.context.max)} tok`),
        width,
      ),
    )
  } else {
    lines.push(value(theme.dim("not loaded"), width))
  }
  lines.push(blank(width))

  lines.push(title("agent", width))
  lines.push(value(theme.accent(state.agent), width))
  lines.push(blank(width))

  lines.push(title("model", width))
  lines.push(value(theme.accent(state.model ?? "none"), width))
  lines.push(blank(width))

  lines.push(title("permissions", width))
  const permColor = state.permissions === "auto" ? theme.warn : state.permissions === "readonly" ? theme.ok : theme.accent
  lines.push(value(permColor(state.permissions), width))
  lines.push(blank(width))

  lines.push(title("directory", width))
  lines.push(value(theme.muted(tailPath(state.workingDir, inner)), width))
  lines.push(blank(width))

  lines.push(title("session", width))
  lines.push(value(theme.muted(state.session), width))

  if (state.todos.length > 0) {
    lines.push(blank(width))
    lines.push(title(`todos  ${state.todos.length}`, width))
    for (const todo of state.todos.slice(0, 6)) {
      lines.push(padVisible(` ${theme.warn("\u25cf")} ${theme.dim(truncateVisible(todo, inner - 3))}`, width))
    }
    if (state.todos.length > 6) lines.push(value(theme.dim(`+${state.todos.length - 6} more`), width))
  }

  if (state.queue > 0) {
    lines.push(blank(width))
    lines.push(title(`queued  ${state.queue}`, width))
    lines.push(value(theme.accent(state.busy ? "waiting for the turn" : "ready"), width))
  }

  return lines.map((line) => padVisible(line, width))
}

/** A one-line summary of the panel, used by tests and the status bar. */
export function sidebarSummary(state: SidebarState): string {
  const bits = [`agent ${state.agent}`, `model ${state.model ?? "none"}`, `perm ${state.permissions}`]
  if (state.context) bits.push(`ctx ${Math.round((state.context.used / Math.max(state.context.max, 1)) * 100)}%`)
  if (state.todos.length) bits.push(`${state.todos.length} todo(s)`)
  if (state.queue) bits.push(`${state.queue} queued`)
  return bits.join(" \u00b7 ")
}

/**
 * The side panel: the session's vital signs at a glance — how much context is
 * left, which agent and model are active, the approval mode, the working
 * directory, open todos, and anything queued behind the current turn. It is
 * drawn on the right of the chat by the frame.
 *
 * Pure: `sidebarLines` takes a plain state object and returns lines already
 * fitted to the panel width, so the frame layout stays a simple concatenation.
 */
import { theme } from "./theme"
import { padVisible, truncateVisible } from "./text"

export interface SidebarTodo {
  title: string
  status: "open" | "doing" | "done"
}

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
  /** Steps of the written plan (`.imurun/PLAN.md`), when there is one. */
  plan?: { done: number; total: number }
  /** The plan, in the order it should be shown. */
  todos: SidebarTodo[]
  /** Number of messages waiting behind the current turn. */
  queue: number
  /** Subagents running right now. */
  subagents?: number
  busy: boolean
}

const TODO_GLYPH: Record<SidebarTodo["status"], string> = { open: "\u2610", doing: "\u25d0", done: "\u2611" }

/** Checklists read top-down: work in progress, then what is left, then done. */
function orderTodos(todos: SidebarTodo[]): SidebarTodo[] {
  const rank = (todo: SidebarTodo): number => (todo.status === "done" ? 2 : todo.status === "doing" ? 0 : 1)
  return [...todos].sort((a, b) => rank(a) - rank(b))
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

  // The written plan for the project, if there is one. Just the progress here;
  // `/plan` shows the goal and the steps.
  if (state.plan) {
    lines.push(blank(width))
    lines.push(title("plan", width))
    const all = state.plan.total > 0 && state.plan.done >= state.plan.total
    const summary = `${state.plan.done}/${state.plan.total} steps`
    lines.push(value(all ? theme.ok(summary) : theme.accent(summary), width))
  }

  if (state.todos.length > 0) {
    const ordered = orderTodos(state.todos)
    const done = ordered.filter((todo) => todo.status === "done").length
    lines.push(blank(width))
    lines.push(title(`todos  ${done}/${ordered.length}`, width))
    for (const todo of ordered.slice(0, 6)) {
      const glyph =
        todo.status === "done"
          ? theme.ok(TODO_GLYPH[todo.status])
          : todo.status === "doing"
            ? theme.accent(TODO_GLYPH[todo.status])
            : theme.warn(TODO_GLYPH[todo.status])
      const text =
        todo.status === "done" ? theme.dim(truncateVisible(todo.title, inner - 3)) : truncateVisible(todo.title, inner - 3)
      lines.push(padVisible(` ${glyph} ${text}`, width))
    }
    if (ordered.length > 6) lines.push(value(theme.dim(`+${ordered.length - 6} more`), width))
  }

  if (state.subagents && state.subagents > 0) {
    lines.push(blank(width))
    lines.push(title(`subagents  ${state.subagents}`, width))
    lines.push(value(theme.accent("\u2937 working"), width))
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

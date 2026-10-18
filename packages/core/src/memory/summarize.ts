/**
 * Summarization — turns a conversation into a durable digest.
 *
 * Digests are deliberately *extractive and deterministic*: they run offline, in
 * constant time, with no model call, so a summary can be produced while the
 * user is still typing and never fails when the model is unavailable. The
 * result is what gets written to `~/.imurun/memory/sessions/<id>.md` and fed
 * back into the system prompt when old turns are compacted away.
 *
 * Anything the model would add on top is optional: the digest is already
 * complete enough to answer "what did we do here, and what is still open?".
 */
import type { Message } from "@imurun/schema"

export type DigestKind = "session_summary"

export interface SessionDigest {
  sessionId: string
  title: string
  workingDir: string
  model?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Paths touched through the file tools (deduped, capped). */
  files: string[]
  /** Commands executed through the shell tool (newest last, capped). */
  commands: string[]
  /** Unfinished work, carried forward until the user closes it. */
  todos: string[]
  /** Work that was explicitly completed. */
  done: string[]
  /** Notable assistant statements, one line each. */
  highlights: string[]
  /** Last message id covered by this digest (compaction watermark). */
  upToMessageId?: string
  generatedAt: number
}

const MAX_FILES = 40
const MAX_COMMANDS = 20
const MAX_TODOS = 20
const MAX_DONE = 20
const MAX_HIGHLIGHTS = 12
const MAX_ITEM = 200

/**
 * `- [ ] fix the parser`, `TODO: wire the API`, `Next step: write tests`.
 *
 * The bracketed checkbox form stands on its own; the word forms require either
 * a colon or a `TODO`-style keyword, so ordinary prose that happens to start
 * with "Next …" is never mistaken for a task.
 */
const OPEN_TODO_PATTERNS: RegExp[] = [
  /^\s*[-*+]\s*\[ \]\s*(.+)$/i,
  /^\s*(?:TODO|FIXME|XXX)\s*:?\s+(.+)$/i,
  /^\s*(?:Next(?:\s+step)?|Remaining|Follow-?up|Still\s+to\s+do)\s*:\s*(.+)$/i,
]

/** `- [x] done thing`, `DONE: thing` — the word form must carry a colon. */
const DONE_PATTERNS: RegExp[] = [
  /^\s*[-*+]\s*\[[xX]\]\s*(.+)$/,
  /^\s*(?:DONE|COMPLETED|FINISHED)\s*:\s*(.+)$/i,
]

function clamp(text: string, max = MAX_ITEM): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}\u2026`
}

function uniquePush(target: string[], value: string, max: number): void {
  const cleaned = clamp(value)
  if (!cleaned) return
  if (target.includes(cleaned)) return
  target.push(cleaned)
  while (target.length > max) target.shift()
}

/** Flattens any message content shape into plain text. */
export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "file") return `[file: ${part.path}]`
      return "[image]"
    })
    .join("\n")
}

/** Pulls unfinished todos out of free text. */
export function extractTodos(text: string): string[] {
  const found: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    for (const pattern of OPEN_TODO_PATTERNS) {
      const match = pattern.exec(raw)
      if (match?.[1]) {
        const todo = clamp(match[1])
        if (todo && !found.includes(todo)) found.push(todo)
        break
      }
    }
  }
  return found
}

/** Pulls explicitly-finished work out of free text. */
export function extractDone(text: string): string[] {
  const found: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    for (const pattern of DONE_PATTERNS) {
      const match = pattern.exec(raw)
      if (match?.[1]) {
        const done = clamp(match[1])
        if (done && !found.includes(done)) found.push(done)
        break
      }
    }
  }
  return found
}

/** Renders a digest as markdown — the human- and RAG-readable form on disk. */
export function digestToMarkdown(digest: SessionDigest): string {
  const lines: string[] = []
  lines.push(`# ${digest.title}`)
  lines.push("")
  lines.push(`- session: \`${digest.sessionId}\``)
  lines.push(`- project: \`${digest.workingDir}\``)
  if (digest.model) lines.push(`- model: \`${digest.model}\``)
  lines.push(`- messages: ${digest.messageCount}`)
  lines.push(`- updated: ${new Date(digest.updatedAt).toISOString()}`)
  lines.push("")

  if (digest.todos.length > 0) {
    lines.push("## Open todos")
    for (const todo of digest.todos) lines.push(`- [ ] ${todo}`)
    lines.push("")
  }
  if (digest.done.length > 0) {
    lines.push("## Completed")
    for (const done of digest.done) lines.push(`- [x] ${done}`)
    lines.push("")
  }
  if (digest.files.length > 0) {
    lines.push("## Files touched")
    for (const file of digest.files) lines.push(`- \`${file}\``)
    lines.push("")
  }
  if (digest.commands.length > 0) {
    lines.push("## Commands")
    for (const command of digest.commands) lines.push(`- \`${command}\``)
    lines.push("")
  }
  if (digest.highlights.length > 0) {
    lines.push("## Highlights")
    for (const highlight of digest.highlights) lines.push(`- ${highlight}`)
    lines.push("")
  }
  return lines.join("\n")
}

/** Compact rendering injected into the system prompt after compaction. */
export function digestToPrompt(digest: SessionDigest): string {
  const lines: string[] = [`Session "${digest.title}" (${digest.messageCount} messages).`]
  if (digest.done.length > 0) lines.push(`Completed: ${digest.done.slice(-6).join("; ")}.`)
  if (digest.todos.length > 0) lines.push(`Open todos: ${digest.todos.slice(0, 8).join("; ")}.`)
  if (digest.files.length > 0) lines.push(`Files touched: ${digest.files.slice(-12).join(", ")}.`)
  if (digest.commands.length > 0) lines.push(`Recent commands: ${digest.commands.slice(-5).join(" | ")}.`)
  if (digest.highlights.length > 0) {
    lines.push("Earlier in this session:")
    for (const highlight of digest.highlights.slice(-8)) lines.push(`- ${highlight}`)
  }
  return lines.join("\n")
}

export interface BuildDigestInput {
  sessionId: string
  title: string
  workingDir: string
  model?: string
  createdAt?: number
  updatedAt?: number
  messages: Message[]
  /** Digest from the previous pass; its open todos carry forward. */
  previous?: SessionDigest
}

/**
 * Builds a digest covering `messages`. Open todos from `previous` are carried
 * forward unless the new messages mark them done, so nothing silently falls
 * off the list between passes.
 */
export function buildDigest(input: BuildDigestInput): SessionDigest {
  const files: string[] = []
  const commands: string[] = []
  const highlights: string[] = []
  const todos: string[] = []
  const done: string[] = []

  for (const message of input.messages) {
    const text = messageText(message)

    if (message.role === "user" && text.trim()) {
      for (const todo of extractTodos(text)) uniquePush(todos, todo, MAX_TODOS)
      for (const item of extractDone(text)) uniquePush(done, item, MAX_DONE)
    }

    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>
        for (const key of ["path", "file", "filePath", "dir"]) {
          if (typeof args[key] === "string") uniquePush(files, args[key], MAX_FILES)
        }
        if (call.name === "shell" && typeof args.command === "string") {
          uniquePush(commands, args.command, MAX_COMMANDS)
        }
      }
      const first = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (first && !first.startsWith("{") && !first.startsWith("- [")) uniquePush(highlights, first, MAX_HIGHLIGHTS)
      for (const todo of extractTodos(text)) uniquePush(todos, todo, MAX_TODOS)
      for (const item of extractDone(text)) uniquePush(done, item, MAX_DONE)
    }
  }

  // carry forward unresolved todos from the previous digest
  for (const todo of input.previous?.todos ?? []) {
    if (done.some((item) => item === todo)) continue
    uniquePush(todos, todo, MAX_TODOS)
  }
  for (const item of input.previous?.done ?? []) uniquePush(done, item, MAX_DONE)

  const last = input.messages[input.messages.length - 1]
  const first = input.messages[0]

  return {
    sessionId: input.sessionId,
    title: input.title,
    workingDir: input.workingDir,
    model: input.model,
    createdAt: input.createdAt ?? first?.createdAt ?? Date.now(),
    updatedAt: input.updatedAt ?? last?.createdAt ?? Date.now(),
    messageCount: input.messages.length,
    files,
    commands,
    todos,
    done,
    highlights,
    upToMessageId: last?.id,
    generatedAt: Date.now(),
  }
}

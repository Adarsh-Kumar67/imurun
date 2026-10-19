/**
 * Context assembly — converts stored IMURUN messages into model messages, with
 * a character-budget trim that drops the oldest exchanges.
 *
 * Dropped history is *not* discarded blindly: `planCompaction` reports exactly
 * which messages fell outside the budget so the agent can fold them into a
 * memory digest and keep them in the system prompt as a summary.
 */
import type { ContentPart, Message } from "@imurun/schema"
import type { ImagePart, ModelMessage, TextPart, ToolCallPart, ToolResultPart } from "ai"

export interface AssembleOptions {
  /** Approximate character budget for history. */
  maxChars?: number
  /** Always keep at least this many recent messages. */
  minMessages?: number
  /** Maximum messages to consider. */
  maxMessages?: number
  /** A single message is truncated to this many characters. */
  maxMessageChars?: number
}

export interface CompactionPlan {
  /** Messages that stay verbatim, oldest first. */
  kept: Message[]
  /** Messages that fell outside the budget, oldest first. */
  dropped: Message[]
  /** Id of the newest dropped message — the compaction watermark. */
  upToMessageId?: string
  /** Dropped character count, for reporting. */
  droppedChars: number
}

/**
 * Characters per token, deliberately under-estimated. Real local models average
 * closer to 3.5 for English and code, so assuming 2.6 leaves headroom for the
 * chat template, the system prompt and tokenizer differences.
 */
export const CHARS_PER_TOKEN = 2.6
/** Share of the window held back for the model's own answer. */
export const OUTPUT_RESERVE_RATIO = 0.2
/** Never reserve less than this many tokens for the answer. */
export const MIN_OUTPUT_RESERVE_TOKENS = 512
/** Used when the runtime could not tell us the real window. */
export const DEFAULT_CONTEXT_WINDOW = 8192
/** Hard cap on one message, so a single blob cannot swallow the window. */
export const MAX_MESSAGE_CHARS = 24_000

const DEFAULT_MIN_MESSAGES = 2
const DEFAULT_MAX_MESSAGES = 80

/**
 * Character budget for history, given the model's window and the number of
 * characters already spent on things that must be sent (system prompt).
 */
export function planHistoryChars(windowTokens: number, fixedChars = 0): number {
  const total = Math.max(windowTokens, 1024) * CHARS_PER_TOKEN
  const reserve = Math.max(total * OUTPUT_RESERVE_RATIO, MIN_OUTPUT_RESERVE_TOKENS * CHARS_PER_TOKEN)
  return Math.max(Math.floor(total - reserve - fixedChars), 1_500)
}

/** Keeps the head and the tail — instructions tend to live at both ends. */
export function truncateForContext(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = Math.max(max - head, 0)
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n\u2026 [${omitted} characters omitted to fit the context window] \u2026\n${text.slice(text.length - tail)}`
}

function userParts(content: string | ContentPart[]): string | Array<TextPart | ImagePart> {
  if (typeof content === "string") return content
  const parts: Array<TextPart | ImagePart> = []
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text })
    } else if (part.type === "image") {
      parts.push({ type: "image", image: part.data, mediaType: part.mime })
    } else {
      parts.push({ type: "text", text: `[file: ${part.path}]` })
    }
  }
  return parts
}

/**
 * Largest string kept verbatim inside a tool call's arguments when the call is
 * replayed to the model. A `write` call carries the entire file; replaying that
 * on every later turn is what fills a small context window. The model can
 * always `read` the file again if it needs the bytes — what it needs to keep is
 * *that* it wrote it, and where.
 */
export const TOOL_ARG_STRING_LIMIT = 400

/** Shrinks long strings inside tool-call arguments, preserving their shape. */
export function compactArgsForModel(value: unknown, limit = TOOL_ARG_STRING_LIMIT, depth = 0): unknown {
  if (typeof value === "string") {
    if (value.length <= limit) return value
    return `${value.slice(0, limit)}\u2026 [${value.length - limit} more characters not replayed]`
  }
  if (Array.isArray(value)) {
    if (depth > 4) return "\u2026"
    return value.slice(0, 50).map((item) => compactArgsForModel(item, limit, depth + 1))
  }
  if (value && typeof value === "object") {
    if (depth > 4) return "\u2026"
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = compactArgsForModel(item, limit, depth + 1)
    }
    return out
  }
  return value
}

function assistantParts(message: Message): Array<TextPart | ToolCallPart> {
  const parts: Array<TextPart | ToolCallPart> = []
  if (typeof message.content === "string") {
    if (message.content) parts.push({ type: "text", text: message.content })
  } else {
    for (const part of message.content) {
      if (part.type === "text") parts.push({ type: "text", text: part.text })
      else if (part.type === "file") parts.push({ type: "text", text: `[file: ${part.path}]` })
    }
  }
  for (const call of message.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: compactArgsForModel(call.args),
    })
  }
  return parts
}

function toolArgsSize(message: Message): number {
  let size = 0
  for (const call of message.toolCalls ?? []) {
    try {
      size += JSON.stringify(compactArgsForModel(call.args ?? {})).length + 48
    } catch {
      size += 256
    }
  }
  return size
}

function sizeOf(message: Message): number {
  let size = 0
  if (typeof message.content === "string") size += message.content.length
  else {
    size += message.content.reduce((sum, p) => {
      if (p.type === "text") return sum + p.text.length
      if (p.type === "image") return sum + 4096 // rough image cost
      return sum + 64
    }, 0)
  }
  // Tool arguments are replayed to the model too — a `write` call carries the
  // whole file, and forgetting to count it is how a request silently ends up
  // over the window.
  return size + toolArgsSize(message)
}

function truncateParts(
  parts: Array<TextPart | ImagePart>,
  max: number,
): Array<TextPart | ImagePart> {
  return parts.map((part) =>
    part.type === "text" ? { type: "text" as const, text: truncateForContext(part.text, max) } : part,
  )
}

/** Converts one stored message to a model message (or undefined for system). */
export function toModelMessage(message: Message, options: { maxMessageChars?: number } = {}): ModelMessage | undefined {
  const max = options.maxMessageChars ?? MAX_MESSAGE_CHARS
  switch (message.role) {
    case "system":
      return undefined // system prompt is passed separately
    case "user": {
      if (typeof message.content === "string") {
        return { role: "user", content: truncateForContext(message.content, max) }
      }
      return { role: "user", content: truncateParts(userParts(message.content) as Array<TextPart | ImagePart>, max) }
    }
    case "assistant": {
      const parts = assistantParts(message).map((part) =>
        part.type === "text" ? { type: "text" as const, text: truncateForContext(part.text, max) } : part,
      )
      if (parts.length === 0) return undefined
      return { role: "assistant", content: parts }
    }
    case "tool": {
      // A tool result can carry images (a screenshot, a PNG read). Those become
      // a content result; plain text stays a text result, which every
      // OpenAI-compatible endpoint accepts.
      if (typeof message.content !== "string") {
        const value = message.content.map((part) =>
          part.type === "image"
            ? ({
                type: "file" as const,
                data: { type: "data" as const, data: part.data },
                mediaType: part.mime,
              })
            : ({
                type: "text" as const,
                text: truncateForContext(part.type === "text" ? part.text : `[file: ${part.path}]`, max),
              }),
        )
        // A single text part stays a plain text result — the shape every
        // OpenAI-compatible endpoint has always accepted.
        const only = value.length === 1 ? value[0] : undefined
        const part: ToolResultPart = {
          type: "tool-result",
          toolCallId: message.toolCallId ?? "unknown",
          toolName: message.metadata?.toolName ?? "unknown",
          output:
            only && only.type === "text"
              ? { type: "text", value: only.text }
              : { type: "content", value },
        }
        return { role: "tool", content: [part] }
      }

      const text = message.content
      const part: ToolResultPart = {
        type: "tool-result",
        toolCallId: message.toolCallId ?? "unknown",
        toolName: message.metadata?.toolName ?? "unknown",
        output: { type: "text", value: truncateForContext(text, max) },
      }
      return { role: "tool", content: [part] }
    }
  }
}

/**
 * Decides how much history fits the budget. Newest messages win; the oldest
 * are returned as `dropped` so they can be summarized into memory instead of
 * being silently lost.
 */
export function planCompaction(messages: Message[], options: AssembleOptions = {}): CompactionPlan {
  const {
    maxChars = planHistoryChars(DEFAULT_CONTEXT_WINDOW),
    minMessages = DEFAULT_MIN_MESSAGES,
    maxMessages = DEFAULT_MAX_MESSAGES,
  } = options

  const candidates = messages.slice(-maxMessages)
  const selected: Message[] = []
  let chars = 0

  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i]!
    const size = sizeOf(message)
    const withinBudget = chars + size <= maxChars
    const isMinimum = candidates.length - i <= minMessages
    if (!withinBudget && !isMinimum) break
    selected.unshift(message)
    chars += size
  }

  const keptIds = new Set(selected.map((message) => message.id))
  // Everything outside the window is "dropped" — including messages skipped
  // entirely by maxMessages — so callers can summarize all of it.
  const dropped = messages.filter((message) => !keptIds.has(message.id))
  const droppedChars = dropped.reduce((sum, message) => sum + sizeOf(message), 0)

  return {
    kept: selected,
    dropped,
    upToMessageId: dropped[dropped.length - 1]?.id,
    droppedChars,
  }
}

/**
 * Assembles model messages from stored history, newest-first trimming until
 * the character budget is satisfied.
 */
export function assembleModelMessages(messages: Message[], options: AssembleOptions = {}): ModelMessage[] {
  const { kept } = planCompaction(messages, options)
  const maxMessageChars = options.maxMessageChars ?? MAX_MESSAGE_CHARS

  // drop a leading orphaned tool message (its assistant call was trimmed)
  const result: ModelMessage[] = []
  for (const message of kept) {
    if (result.length === 0 && message.role === "tool") continue
    const converted = toModelMessage(message, { maxMessageChars })
    if (converted) result.push(converted)
  }
  return result
}

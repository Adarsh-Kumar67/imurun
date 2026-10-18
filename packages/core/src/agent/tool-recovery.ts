/**
 * Tool-call recovery for local models.
 *
 * Small/quantized models frequently *nearly* emit a tool call: they produce
 * the right JSON (`{"name": "write", "arguments": {...}}`) but omit the
 * `<tool_call>` wrapper their chat template asked for, so llama.cpp surfaces it
 * as plain text instead of a structured tool call. Rather than silently doing
 * nothing, IMURUN recognises those near-misses and runs the intended tool.
 *
 * Recovery is deliberately conservative: a candidate is accepted only when it
 * names a tool that is actually registered, so ordinary JSON answers (or prose
 * that merely starts with a brace) are never mistaken for tool calls.
 */
import { randomUUID } from "node:crypto"

export interface RecoveredToolCall {
  id: string
  name: string
  input: unknown
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Pulls every balanced `{…}` / `[…]` region out of arbitrary text, ignoring
 * braces that sit inside strings. Lets a payload be found even when the model
 * flanks it with a sentence ("Sure, writing that now: {…}") or trails prose
 * after it.
 */
export function findJsonRegions(text: string): string[] {
  const regions: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      if (depth > 0) inString = true
      continue
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === "}" || ch === "]") {
      if (depth === 0) continue
      depth--
      if (depth === 0 && start >= 0) {
        regions.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return regions
}

/** Extracts the JSON payloads a model emitted, from tags or the raw text. */
function extractCandidates(text: string): unknown[] {
  const tagged: unknown[] = []
  const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(text)) !== null) {
    const parsed = tryParseJson(match[1]!)
    if (parsed !== undefined) tagged.push(parsed)
  }
  if (tagged.length > 0) return tagged

  // A payload embedded in prose — the common "sentence, then JSON" shape.
  const embedded: unknown[] = []
  for (const region of findJsonRegions(text)) {
    const parsed = tryParseJson(region)
    if (parsed === undefined) continue
    if (Array.isArray(parsed)) embedded.push(...parsed)
    else embedded.push(parsed)
  }
  if (embedded.length > 0) return embedded

  const trimmed = text.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) candidates.unshift(fence[1]!)

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate)
    if (parsed === undefined) continue
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  return []
}

function normaliseArguments(args: unknown): unknown {
  if (typeof args !== "string") return args ?? {}
  const parsed = tryParseJson(args)
  return parsed ?? {}
}

/**
 * Recovers tool calls from assistant text. `isKnown` decides which tool names
 * are registered and safe to accept.
 */
export function recoverTextToolCalls(text: string, isKnown: (name: string) => boolean): RecoveredToolCall[] {
  const calls: RecoveredToolCall[] = []
  for (const candidate of extractCandidates(text)) {
    if (typeof candidate !== "object" || candidate === null) continue
    const record = candidate as Record<string, unknown>

    let name: unknown = record.name ?? record.tool ?? record.tool_name
    let args: unknown = record.arguments ?? record.parameters ?? record.args ?? record.input

    const fn = record.function
    if (fn && typeof fn === "object") {
      const nested = fn as Record<string, unknown>
      name = nested.name ?? name
      args = nested.arguments ?? args
    }

    if (typeof name !== "string" || !isKnown(name)) continue
    calls.push({ id: `rec_${randomUUID()}`, name, input: normaliseArguments(args) })
  }
  return calls
}

// ── Live stream guard ────────────────────────────────────────────────────────
//
// Text is shown to the user as it arrives, and the one thing that must never
// reach the screen is the JSON payload of a tool call: the model is *asking* for
// something, not *saying* something. The guard below finds the earliest index
// where such a payload could begin; everything from there is held back until the
// step ends and the payload can be classified as a real call or ordinary text.

/** A fence only guards when it *opens* a block whose body is a JSON object/array. */
function fenceOpensPayload(text: string, index: number): boolean {
  if ((text.slice(0, index).match(/```/g) ?? []).length % 2 !== 0) return false
  const body = text.slice(index + 3).replace(/^[a-zA-Z0-9_+-]*[ \t]*\r?\n?/, "")
  return /^\s*[{[]/.test(body)
}

/** True when the tail at `index` is a marker split across two stream deltas. */
function isSplitMarkerTail(text: string, index: number, marker: string): boolean {
  const tail = text.slice(index)
  return tail.length < marker.length && marker.startsWith(tail)
}

/**
 * A partial fence counts only when it would *open* one — the closing backticks
 * of a finished block must not start a hold.
 */
function isSplitFenceTail(text: string, index: number): boolean {
  const tail = text.slice(index)
  if (tail.length >= 3 || !"```".startsWith(tail)) return false
  return ((text.slice(0, index).match(/```/g) ?? []).length % 2) === 0
}

/**
 * The earliest index at or after `from` where the text may begin a tool-call
 * payload. Everything before it is safe to display; everything from it must be
 * held. Returns `text.length` when nothing looks like a tool call.
 *
 * The rules fire on a marker's *first* character, so a prefix that has already
 * been scanned clear can never become a guard later — callers can resume from
 * the index they were given instead of rescanning the whole message.
 */
export function toolCallGuardIndex(text: string, from = 0): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "<") {
      if (text.startsWith("<tool_call", i) || isSplitMarkerTail(text, i, "<tool_call")) return i
      continue
    }
    if (ch === "`") {
      if (text.startsWith("```", i)) {
        if (fenceOpensPayload(text, i)) return i
      } else if (isSplitFenceTail(text, i)) {
        return i
      }
      continue
    }
    if (ch === "{") {
      const rest = text.slice(i + 1)
      // `{"key"…` is a JSON object; a trailing `{` is still being streamed.
      if (/^\s*"/.test(rest) || /^\s*$/.test(rest)) return i
    }
  }
  return text.length
}

/**
 * Walks back from a guard index over the wrapper the payload sits in, so a call
 * written inside a ```json fence is retracted together with its fence and only
 * the surrounding prose is left on screen.
 */
export function retractStartFor(text: string, guard: number): number {
  const before = text.slice(0, guard)
  const fences = (before.match(/```/g) ?? []).length
  if (fences % 2 === 1) {
    const opener = before.lastIndexOf("```")
    if (opener >= 0) return opener
  }
  const tag = /<tool_call[^>]*>[ \t\r\n]*$/.exec(before)
  if (tag) return tag.index
  return guard
}

/**
 * True when the text holds a JSON object shaped like a tool call — a name-ish
 * key plus an arguments-ish key. Used to tell "the model tried to call a tool
 * that does not exist" apart from "the model answered with some JSON".
 */
export function isToolCallAttempt(text: string): boolean {
  if (/<tool_call[\s>]/i.test(text)) return true
  for (const region of findJsonRegions(text)) {
    const parsed = tryParseJson(region)
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof record !== "object" || record === null) continue
      const obj = record as Record<string, unknown>
      const fn = obj.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : undefined
      const name = obj.name ?? obj.tool ?? obj.tool_name ?? fn?.name
      const args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? fn?.arguments
      if (typeof name === "string" && args !== undefined) return true
    }
  }
  return false
}

/**
 * True when the text looks like the *start* of a tool-call payload that never
 * finished — a stream cut off mid-call, not an answer. Such text is never shown.
 */
export function isPendingToolCall(text: string): boolean {
  let body = text.trim()
  if (!body) return false
  if (body.startsWith("<")) {
    if ("<tool_call".startsWith(body)) return true
    if (body.startsWith("<tool_call")) return !/<\/tool_call>/i.test(body)
    return false
  }
  if (body.startsWith("```")) {
    if ((body.match(/```/g) ?? []).length >= 2) return false // closed: not pending
    body = body.replace(/^```[a-zA-Z0-9_+-]*[ \t]*\r?\n?/, "")
  }
  if (!/^(\{\s*"|\[\s*[{["])/.test(body)) return false
  return findJsonRegions(body).length === 0
}

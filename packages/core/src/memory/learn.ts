/**
 * Learning from what the user says.
 *
 * The memory tool lets the model *choose* to store something, but the user's
 * standing instructions arrive as ordinary sentences: "always use tabs in this
 * repo", "never touch the generated folder", "my name is Shubham", "remember
 * that deploys run on Fridays". Waiting for the model to notice and call the
 * tool means those are lost whenever it does not.
 *
 * So they are picked up here, with a handful of tight patterns that are sure
 * enough to be worth keeping. This is deliberately conservative: a sentence is
 * only learned when it reads as a rule or a personal fact, never when it is
 * merely a request about the current task ("always run the tests" is a rule;
 * "run the tests" is not).
 *
 * Nothing here calls a model and nothing leaves the machine: it is a few regular
 * expressions over the user's own message.
 */
import { logger } from "@imurun/util"
import type { MemoryKind } from "./store"
import type { MemoryStore } from "./store"

export interface LearnedNote {
  kind: MemoryKind
  text: string
}

/** Longest message worth scanning; anything bigger is a pasted document. */
const MAX_SCAN_CHARS = 4_000

/** Sentences are the unit: a rule is a clause, not a paragraph. */
const MAX_NOTE_CHARS = 240

/** Rules about *how* to work. These are style, so `learnStyle` governs them. */
const STYLE_PATTERNS: RegExp[] = [
  /\b(?:always|never)\s+([^.!?\n]{4,200})/i,
  /\b(?:i|we)\s+(?:prefer|like|want)\s+([^.!?\n]{4,200})/i,
  /\b(?:please\s+)?(?:use|prefer)\s+([^.!?\n]{4,120}?)\s+instead of\s+([^.!?\n]{2,80})/i,
  /\bdon'?t\s+(?:ever\s+)?([^.!?\n]{4,200})/i,
  /\bin this (?:repo|project|codebase)\s*,?\s*(?:we|i)\s+([^.!?\n]{4,200})/i,
]

/** Standing personal facts. These are not style, so `learnStyle` does not gate them. */
const FACT_PATTERNS: RegExp[] = [
  /\bmy name is\s+([^.!?\n]{2,80})/i,
  /\b(?:call me|i go by)\s+([^.!?\n]{2,40})/i,
  /\bi(?:'m| am)\s+(?:a|an)\s+([^.!?\n]{2,80})/i,
  /\bi work (?:at|on|for)\s+([^.!?\n]{2,120})/i,
  /\bi(?:'m| am) (?:based|located) in\s+([^.!?\n]{2,80})/i,
  /\bmy (?:email|timezone|time zone|github|username) is\s+([^.!?\n]{2,80})/i,
]

/** Sentences the user explicitly asked to be remembered. */
const EXPLICIT = /\b(?:remember|note|keep in mind|don'?t forget)\s+(?:that\s+)?([^.!?\n]{4,240})/i

/** An explicit "remember …" outranks the pattern above it. */
const CREDENTIAL = /\b(?:my|the)\s+([a-z0-9 _-]{2,40}?)\s+(?:token|key|password|secret|passphrase)\s+is\s+(\S{4,200})/i

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[,\s]+$/, "")
    .trim()
    .slice(0, MAX_NOTE_CHARS)
}

/** True when the matched fragment is too generic to be worth keeping. */
function isUseful(fragment: string): boolean {
  // Judge what follows the directive: "always be careful" is the same empty
  // promise as "be careful".
  const body = fragment.replace(/^(?:always|never|please|i (?:prefer|like|want)|use|prefer)\s+/i, "").trim()
  const words = body.split(/\s+/).filter(Boolean)
  if (words.length < 2) return false
  return !/^(?:do it|be (?:careful|nice|good|quick)|run|test|try|check)$/i.test(body)
}

/**
 * Finds the durable notes in one user message. Returns [] for the ordinary
 * "do this now" messages that make up most of a session.
 */
export function detectDurableNotes(message: string): LearnedNote[] {
  if (!message || message.length > MAX_SCAN_CHARS) return []
  const found: LearnedNote[] = []
  const seen = new Set<string>()

  const add = (kind: MemoryKind, text: string): void => {
    const clean = tidy(text)
    if (!clean || !isUseful(clean)) return
    const key = `${kind}:${clean.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ kind, text: clean })
  }

  const credential = CREDENTIAL.exec(message)
  if (credential) add("credential", `${tidy(credential[1]!)} is ${credential[2]!}`)

  for (const pattern of FACT_PATTERNS) {
    const match = pattern.exec(message)
    if (match?.[1]) add("fact", match[0]!.trim())
  }

  // The style patterns overlap on purpose ("always use tabs" is also "use tabs
  // instead of spaces"), so only the first one that fires is kept: one clear
  // note beats two that say the same thing.
  const style = STYLE_PATTERNS.map((pattern) => pattern.exec(message)).find((match) => match?.[0])
  if (style?.[0]) add("user_style", style[0].trim())

  const explicit = EXPLICIT.exec(message)
  if (explicit) add("fact", explicit[1]!)

  return found
}

export interface LearnOptions {
  /** Whether style rules are learned; personal facts are learned regardless. */
  learnStyle: boolean
  projectPath?: string
  sessionId?: string
}

/**
 * Stores whatever the message makes durable. Returns one line per note actually
 * written, so the caller can tell the user what it just remembered.
 */
export async function learnFromMessage(
  store: MemoryStore,
  message: string,
  options: LearnOptions,
): Promise<string[]> {
  const candidates = detectDurableNotes(message)
  if (candidates.length === 0) return []

  const saved: string[] = []
  for (const note of candidates) {
    if (note.kind === "user_style" && !options.learnStyle) continue
    try {
      // Secrets are tagged so they are easy to find and never injected.
      const tags = note.kind === "credential" ? ["secret"] : note.kind === "user_style" ? ["style"] : ["personal"]
      await store.remember({
        text: note.kind === "credential" ? note.text : humanise(note),
        kind: note.kind,
        tags,
        projectPath: options.projectPath,
        sessionId: options.sessionId,
      })
      saved.push(note.text)
    } catch (error) {
      logger.debug(`learn skipped a note: ${(error as Error).message}`)
    }
  }
  return saved
}

/** Reads better as a stored note ("always use tabs" -> "Always use tabs"). */
function humanise(note: LearnedNote): string {
  const text = note.text.charAt(0).toUpperCase() + note.text.slice(1)
  return text.endsWith(".") ? text : `${text}.`
}

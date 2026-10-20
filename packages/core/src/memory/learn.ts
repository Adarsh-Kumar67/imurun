/**
 * Learning from what the user says.
 *
 * The memory tool lets the model *choose* to store something, but the user's
 * standing instructions arrive as ordinary sentences: "always use tabs in this
 * repo", "never touch the generated folder", "my name is Shubham", "remember
 * that deploys run on Fridays". Waiting for the model to notice and call the
 * tool means those are lost whenever it does not.
 *
 * The decision of what counts is made by `note-engine`, a small learned
 * classifier over the sentence. This file is the wiring: it applies the
 * `learnStyle` policy, writes through the memory store, and returns one line
 * per note so the UI can say what it remembered.
 */
import type { MemoryStore } from "./store"
import { rememberMessage } from "./note-engine"

export { detectDurableNotes } from "./note-engine"
export type { LearnedNote } from "./note-engine"

export interface LearnOptions {
  /** Whether style rules are learned; personal facts are learned regardless. */
  learnStyle: boolean
  projectPath?: string
  sessionId?: string
  /** Override the classifier's state file (tests, or a shared home). */
  modelPath?: string
}

/**
 * Stores whatever the message makes durable. Returns one line per note actually
 * written or merged, so the caller can tell the user what it just remembered.
 */
export async function learnFromMessage(
  store: MemoryStore,
  message: string,
  options: LearnOptions,
): Promise<string[]> {
  const { saved, merged } = await rememberMessage(store, message, {
    learnStyle: options.learnStyle,
    projectPath: options.projectPath,
    sessionId: options.sessionId,
    modelPath: options.modelPath,
  })
  const lines = new Set<string>()
  for (const text of [...saved, ...merged]) lines.add(text)
  return [...lines]
}

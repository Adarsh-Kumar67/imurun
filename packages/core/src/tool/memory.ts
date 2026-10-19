/**
 * memory tool — lets the model save and recall durable facts.
 *
 * Everything is written to `~/.imurun/memory/` so it survives sessions, is
 * readable by a human, and is retrievable offline (and by RAG later).
 */
import { NOTE_KINDS } from "@imurun/schema"
import { MemoryStore, type MemoryKind } from "../memory/store"
import { formatHits } from "../memory/store"
import { asArgs, fail, ok, optionalString, requireString } from "./types"
import type { ImurunTool } from "./types"

const VALID_KINDS: MemoryKind[] = [...NOTE_KINDS]

let store: MemoryStore | undefined
function memoryStore(): MemoryStore {
  store ??= new MemoryStore()
  return store
}

export const memoryTool: ImurunTool = {
  name: "memory",
  description:
    "Save and recall durable information across sessions: user preferences, project facts, " +
    "decisions, open todos, and personal details the user wants remembered. Use action=remember when " +
    "the user says to remember something or when you learn a lasting thing; action=recall to look " +
    "something up before asking the user again; action=todos to list unfinished work; action=forget to " +
    "delete a stale note. A kind=credential note is encrypted on disk and is never put into the prompt " +
    "on its own — recall it when you actually need it.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["remember", "recall", "forget", "todos"],
        description: "What to do.",
      },
      text: {
        type: "string",
        description: "For action=remember: the note to save, written as one self-contained sentence.",
      },
      kind: {
        type: "string",
        enum: VALID_KINDS,
        description:
          "For action=remember: fact, preference, user_style, credential, todo, or note (default note).",
      },
      tags: {
        type: "string",
        description: "For action=remember: comma-separated tags.",
      },
      query: {
        type: "string",
        description: "For action=recall: what to search for.",
      },
      ref: {
        type: "string",
        description: "For action=forget: a note id or a text fragment to remove.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  title(args) {
    const action = typeof args.action === "string" ? args.action : "memory"
    const text = typeof args.text === "string" ? args.text : typeof args.query === "string" ? args.query : ""
    return text ? `${action}: ${text.slice(0, 60)}` : action
  },
  async execute(rawArgs, ctx) {
    try {
      const args = asArgs(rawArgs)
      const action = requireString(args, "action")
      const mem = memoryStore()

      switch (action) {
        case "remember": {
          const text = requireString(args, "text")
          const kind = (optionalString(args, "kind") ?? "note") as MemoryKind
          if (!VALID_KINDS.includes(kind)) {
            return fail(`Invalid kind "${kind}". Use one of: ${VALID_KINDS.join(", ")}.`)
          }
          const tags = (optionalString(args, "tags") ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
          const note = await mem.remember({
            text,
            kind,
            tags,
            projectPath: ctx.workingDir,
            sessionId: ctx.sessionId,
          })
          const sealed = note.kind === "credential" ? " (encrypted on disk)" : ""
          return ok(`Remembered (${note.kind})${sealed}: ${note.text}`)
        }

        case "recall": {
          const query = optionalString(args, "query")
          const hits = await mem.search(query ?? "", {
            limit: 8,
            projectPath: ctx.workingDir,
          })
          if (hits.length === 0) return ok("Nothing relevant in memory.")
          return ok(hits.map((hit) => formatHits([hit])[0]!).join("\n"))
        }

        case "forget": {
          const ref = requireString(args, "ref")
          const removed = await mem.forget(ref)
          return removed > 0 ? ok(`Forgot ${removed} note(s).`) : fail(`No memory matched "${ref}".`)
        }

        case "todos": {
          const todos = await mem.openTodos(ctx.workingDir)
          if (todos.length === 0) return ok("No open todos.")
          return ok(todos.map((todo) => `- [ ] ${todo}`).join("\n"))
        }

        default:
          return fail(`Unknown action "${action}". Use remember, recall, forget or todos.`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
}

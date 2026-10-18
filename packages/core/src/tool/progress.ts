/**
 * progress — the tool the agent uses to remember where it is.
 *
 * Small models lose the thread between steps, and a run that is interrupted (or
 * cut off by the output limit) has no way to know what it already finished. This
 * exposes the project's key/value ledger to the model so *it* can record state
 * exactly, and pick it up on the next step or the next session.
 */
import { ledgerFor } from "../memory/ledger"
import type { ImurunTool } from "./types"
import { fail, ok, requireString } from "./types"

export const progressTool: ImurunTool = {
  name: "progress",
  description:
    "Record where you are in a piece of work so it can be resumed exactly, even after an interruption or a " +
    "restart. action=list reads it back; action=set stores a key \u2192 value fact; action=remove deletes one; " +
    "action=clear empties it. Use short, stable keys (file:src/app.ts, task:landing-page, step:3), keep values " +
    "to one line, and mark an entry done the moment that piece is finished. Call list first when you resume " +
    "work you may have started earlier.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "set", "remove", "clear"], description: "What to do." },
      key: { type: "string", description: "Entry key, e.g. file:src/app.ts (set/remove)." },
      value: { type: "string", description: "One-line description of the state (set)." },
      status: {
        type: "string",
        enum: ["open", "done"],
        description: "open while still in flight (default), done once that piece is finished (set).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  title: (args) => {
    const action = typeof args.action === "string" ? args.action : "list"
    const key = typeof args.key === "string" ? ` ${args.key}` : ""
    return `progress ${action}${key}`
  },
  async execute(args, ctx) {
    const ledger = ctx.ledger ?? ledgerFor(ctx.workingDir)
    const action = typeof args.action === "string" ? args.action : "list"

    try {
      switch (action) {
        case "list": {
          const entries = await ledger.all()
          if (entries.length === 0) return ok("The progress ledger is empty for this project.", { title: "progress list" })
          const lines = entries.map((entry) => {
            const numbers = entry.numbers
              ? ` (${Object.entries(entry.numbers)
                  .map(([name, value]) => `${name}=${value}`)
                  .join(" ")})`
              : ""
            return `[${entry.status}] ${entry.key} \u2014 ${entry.value}${numbers}`
          })
          return ok(`Progress ledger:\n${lines.join("\n")}`, { title: "progress list", data: entries })
        }
        case "set": {
          const key = requireString(args, "key")
          const value = requireString(args, "value")
          const status = args.status === "done" ? "done" : args.status === "open" ? "open" : undefined
          const entry = await ledger.set(key, value, { status })
          return ok(`Recorded ${entry.key} as ${entry.status}.`, { title: `progress set ${entry.key}`, data: entry })
        }
        case "remove": {
          const key = requireString(args, "key")
          const removed = await ledger.remove(key)
          return removed ? ok(`Removed ${key}.`) : fail(`No ledger entry named ${key}.`)
        }
        case "clear": {
          const count = await ledger.clear()
          return ok(`Cleared ${count} ledger entr${count === 1 ? "y" : "ies"}.`)
        }
        default:
          return fail(`Unknown action "${action}". Use list, set, remove, or clear.`)
      }
    } catch (error) {
      return fail(`Progress ledger error: ${(error as Error).message}`)
    }
  },
}

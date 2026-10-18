/**
 * todo — the agent's plan, kept where the user can see it being ticked off.
 *
 * For anything with more than a couple of steps the model should write the
 * steps down first (action=plan), then move one to "doing" before starting it
 * and to "done" the moment it is finished. The list is shown in the session
 * panel and survives a restart, so an interrupted run resumes from the plan
 * instead of guessing.
 */
import { formatTodos, todoGlyph, todoStoreFor } from "../todo/store"
import type { TodoInput, TodoStatus } from "../todo/store"
import { asArgs, fail, ok, optionalString } from "./types"
import type { ImurunTool } from "./types"

const STATUSES: TodoStatus[] = ["open", "doing", "done"]

function asStatus(value: string | undefined): TodoStatus | undefined {
  return value && (STATUSES as string[]).includes(value) ? (value as TodoStatus) : undefined
}

/** Accepts a list of plain strings or of {title, status} objects. */
function asItems(args: Record<string, unknown>): TodoInput[] {
  const raw = args.todos
  if (!Array.isArray(raw)) throw new Error("action=plan needs a `todos` array")
  const items: TodoInput[] = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      items.push({ title: entry })
      continue
    }
    if (typeof entry !== "object" || entry === null) continue
    const item = entry as Record<string, unknown>
    const title = typeof item.title === "string" ? item.title : typeof item.text === "string" ? item.text : ""
    if (!title.trim()) continue
    items.push({
      title,
      detail: typeof item.detail === "string" ? item.detail : undefined,
      status: asStatus(typeof item.status === "string" ? item.status : undefined),
    })
  }
  return items
}

function render(todos: { status: TodoStatus; title: string }[]): string {
  return todos.map((todo) => `${todoGlyph(todo.status)} ${todo.title}`).join("\n")
}

export const todoTool: ImurunTool = {
  name: "todo",
  description:
    "Write down and keep track of the steps of a task. Use action=plan before starting anything that needs more " +
    "than two steps — send the whole list, in order, and it replaces the previous plan. Then move a step to " +
    "status=doing right before you work on it and to status=done the moment it is really finished, so the list " +
    "always matches reality. action=list reads it back (check this when you resume, or when the user asks where " +
    "things stand); action=add appends one step; action=done/reopen/remove act on one step by its number, id, or a " +
    "fragment of its title; action=clear-done drops the finished ones. Keep titles to one imperative line.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["plan", "add", "list", "start", "done", "reopen", "remove", "clear-done", "clear"],
        description: "What to do.",
      },
      todos: {
        type: "array",
        description:
          "For action=plan: the full ordered list. Each entry is either a string, or an object " +
          '{ "title": "…", "status": "open|doing|done", "detail": "…" }.',
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                title: { type: "string" },
                detail: { type: "string" },
                status: { type: "string", enum: ["open", "doing", "done"] },
              },
              required: ["title"],
            },
          ],
        },
      },
      title: { type: "string", description: "For action=add: the step, one imperative line." },
      detail: { type: "string", description: "For action=add: optional context for that step." },
      ref: {
        type: "string",
        description: "For start/done/reopen/remove: the step's number in the list, its id, or part of its title.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  title(args) {
    const action = typeof args.action === "string" ? args.action : "todo"
    const ref = typeof args.ref === "string" ? ` ${args.ref}` : ""
    const title = typeof args.title === "string" ? ` ${args.title.slice(0, 40)}` : ""
    if (action === "plan" && Array.isArray(args.todos)) return `plan \u00b7 ${args.todos.length} steps`
    return `todo ${action}${ref || title}`
  },
  async execute(rawArgs, ctx) {
    try {
      const args = asArgs(rawArgs)
      const action = typeof args.action === "string" ? args.action : "list"
      const store = todoStoreFor(ctx.workingDir)

      switch (action) {
        case "plan": {
          const items = asItems(args)
          if (items.length === 0) return fail("The plan was empty — send at least one step.")
          const todos = await store.write(items)
          return ok(`Plan set (${todos.length} step${todos.length === 1 ? "" : "s"}):\n${render(todos)}`, {
            title: `plan \u00b7 ${todos.length} steps`,
            data: todos,
          })
        }

        case "add": {
          const title = optionalString(args, "title")
          if (!title?.trim()) return fail("action=add needs a title.")
          const todo = await store.add({ title, detail: optionalString(args, "detail") })
          return ok(`Added: ${todoGlyph(todo.status)} ${todo.title}`, { title: `todo add`, data: todo })
        }

        case "list": {
          const todos = await store.list()
          if (todos.length === 0) return ok("The todo list is empty for this project.")
          const open = todos.filter((todo) => todo.status !== "done").length
          return ok(`${open} open of ${todos.length}:\n${render(todos)}`, { title: "todo list", data: todos })
        }

        case "start":
        case "done":
        case "reopen": {
          const ref = optionalString(args, "ref")
          if (!ref?.trim()) return fail(`action=${action} needs a ref (number, id, or part of the title).`)
          const status: TodoStatus = action === "done" ? "done" : action === "reopen" ? "open" : "doing"
          const todo = await store.setStatus(ref, status)
          if (!todo) return fail(`No todo matched "${ref}".`)
          return ok(`${todoGlyph(todo.status)} ${todo.title} \u2014 ${todo.status}`, {
            title: `todo ${status}`,
            data: todo,
          })
        }

        case "remove": {
          const ref = optionalString(args, "ref")
          if (!ref?.trim()) return fail("action=remove needs a ref.")
          const removed = await store.remove(ref)
          return removed ? ok(`Removed "${ref}" from the plan.`) : fail(`No todo matched "${ref}".`)
        }

        case "clear-done": {
          const removed = await store.clearDone()
          return ok(removed === 0 ? "Nothing to clear." : `Dropped ${removed} finished step(s).`)
        }

        case "clear": {
          const count = await store.clear()
          return ok(`Cleared ${count} todo(s).`)
        }

        default:
          return fail(`Unknown action "${action}". Use plan, add, list, start, done, reopen, remove, clear-done or clear.`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
}

/** The open steps, ready for the session prompt. */
export async function todoPromptLines(projectPath: string, limit = 20): Promise<string[]> {
  return formatTodos(await todoStoreFor(projectPath).open(limit))
}

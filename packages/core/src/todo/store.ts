/**
 * Todos — the plan, written down where the user can watch it.
 *
 * A local model with a small window loses the thread on a long task: it starts
 * a five-file change, runs out of output room, and comes back having forgotten
 * step three. Todos are the fix. The model writes the steps down before it
 * starts, ticks each one off as it goes, and the session panel shows the same
 * list the whole time — so "what is it doing" and "how far along is it" are
 * answered by looking, not by reading the transcript.
 *
 * The list lives in the project, as plain markdown at `.imurun/todos.md`:
 *
 *     # Todos
 *
 *     - [x] read the parser
 *     - [/] write the tests
 *     - [ ] publish 0.1.0
 *
 * That file is the source of truth. It is readable and editable by hand, it
 * diffs in git, it survives a wiped `~/.imurun`, and a later session picks up
 * the unfinished steps from it. `[ ]` is open, `[/]` in progress, `[x]` done
 * (the Obsidian Tasks convention). An indented line under a step is its detail.
 */
import { join } from "node:path"
import { readText, shortHash, writeFileAtomic } from "@imurun/util"

export type TodoStatus = "open" | "doing" | "done"

export interface Todo {
  /** Stable across restarts: derived from the title, so nothing has to be stored. */
  id: string
  /** One line: the step, in the imperative. */
  title: string
  /** Optional context — why, or what "done" means. */
  detail?: string
  status: TodoStatus
  /** Order in the list; lower comes first. */
  position: number
}

/** A list longer than this is a plan nobody is following. */
const MAX_TODOS = 100
/** Steps handed to the model in the system prompt. */
export const TODO_PROMPT_LIMIT = 20

const STATUS_GLYPH: Record<TodoStatus, string> = { open: "\u2610", doing: "\u25d0", done: "\u2611" }
/** The checkbox written for each state. `[/]` is the in-progress convention. */
const STATUS_BOX: Record<TodoStatus, string> = { open: " ", doing: "/", done: "x" }
const BOX_STATUS: Record<string, TodoStatus> = {
  " ": "open",
  "": "open",
  x: "done",
  X: "done",
  "/": "doing",
  "~": "doing",
  "-": "doing",
}

const CONVENTION_LINE = "_IMURUN keeps this list in sync with the session. `[x]` done, `[/]` in progress._"

export function todoGlyph(status: TodoStatus): string {
  return STATUS_GLYPH[status]
}

/** "done/total" style counts for a list. */
export function todoCounts(todos: Todo[]): { open: number; doing: number; done: number; total: number } {
  return {
    open: todos.filter((todo) => todo.status === "open").length,
    doing: todos.filter((todo) => todo.status === "doing").length,
    done: todos.filter((todo) => todo.status === "done").length,
    total: todos.length,
  }
}

function normalise(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase()
}

/** Derived, so the markdown file needs no ids of its own. */
export function todoIdFor(title: string): string {
  return `td_${shortHash(normalise(title), 8)}`
}

export function todoPath(projectPath: string): string {
  return join(projectPath, ".imurun", "todos.md")
}

/** Where the plan lives, for callers that want to show or open the file. */
export function todoFile(projectPath: string): string {
  return todoPath(projectPath)
}

const STEP = /^\s*(?:[-*+]|\d+[.)])\s*\[(.)\]\s*(.*)$/

/** Reads a todos.md into steps. Anything that is not a step is ignored. */
export function parseTodos(markdown: string): Todo[] {
  const todos: Todo[] = []
  let current: Todo | undefined

  for (const raw of markdown.split(/\r?\n/)) {
    const match = STEP.exec(raw)
    if (match) {
      const title = match[2]!.trim()
      if (!title) continue
      current = {
        id: todoIdFor(title),
        title,
        status: BOX_STATUS[match[1]!] ?? "open",
        position: todos.length,
      }
      todos.push(current)
      continue
    }
    // An indented line under a step is that step's detail.
    if (current && /^\s+\S/.test(raw) && !raw.trim().startsWith("#")) {
      const detail = raw.trim()
      current.detail = current.detail ? `${current.detail} ${detail}` : detail
    }
  }

  return todos.slice(0, MAX_TODOS)
}

/** Renders steps back to markdown, preserving order and detail. */
export function renderTodos(todos: Todo[]): string {
  const lines = ["# Todos", "", CONVENTION_LINE, ""]
  for (const todo of todos) {
    lines.push(`- [${STATUS_BOX[todo.status]}] ${todo.title.replace(/\s+/g, " ").trim()}`)
    if (todo.detail) lines.push(`  ${todo.detail.replace(/\s+/g, " ").trim()}`)
  }
  return `${lines.join("\n")}\n`
}

export interface AddTodoInput {
  title: string
  detail?: string
  status?: TodoStatus
}

/** One item in a whole-list write, as the model sends it. */
export interface TodoInput {
  title: string
  detail?: string
  status?: TodoStatus
}

export class TodoStore {
  constructor(readonly projectPath: string) {}

  private async load(): Promise<Todo[]> {
    let raw: string
    try {
      raw = await readText(todoPath(this.projectPath))
    } catch {
      return []
    }
    return parseTodos(raw)
  }

  private async save(todos: Todo[]): Promise<void> {
    // Unfinished work is what matters; finished work is trimmed first.
    const ordered = [...todos].sort((a, b) => {
      const doneA = a.status === "done" ? 1 : 0
      const doneB = b.status === "done" ? 1 : 0
      return doneA - doneB || a.position - b.position
    })
    const kept = ordered.slice(0, MAX_TODOS).sort((a, b) => a.position - b.position)
    await writeFileAtomic(todoPath(this.projectPath), renderTodos(kept))
  }

  /** The list in file order. Done items are included unless told otherwise. */
  async list(options: { includeDone?: boolean; limit?: number } = {}): Promise<Todo[]> {
    const todos = await this.load()
    const filtered = options.includeDone === false ? todos.filter((todo) => todo.status !== "done") : todos
    return options.limit ? filtered.slice(0, options.limit) : filtered
  }

  /** Just the unfinished work, in order — what the panel and the prompt show. */
  async open(limit = TODO_PROMPT_LIMIT): Promise<Todo[]> {
    return (await this.load())
      .filter((todo) => todo.status !== "done")
      .slice(0, limit)
  }

  async counts(): Promise<{ open: number; doing: number; done: number; total: number }> {
    return todoCounts(await this.load())
  }

  /**
   * Adds a step, appended to the end. A title that is already on the list is
   * updated instead of duplicated, so a model re-planning cannot pile up
   * near-identical rows.
   */
  async add(input: AddTodoInput): Promise<Todo> {
    const title = input.title.replace(/\s+/g, " ").trim()
    if (!title) throw new Error("a todo needs a title")
    const todos = await this.load()
    const existing = todos.find((todo) => normalise(todo.title) === normalise(title))

    if (existing) {
      if (input.detail) existing.detail = input.detail
      if (input.status) existing.status = input.status
      await this.save(todos)
      return existing
    }

    const todo: Todo = {
      id: todoIdFor(title),
      title,
      detail: input.detail,
      status: input.status ?? "open",
      position: todos.length,
    }
    todos.push(todo)
    await this.save(todos)
    return todo
  }

  /** Adds several steps at once, keeping the order they were given in. */
  async addMany(inputs: AddTodoInput[]): Promise<Todo[]> {
    const added: Todo[] = []
    for (const input of inputs) added.push(await this.add(input))
    return added
  }

  /**
   * Replaces the list with exactly `items`, which is how the model keeps the
   * plan in sync: it sends the whole list each time it replans.
   */
  async write(items: TodoInput[]): Promise<Todo[]> {
    const todos: Todo[] = []
    for (const item of items) {
      const title = item.title.replace(/\s+/g, " ").trim()
      if (!title) continue
      todos.push({
        id: todoIdFor(title),
        title,
        detail: item.detail,
        status: item.status ?? "open",
        position: todos.length,
      })
    }
    await this.save(todos)
    return todos
  }

  /**
   * Finds one todo by list number ("2"), id, id prefix, or a piece of its
   * title. Numbering is 1-based over the file order of `list()`.
   */
  async resolve(ref: string): Promise<Todo | undefined> {
    const needle = ref.trim()
    if (!needle) return undefined
    const all = await this.load()
    const index = Number(needle.replace(/^#/, ""))
    if (Number.isInteger(index) && index >= 1 && index <= all.length) return all[index - 1]
    const byId = all.find((todo) => todo.id === needle) ?? all.find((todo) => todo.id.startsWith(needle))
    if (byId) return byId
    const lower = normalise(needle)
    return all.find((todo) => normalise(todo.title) === lower) ?? all.find((todo) => normalise(todo.title).includes(lower))
  }

  async setStatus(ref: string, status: TodoStatus): Promise<Todo | undefined> {
    const todo = await this.resolve(ref)
    if (!todo) return undefined
    const todos = await this.load()
    const target = todos.find((item) => item.id === todo.id)
    if (!target) return undefined
    target.status = status
    await this.save(todos)
    return target
  }

  /** Marks every step done — used when a plan finishes. */
  async completeAll(): Promise<number> {
    const todos = await this.load()
    let changed = 0
    for (const todo of todos) {
      if (todo.status === "done") continue
      todo.status = "done"
      changed++
    }
    if (changed > 0) await this.save(todos)
    return changed
  }

  async remove(ref: string): Promise<boolean> {
    const todo = await this.resolve(ref)
    if (!todo) return false
    const todos = await this.load()
    const before = todos.length
    const kept = todos.filter((item) => item.id !== todo.id).map((item, index) => ({ ...item, position: index }))
    if (kept.length === before) return false
    await this.save(kept)
    return true
  }

  /** Drops the finished steps, keeping the open ones. */
  async clearDone(): Promise<number> {
    const todos = await this.load()
    const kept = todos.filter((todo) => todo.status !== "done").map((item, index) => ({ ...item, position: index }))
    const removed = todos.length - kept.length
    if (removed > 0) await this.save(kept)
    return removed
  }

  async clear(): Promise<number> {
    const todos = await this.load()
    await this.save([])
    return todos.length
  }
}

const stores = new Map<string, TodoStore>()

/** One store per project, cached so a tool call does no repeated setup. */
export function todoStoreFor(projectPath: string): TodoStore {
  const key = projectPath.toLowerCase()
  let store = stores.get(key)
  if (!store) {
    store = new TodoStore(projectPath)
    stores.set(key, store)
  }
  return store
}

export function clearTodoCache(): void {
  stores.clear()
}

/** Renders the unfinished steps for the system prompt, one line each. */
export function formatTodos(todos: Todo[]): string[] {
  return todos.map((todo) => `${todoGlyph(todo.status)} ${todo.title.replace(/\s+/g, " ").trim()}`)
}

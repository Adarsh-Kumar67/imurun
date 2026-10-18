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
 * Stored per project as plain JSON, next to the rest of memory, so the list
 * survives restarts, is readable (and editable) by hand, and a later session
 * can pick up the unfinished steps.
 */
import { join } from "node:path"
import { ensureDir, imurunDir, readJson, shortHash, writeJsonAtomic } from "@imurun/util"

export type TodoStatus = "open" | "doing" | "done"

export interface Todo {
  id: string
  /** One line: the step, in the imperative. */
  title: string
  /** Optional context — why, or what "done" means. */
  detail?: string
  status: TodoStatus
  /** Order in the list; lower comes first. */
  position: number
  /** Session that created it, when known. */
  sessionId?: string
  /** Agent that created it, when known. */
  agentId?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

/** A list longer than this is a plan nobody is following. */
const MAX_TODOS = 100
/** Rows handed to the model in the system prompt. */
export const TODO_PROMPT_LIMIT = 20

interface TodoFile {
  version: 1
  projectPath: string
  updatedAt: number
  todos: Todo[]
}

const OPEN_STATUSES: TodoStatus[] = ["open", "doing"]

export function todoDir(): string {
  return imurunDir("memory", "todos")
}

export function todoPath(projectPath: string): string {
  return join(todoDir(), `${shortHash(projectPath.toLowerCase(), 10)}.json`)
}

const STATUS_GLYPH: Record<TodoStatus, string> = { open: "\u2610", doing: "\u25d0", done: "\u2611" }

export function todoGlyph(status: TodoStatus): string {
  return STATUS_GLYPH[status]
}

/** "1/3 done" style counts for a list. */
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

/** A short, stable, readable id. */
function todoId(): string {
  return `td_${Math.random().toString(36).slice(2, 10)}`
}

export interface AddTodoInput {
  title: string
  detail?: string
  status?: TodoStatus
  sessionId?: string
  agentId?: string
}

/** One item in a whole-list write, as the model sends it. */
export interface TodoInput {
  title: string
  detail?: string
  status?: TodoStatus
}

export class TodoStore {
  constructor(readonly projectPath: string) {}

  private async load(): Promise<TodoFile> {
    const data = await readJson<TodoFile>(todoPath(this.projectPath))
    if (!data || !Array.isArray(data.todos)) {
      return { version: 1, projectPath: this.projectPath, updatedAt: Date.now(), todos: [] }
    }
    return {
      version: 1,
      projectPath: this.projectPath,
      updatedAt: data.updatedAt ?? 0,
      todos: data.todos.map((todo, index) => ({
        ...todo,
        status: STATUS_GLYPH[todo.status] ? todo.status : "open",
        position: typeof todo.position === "number" ? todo.position : index,
      })),
    }
  }

  private async save(file: TodoFile): Promise<void> {
    await ensureDir(todoDir())
    // Unfinished work stays; finished work is trimmed first when the cap is hit.
    const ordered = [...file.todos].sort((a, b) => {
      const doneA = a.status === "done" ? 1 : 0
      const doneB = b.status === "done" ? 1 : 0
      return doneA - doneB || a.position - b.position
    })
    const kept = ordered.slice(0, MAX_TODOS).sort((a, b) => a.position - b.position)
    await writeJsonAtomic(todoPath(this.projectPath), { ...file, updatedAt: Date.now(), todos: kept })
  }

  /** The list in display order. Done items are included unless told otherwise. */
  async list(options: { includeDone?: boolean; limit?: number } = {}): Promise<Todo[]> {
    const file = await this.load()
    const items = [...file.todos].sort((a, b) => a.position - b.position)
    const filtered = options.includeDone === false ? items.filter((todo) => todo.status !== "done") : items
    return options.limit ? filtered.slice(0, options.limit) : filtered
  }

  /** Just the unfinished work, in order — what the panel and prompt show. */
  async open(limit = TODO_PROMPT_LIMIT): Promise<Todo[]> {
    const file = await this.load()
    return [...file.todos]
      .sort((a, b) => a.position - b.position)
      .filter((todo) => OPEN_STATUSES.includes(todo.status))
      .slice(0, limit)
  }

  async counts(): Promise<{ open: number; doing: number; done: number; total: number }> {
    return todoCounts(await this.list())
  }

  /**
   * Adds a step, appended to the end. A title that is already on the list is
   * updated instead of duplicated, so a model re-planning cannot pile up
   * near-identical rows.
   */
  async add(input: AddTodoInput): Promise<Todo> {
    const title = input.title.replace(/\s+/g, " ").trim()
    if (!title) throw new Error("a todo needs a title")
    const file = await this.load()
    const existing = file.todos.find((todo) => normalise(todo.title) === normalise(title))
    const now = Date.now()

    if (existing) {
      existing.title = title
      existing.detail = input.detail ?? existing.detail
      existing.status = input.status ?? "open"
      existing.updatedAt = now
      if (existing.status === "done") existing.completedAt = now
      else delete existing.completedAt
      await this.save(file)
      return existing
    }

    const todo: Todo = {
      id: todoId(),
      title,
      detail: input.detail,
      status: input.status ?? "open",
      position: file.todos.reduce((max, item) => Math.max(max, item.position), -1) + 1,
      sessionId: input.sessionId,
      agentId: input.agentId,
      createdAt: now,
      updatedAt: now,
      ...(input.status === "done" ? { completedAt: now } : {}),
    }
    file.todos.push(todo)
    await this.save(file)
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
   * plan in sync: it sends the whole list each time it replans. Titles that
   * were already on the list keep their id and creation time.
   */
  async write(items: TodoInput[], context: { sessionId?: string; agentId?: string } = {}): Promise<Todo[]> {
    const file = await this.load()
    const byTitle = new Map(file.todos.map((todo) => [normalise(todo.title), todo]))
    const now = Date.now()
    const next: Todo[] = []

    items.forEach((item, index) => {
      const title = item.title.replace(/\s+/g, " ").trim()
      if (!title) return
      const existing = byTitle.get(normalise(title))
      const status: TodoStatus = item.status && STATUS_GLYPH[item.status] ? item.status : existing?.status ?? "open"
      const todo: Todo = {
        id: existing?.id ?? todoId(),
        title,
        detail: item.detail ?? existing?.detail,
        status,
        position: index,
        sessionId: existing?.sessionId ?? context.sessionId,
        agentId: existing?.agentId ?? context.agentId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (status === "done") todo.completedAt = existing?.completedAt ?? now
      next.push(todo)
    })

    file.todos = next
    await this.save(file)
    return next
  }

  /**
   * Finds one todo by list number ("2"), id, id prefix, or a piece of its
   * title. Numbering is 1-based over the display order of `list()`.
   */
  async resolve(ref: string): Promise<Todo | undefined> {
    const needle = ref.trim()
    if (!needle) return undefined
    const all = await this.list()
    const index = Number(needle.replace(/^#/, ""))
    if (Number.isInteger(index) && index >= 1 && index <= all.length) return all[index - 1]
    const byId = all.find((todo) => todo.id === needle) ?? all.find((todo) => todo.id.startsWith(needle))
    if (byId) return byId
    const lower = needle.toLowerCase()
    return (
      all.find((todo) => normalise(todo.title) === lower) ??
      all.find((todo) => normalise(todo.title).includes(lower))
    )
  }

  async setStatus(ref: string, status: TodoStatus): Promise<Todo | undefined> {
    const todo = await this.resolve(ref)
    if (!todo) return undefined
    const file = await this.load()
    const target = file.todos.find((item) => item.id === todo.id)
    if (!target) return undefined
    target.status = status
    target.updatedAt = Date.now()
    if (status === "done") target.completedAt = Date.now()
    else delete target.completedAt
    await this.save(file)
    return target
  }

  /** Marks everything on the list done — used when a plan finishes. */
  async completeAll(): Promise<number> {
    const file = await this.load()
    const now = Date.now()
    let changed = 0
    for (const todo of file.todos) {
      if (todo.status === "done") continue
      todo.status = "done"
      todo.updatedAt = now
      todo.completedAt = now
      changed++
    }
    if (changed > 0) await this.save(file)
    return changed
  }

  async remove(ref: string): Promise<boolean> {
    const todo = await this.resolve(ref)
    if (!todo) return false
    const file = await this.load()
    const before = file.todos.length
    file.todos = file.todos.filter((item) => item.id !== todo.id).map((item, index) => ({ ...item, position: index }))
    if (file.todos.length === before) return false
    await this.save(file)
    return true
  }

  /** Drops the finished steps, keeping the open ones. */
  async clearDone(): Promise<number> {
    const file = await this.load()
    const before = file.todos.length
    file.todos = file.todos.filter((todo) => todo.status !== "done").map((item, index) => ({ ...item, position: index }))
    const removed = before - file.todos.length
    if (removed > 0) await this.save(file)
    return removed
  }

  async clear(): Promise<number> {
    const file = await this.load()
    const count = file.todos.length
    await this.save({ ...file, todos: [] })
    return count
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

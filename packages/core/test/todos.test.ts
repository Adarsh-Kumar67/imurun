/**
 * Todos — the plan the model writes down and the user watches get ticked off.
 * The markdown file in the project is the source of truth, so these tests read
 * it back directly.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  TodoStore,
  formatTodos,
  parseTodos,
  renderTodos,
  todoCounts,
  todoGlyph,
  todoIdFor,
  todoPath,
  todoStoreFor,
} from "../src/todo/store"
import { todoTool } from "../src/tool/todo"
import type { ToolContext } from "../src/tool/types"

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "imurun-todos-"))
})

function toolContext(): ToolContext {
  return {
    workingDir: project,
    sessionId: "ses_test",
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
  } as ToolContext
}

describe("the todos file", () => {
  test("round-trips steps, order and detail", () => {
    const markdown = renderTodos([
      { id: "a", title: "one", status: "done", position: 0 },
      { id: "b", title: "two", status: "doing", position: 1, detail: "keep it small" },
      { id: "c", title: "three", status: "open", position: 2 },
    ])
    const back = parseTodos(markdown)
    expect(back.map((todo) => [todo.title, todo.status])).toEqual([
      ["one", "done"],
      ["two", "doing"],
      ["three", "open"],
    ])
    expect(back[1]!.detail).toBe("keep it small")
  })

  test("reads the checkbox conventions, including hand-edited ones", () => {
    const parsed = parseTodos(
      [
        "# my plan",
        "- [ ] open one",
        "* [x] done one",
        "- [/] in progress",
        "- [~] also in progress",
        "not a step at all",
        "1. [ ] numbered",
      ].join("\n"),
    )
    expect(parsed.map((todo) => todo.status)).toEqual(["open", "done", "doing", "doing", "open"])
  })

  test("an id follows the title, so nothing has to be stored", () => {
    expect(todoIdFor("Write the README")).toBe(todoIdFor("write  the readme"))
    expect(todoIdFor("a")).not.toBe(todoIdFor("b"))
  })

  test("lives at .imurun/todos.md inside the project", () => {
    expect(todoPath("C:/work/app").replace(/\\/g, "/")).toBe("C:/work/app/.imurun/todos.md")
  })
})

describe("TodoStore", () => {
  test("adds steps in order and writes them to the file", async () => {
    const store = new TodoStore(project)
    await store.add({ title: "read the parser" })
    await store.add({ title: "  write   the tests " })

    const fresh = new TodoStore(project)
    const todos = await fresh.list()
    expect(todos.map((todo) => todo.title)).toEqual(["read the parser", "write the tests"])
    expect(todos.every((todo) => todo.status === "open")).toBe(true)

    const onDisk = readFileSync(todoPath(project), "utf8")
    expect(onDisk).toContain("- [ ] read the parser")
    expect(onDisk).toContain("- [ ] write the tests")
  })

  test("a repeated title updates the step instead of duplicating it", async () => {
    const store = new TodoStore(project)
    const first = await store.add({ title: "write the README" })
    const again = await store.add({ title: "Write  the readme", detail: "short version" })
    const todos = await store.list()
    expect(todos).toHaveLength(1)
    expect(again.id).toBe(first.id)
    expect(todos[0]!.detail).toBe("short version")
  })

  test("rejects an empty title", async () => {
    await expect(new TodoStore(project).add({ title: "   " })).rejects.toThrow(/title/)
  })

  test("write replaces the list, keeping ids for the steps that survived", async () => {
    const store = new TodoStore(project)
    const [a, b] = await store.addMany([{ title: "one" }, { title: "two" }])

    const next = await store.write([{ title: "two", status: "done" }, { title: "three" }])
    expect(next.map((todo) => todo.title)).toEqual(["two", "three"])
    expect(next[0]!.id).toBe(b!.id)
    expect(next[0]!.status).toBe("done")
    expect(next[1]!.id).not.toBe(a!.id)
  })

  test("write ignores blank titles", async () => {
    const next = await new TodoStore(project).write([{ title: "keep" }, { title: "  " }])
    expect(next).toHaveLength(1)
  })

  test("resolves a step by number, id, or a fragment of the title", async () => {
    const store = new TodoStore(project)
    const [first] = await store.addMany([{ title: "run the tests" }, { title: "publish 0.1.0" }])

    expect((await store.resolve("1"))?.title).toBe("run the tests")
    expect((await store.resolve("#2"))?.title).toBe("publish 0.1.0")
    expect((await store.resolve(first!.id))?.title).toBe("run the tests")
    expect((await store.resolve(first!.id.slice(0, 6)))?.title).toBe("run the tests")
    expect((await store.resolve("PUBLISH"))?.title).toBe("publish 0.1.0")
    expect(await store.resolve("nothing like this")).toBeUndefined()
    // a number past the end of the list is not a step
    expect(await store.resolve("99")).toBeUndefined()
  })

  test("ticking a step survives a reload", async () => {
    const store = new TodoStore(project)
    await store.add({ title: "ship it" })

    expect((await store.setStatus("ship it", "done"))?.status).toBe("done")
    expect((await new TodoStore(project).list())[0]!.status).toBe("done")
    expect(readFileSync(todoPath(project), "utf8")).toContain("- [x] ship it")

    expect((await store.setStatus("ship it", "open"))?.status).toBe("open")
    expect(readFileSync(todoPath(project), "utf8")).toContain("- [ ] ship it")
  })

  test("a hand-edited file is picked up", async () => {
    await new TodoStore(project).add({ title: "one" })
    const path = todoPath(project)
    writeFileSync(path, `${readFileSync(path, "utf8")}- [x] done by hand\n`)

    const todos = await new TodoStore(project).list()
    expect(todos.map((todo) => todo.status)).toEqual(["open", "done"])
  })

  test("open() lists only unfinished work, in order", async () => {
    const store = new TodoStore(project)
    await store.write([{ title: "one", status: "done" }, { title: "two", status: "doing" }, { title: "three" }])
    expect((await store.open()).map((todo) => todo.title)).toEqual(["two", "three"])
  })

  test("counts and cleanup", async () => {
    const store = new TodoStore(project)
    await store.write([{ title: "one", status: "done" }, { title: "two" }, { title: "three", status: "doing" }])
    expect(todoCounts(await store.list())).toEqual({ open: 1, doing: 1, done: 1, total: 3 })

    expect(await store.clearDone()).toBe(1)
    expect((await store.list()).map((todo) => todo.title)).toEqual(["two", "three"])

    expect(await store.completeAll()).toBe(2)
    expect((await store.list()).every((todo) => todo.status === "done")).toBe(true)

    expect(await store.remove("two")).toBe(true)
    expect(await store.remove("two")).toBe(false)
    expect(await store.clear()).toBe(1)
    expect(await store.list()).toHaveLength(0)
  })

  test("an empty list is still a valid file", async () => {
    const store = new TodoStore(project)
    expect(await store.list()).toHaveLength(0)
    expect(await store.counts()).toEqual({ open: 0, doing: 0, done: 0, total: 0 })
    expect(await store.open()).toHaveLength(0)
  })

  test("keeps the same store object per project", () => {
    expect(todoStoreFor(project)).toBe(todoStoreFor(project.toUpperCase()))
  })

  test("renders glyphs for each state", () => {
    expect(todoGlyph("open")).toBe("\u2610")
    expect(todoGlyph("doing")).toBe("\u25d0")
    expect(todoGlyph("done")).toBe("\u2611")
    expect(formatTodos([{ id: "x", title: "ship", status: "done", position: 0 }])).toEqual(["\u2611 ship"])
  })
})

describe("todo tool", () => {
  test("sets a plan and reports it", async () => {
    const result = await todoTool.execute(
      { action: "plan", todos: ["read the parser", { title: "write tests", status: "doing" }] },
      toolContext(),
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("2 steps")
    expect(result.output).toContain("\u2610 read the parser")
    expect(result.output).toContain("\u25d0 write tests")
    expect(readFileSync(todoPath(project), "utf8")).toContain("- [/] write tests")
  })

  test("an empty plan is refused", async () => {
    const result = await todoTool.execute({ action: "plan", todos: [] }, toolContext())
    expect(result.ok).toBe(false)
  })

  test("add, tick and list in one flow", async () => {
    const ctx = toolContext()
    await todoTool.execute({ action: "add", title: "write the README" }, ctx)
    const done = await todoTool.execute({ action: "done", ref: "1" }, ctx)
    expect(done.ok).toBe(true)
    expect(done.output).toContain("done")

    const list = await todoTool.execute({ action: "list" }, ctx)
    expect(list.output).toContain("0 open of 1")
    expect(list.output).toContain("\u2611 write the README")
  })

  test("start moves a step to doing", async () => {
    const ctx = toolContext()
    await todoTool.execute({ action: "plan", todos: ["one"] }, ctx)
    const started = await todoTool.execute({ action: "start", ref: "one" }, ctx)
    expect(started.output).toContain("doing")
  })

  test("unknown refs and actions fail clearly", async () => {
    const ctx = toolContext()
    expect((await todoTool.execute({ action: "done", ref: "nope" }, ctx)).ok).toBe(false)
    expect((await todoTool.execute({ action: "nonsense" }, ctx)).ok).toBe(false)
    expect((await todoTool.execute({ action: "remove" }, ctx)).ok).toBe(false)
  })

  test("clear-done keeps the unfinished steps", async () => {
    const ctx = toolContext()
    await todoTool.execute({ action: "plan", todos: [{ title: "one", status: "done" }, { title: "two" }] }, ctx)
    await todoTool.execute({ action: "clear-done" }, ctx)
    const list = await todoTool.execute({ action: "list" }, ctx)
    expect(list.output).toContain("two")
    expect(list.output).not.toContain("one")
  })
})

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@imurun/util"
import { clearLedgerCache, ledgerFor } from "../src/memory/ledger"
import { progressTool } from "../src/tool/progress"
import type { ToolContext } from "../src/tool/types"

let home: string
let dir: string
let ctx: ToolContext

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-progress-"))
  dir = await mkdtemp(join(tmpdir(), "imurun-progress-work-"))
  process.env.IMURUN_HOME = home
  clearLedgerCache()
  ctx = { workingDir: dir, sessionId: "ses_test", log: createLogger("test"), ledger: ledgerFor(dir) }
})

afterEach(async () => {
  clearLedgerCache()
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

describe("progress tool", () => {
  test("an empty ledger says so without failing", async () => {
    const result = await progressTool.execute({ action: "list" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("empty")
  })

  test("set then list shows the entry and its status", async () => {
    const set = await progressTool.execute({ action: "set", key: "task:landing", value: "hero done" }, ctx)
    expect(set.ok).toBe(true)
    const list = await progressTool.execute({ action: "list" }, ctx)
    expect(list.output).toContain("task:landing")
    expect(list.output).toContain("hero done")
    expect(list.output).toContain("[open]")
  })

  test("status done marks an entry finished", async () => {
    await progressTool.execute({ action: "set", key: "step:1", value: "scaffold", status: "done" }, ctx)
    const list = await progressTool.execute({ action: "list" }, ctx)
    expect(list.output).toContain("[done]")
    const open = await ctx.ledger!.open()
    expect(open).toHaveLength(0)
  })

  test("remove deletes an entry and reports a missing one", async () => {
    await progressTool.execute({ action: "set", key: "a", value: "1" }, ctx)
    expect((await progressTool.execute({ action: "remove", key: "a" }, ctx)).ok).toBe(true)
    expect((await progressTool.execute({ action: "remove", key: "a" }, ctx)).ok).toBe(false)
  })

  test("clear empties the ledger", async () => {
    await progressTool.execute({ action: "set", key: "a", value: "1" }, ctx)
    await progressTool.execute({ action: "set", key: "b", value: "2" }, ctx)
    const cleared = await progressTool.execute({ action: "clear" }, ctx)
    expect(cleared.ok).toBe(true)
    expect(cleared.output).toContain("2")
    expect((await progressTool.execute({ action: "list" }, ctx)).output).toContain("empty")
  })

  test("set requires a key and a value", async () => {
    expect((await progressTool.execute({ action: "set", key: "a" }, ctx)).ok).toBe(false)
    expect((await progressTool.execute({ action: "set", value: "v" }, ctx)).ok).toBe(false)
  })

  test("an unknown action is refused with guidance", async () => {
    const result = await progressTool.execute({ action: "wat" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("list")
  })

  test("the title describes what was done", () => {
    expect(progressTool.title?.({ action: "set", key: "file:a.ts" })).toBe("progress set file:a.ts")
    expect(progressTool.title?.({ action: "list" })).toBe("progress list")
  })
})

describe("progress ledger integration with writes", () => {
  test("a write records the file so the next run can resume", async () => {
    const { writeTool } = await import("../src/tool/write")
    const result = await writeTool.execute({ path: "src/app.ts", content: "export const a = 1\n", mode: "create" }, ctx)
    expect(result.ok).toBe(true)

    const entry = await ctx.ledger!.get("file:src/app.ts")
    expect(entry).toBeDefined()
    expect(entry!.numbers?.lines).toBeGreaterThan(0)
    // and it is visible to the model as work in progress
    const list = await progressTool.execute({ action: "list" }, ctx)
    expect(list.output).toContain("file:src/app.ts")
  })
})

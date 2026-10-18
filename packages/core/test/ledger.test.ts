import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LEDGER_PROMPT_LIMIT,
  ProgressLedger,
  clearLedgerCache,
  formatLedger,
  ledgerFor,
  ledgerPath,
} from "../src/memory/ledger"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-ledger-"))
  process.env.IMURUN_HOME = home
  clearLedgerCache()
})

afterEach(async () => {
  clearLedgerCache()
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
})

describe("ProgressLedger", () => {
  test("stores and reads back a fact", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    const entry = await ledger.set("task:landing-page", "hero section done")
    expect(entry.key).toBe("task:landing-page")
    expect(entry.status).toBe("open")
    expect((await ledger.get("task:landing-page"))?.value).toBe("hero section done")
  })

  test("updates in place rather than duplicating a key", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await ledger.set("file:src/app.ts", "created")
    await ledger.set("file:src/app.ts", "appended section 2", { status: "done" })
    const entries = await ledger.all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.value).toBe("appended section 2")
    expect(entries[0]!.status).toBe("done")
  })

  test("keys are matched case-insensitively but keep their original spelling", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await ledger.set("File:Src/App.ts", "created")
    await ledger.set("file:src/app.ts", "updated")
    const entries = await ledger.all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe("File:Src/App.ts")
    expect(await ledger.get("FILE:SRC/APP.TS")).toBeDefined()
  })

  test("removes and clears", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await ledger.set("a", "1")
    await ledger.set("b", "2")
    expect(await ledger.remove("a")).toBe(true)
    expect(await ledger.remove("a")).toBe(false)
    expect(await ledger.clear()).toBe(1)
    expect(await ledger.all()).toHaveLength(0)
  })

  test("open() returns only unfinished work, newest first, capped", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await ledger.set("done-one", "finished", { status: "done" })
    await ledger.set("open-one", "in flight")
    await ledger.set("open-two", "also in flight")
    const open = await ledger.open()
    expect(open.map((entry) => entry.key)).not.toContain("done-one")
    expect(open.length).toBe(2)
    for (let index = 1; index < open.length; index++) {
      expect(open[index - 1]!.updatedAt).toBeGreaterThanOrEqual(open[index]!.updatedAt)
    }
    expect(await ledger.open(1)).toHaveLength(1)
    expect(LEDGER_PROMPT_LIMIT).toBeGreaterThan(0)
  })

  test("an empty key is rejected", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await expect(ledger.set("   ", "value")).rejects.toThrow(/empty/)
  })

  test("noteFile records size and mode without clobbering a done marker", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await ledger.set("file:src/app.ts", "created", { status: "done" })
    await ledger.noteFile("src/app.ts", { bytes: 1200, lines: 42, mode: "append" })
    const entry = await ledger.get("file:src/app.ts")
    expect(entry?.status).toBe("done")
    expect(entry?.numbers?.bytes).toBe(1200)
    expect(entry?.numbers?.lines).toBe(42)
  })

  test("noteFile normalises windows separators in the key", async () => {
    const ledger = new ProgressLedger("C:/work/app")
    await ledger.noteFile("src\\ui\\button.tsx", { bytes: 10, lines: 1, mode: "overwrite" })
    expect(await ledger.get("file:src/ui/button.tsx")).toBeDefined()
  })
})

describe("ledgerFor", () => {
  test("returns one instance per project and different files per project", async () => {
    const a = ledgerFor("C:/work/one")
    const b = ledgerFor("C:/work/one")
    const c = ledgerFor("C:/work/two")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(ledgerPath("C:/work/one")).not.toBe(ledgerPath("C:/work/two"))
    await a.set("k", "v")
    expect(await c.all()).toHaveLength(0)
  })

  test("persists to disk as plain JSON", async () => {
    const ledger = ledgerFor("C:/work/one")
    await ledger.set("k", "v")
    const file = JSON.parse(await readFile(ledgerPath("C:/work/one"), "utf8"))
    expect(file.entries[0].key).toBe("k")
    expect(file.projectPath).toBe("C:/work/one")
  })
})

describe("formatLedger", () => {
  test("renders one short line per entry", () => {
    const lines = formatLedger([
      { key: "file:src/app.ts", value: "1.2 KB", updatedAt: 1, status: "open", numbers: { lines: 42 } },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("file:src/app.ts")
    expect(lines[0]).toContain("lines=42")
    expect(lines[0]).not.toContain("\n")
  })
})

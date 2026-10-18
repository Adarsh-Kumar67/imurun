import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@imurun/util"
import {
  RagIndex,
  chunkText,
  clearRagCache,
  codeTokens,
  excerpt,
  formatRagHit,
  getRagIndex,
  invalidateRag,
  isIndexableFile,
  snapshotPath,
} from "../src/rag/index"
import { codeSearchTool } from "../src/tool/rag"
import type { ToolContext } from "../src/tool/types"

let home: string
let work: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-rag-home-"))
  work = await mkdtemp(join(tmpdir(), "imurun-rag-work-"))
  process.env.IMURUN_HOME = home
  clearRagCache()
})

afterEach(async () => {
  clearRagCache()
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

async function write(relPath: string, content: string): Promise<void> {
  const full = join(work, relPath)
  await mkdir(join(full, ".."), { recursive: true })
  await writeFile(full, content)
}

function context(): ToolContext {
  return { sessionId: "ses_rag", workingDir: work, log: createLogger("test") }
}

const ALPHA = [
  "export interface Item {",
  "  name: string",
  "  price: number",
  "}",
  "",
  "export function computeWidgetTotal(items: Item[]): number {",
  "  return items.reduce((sum, item) => sum + item.price, 0)",
  "}",
  "",
].join("\n")

const BETA = ["export const unrelatedThing = 42", "export const another = 'nothing to see'", ""].join("\n")

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("isIndexableFile", () => {
  test("accepts source and known extensionless files", () => {
    for (const path of ["src/index.ts", "app.py", "main.go", "Cargo.toml", "README.md", "Dockerfile", "Makefile"]) {
      expect(isIndexableFile(path)).toBe(true)
    }
  })

  test("rejects ignored directories, lock files and binaries", () => {
    for (const path of [
      "node_modules/react/index.js",
      "dist/bundle.js",
      ".git/config",
      "coverage/lcov.info",
      "__pycache__/mod.pyc",
      "package-lock.json",
      "yarn.lock",
      "assets/logo.png",
      ".env",
    ]) {
      expect(isIndexableFile(path)).toBe(false)
    }
  })
})

describe("codeTokens", () => {
  test("indexes the whole identifier and its parts", () => {
    const camel = codeTokens("computeWidgetTotal")
    expect(camel).toContain("computewidgettotal")
    expect(camel).toContain("widget")
    expect(camel).toContain("total")

    const snake = codeTokens("MAX_RETRY_COUNT")
    expect(snake).toContain("max_retry_count")
    expect(snake).toContain("retry")

    // Plain prose is left alone — no needless duplicates.
    expect(codeTokens("widget total")).toEqual(["widget", "total"])
  })
})

describe("chunkText", () => {
  test("keeps a short file as one chunk with 1-based lines", () => {
    const chunks = chunkText("alpha beta gamma\ndelta epsilon zeta\n")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ start: 1, end: 2 })
    expect(chunks[0]!.text).toContain("delta epsilon")
  })

  test("overlaps windows so a boundary does not hide a match", () => {
    const text = Array.from({ length: 200 }, (_, index) => `const value${index} = compute(index)`).join("\n")
    const chunks = chunkText(text, 50, 10_000, 8)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toMatchObject({ start: 1, end: 50 })
    expect(chunks[1]).toMatchObject({ start: 43, end: 92 })
  })

  test("drops windows with nothing to search, and survives one enormous line", () => {
    expect(chunkText("   \n\n   ")).toHaveLength(0)
    const huge = `const total = base${"+extra".repeat(40_000)}`
    const chunks = chunkText(huge, 50, 100)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.start).toBe(1)
    expect(chunks[0]!.text.startsWith("const total")).toBe(true)
  })
})

describe("excerpt", () => {
  test("shows a window around the match", () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index} filler`).join("\n")
    const body = excerpt(text, ["needle"], 10_000)
    expect(body).toContain("line 0")
    expect(body).not.toContain("…")
  })

  test("marks the head it trimmed", () => {
    const lines = Array.from({ length: 30 }, (_, index) => (index === 25 ? "the needle is here" : `line ${index}`))
    const body = excerpt(lines.join("\n"), ["needle"])
    expect(body.startsWith("\u2026")).toBe(true)
    expect(body).toContain("the needle is here")
  })
})

// ── The index ───────────────────────────────────────────────────────────────

describe("RagIndex", () => {
  test("indexes a project and finds things in it", async () => {
    await write("src/alpha.ts", ALPHA)
    await write("src/beta.ts", BETA)

    const index = new RagIndex({ root: work })
    const result = await index.refresh()
    expect(result.added).toBe(2)
    expect(result.chunks).toBeGreaterThan(0)

    const hits = index.search("widget total price")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.path).toBe("src/alpha.ts")
    expect(hits[0]!.excerpt).toContain("computeWidgetTotal")
    expect(hits[0]!.start).toBeGreaterThanOrEqual(1)

    // A plain word finds a camelCase identifier; an exact symbol finds only its file.
    expect(index.search("widget")[0]?.path).toBe("src/alpha.ts")
    expect(index.search("unrelatedThing")[0]?.path).toBe("src/beta.ts")
  })

  test("skips ignored directories and binary files", async () => {
    await write("src/real.ts", ALPHA)
    await write("node_modules/pkg/index.ts", "export const nodeonly = 1\n")
    await write("src/blob.ts", "text before\u0000text after\n")

    const index = new RagIndex({ root: work })
    const result = await index.refresh()
    expect(result.added).toBe(2) // real.ts and blob.ts; node_modules is never visited
    expect(index.search("nodeonly")).toEqual([])
    expect(index.search("blob")).toEqual([])
    expect(index.search("widget")).toHaveLength(1)
  })

  test("re-reads only what changed and forgets what is gone", async () => {
    await write("src/alpha.ts", ALPHA)
    await write("src/beta.ts", BETA)
    const index = new RagIndex({ root: work })
    await index.refresh()

    // A quiet refresh is a no-op.
    const quiet = await index.refresh()
    expect(quiet).toMatchObject({ added: 0, changed: 0, removed: 0, changedAnything: false })

    await write("src/alpha.ts", `${ALPHA}\nexport const zebraCounter = 1\n`)
    const edited = await index.refresh()
    expect(edited).toMatchObject({ added: 0, changed: 1, removed: 0, changedAnything: true })
    expect(index.search("zebraCounter")[0]?.path).toBe("src/alpha.ts")

    await rm(join(work, "src/beta.ts"), { force: true })
    const pruned = await index.refresh()
    expect(pruned).toMatchObject({ added: 0, changed: 0, removed: 1 })
    expect(index.search("unrelatedThing")).toEqual([])
  })

  test("ensureFresh loads a snapshot instead of rebuilding", async () => {
    await write("src/alpha.ts", ALPHA)
    const first = new RagIndex({ root: work })
    await first.refresh()

    const second = new RagIndex({ root: work })
    // Freshly built, so ensureFresh should not rescan at all.
    expect(await second.ensureFresh({ maxAgeMs: 60_000 })).toBeUndefined()
    expect(second.stats().files).toBe(1)
    expect(second.search("computeWidgetTotal")[0]?.path).toBe("src/alpha.ts")

    // A zero-age window forces a refresh, which finds nothing new.
    const refreshed = await second.ensureFresh({ maxAgeMs: -1 })
    expect(refreshed?.changedAnything).toBe(false)
  })

  test("filters by path fragment", async () => {
    await write("packages/api/routes.ts", "export const widget = 'api widget'\n")
    await write("packages/web/routes.ts", "export const widget = 'web widget'\n")
    const index = new RagIndex({ root: work })
    await index.refresh()

    const all = index.search("widget", { limit: 10 })
    expect(all).toHaveLength(2)
    const onlyApi = index.search("widget", { path: "packages/api" })
    expect(onlyApi).toHaveLength(1)
    expect(onlyApi[0]!.path).toBe("packages/api/routes.ts")
  })

  test("markStale forces the next search to see an edit", async () => {
    await write("src/alpha.ts", ALPHA)
    const index = getRagIndex(work)
    await index.ensureFresh()
    expect(index.search("zebraCounter")).toEqual([])

    await write("src/alpha.ts", `${ALPHA}\nexport const zebraCounter = 1\n`)
    invalidateRag(work)
    await index.ensureFresh({ maxAgeMs: 60_000 })
    expect(index.search("zebraCounter")).toHaveLength(1)
  })

  test("a direct markStale bypasses the freshness window", async () => {
    await write("src/alpha.ts", ALPHA)
    const index = new RagIndex({ root: work })
    await index.ensureFresh({ maxAgeMs: 60_000 })

    await write("src/alpha.ts", `${ALPHA}\nexport const zebraCounter = 1\n`)
    index.markStale()
    const result = await index.ensureFresh({ maxAgeMs: 60_000 })
    expect(result?.changed).toBe(1)
    expect(index.search("zebraCounter")).toHaveLength(1)
  })

  test("clear empties the index and the snapshot", async () => {
    await write("src/alpha.ts", ALPHA)
    const index = new RagIndex({ root: work })
    await index.refresh()
    expect(index.stats().chunks).toBeGreaterThan(0)

    await index.clear()
    expect(index.stats()).toMatchObject({ files: 0, chunks: 0, characters: 0 })
    expect(index.search("widget")).toEqual([])
  })

  test("honours the file budget", async () => {
    await write("src/a.ts", "export const alpha = 1\n")
    await write("src/b.ts", "export const bravo = 2\n")
    const index = new RagIndex({ root: work, maxFiles: 1 })
    await index.refresh()
    expect(index.stats().files).toBe(1)
  })
})

describe("snapshotPath", () => {
  test("keeps projects apart and inside IMURUN_HOME", () => {
    const a = snapshotPath(join(work, "app"))
    const b = snapshotPath(join(work, "other"))
    expect(a).not.toBe(b)
    expect(a.startsWith(home)).toBe(true)
    expect(a.endsWith(".json")).toBe(true)
    // Same root always resolves to the same file.
    expect(snapshotPath(join(work, "app"))).toBe(a)
  })
})

describe("getRagIndex", () => {
  test("returns one index per root", () => {
    expect(getRagIndex(work)).toBe(getRagIndex(work))
    expect(getRagIndex(join(work, "sub"))).not.toBe(getRagIndex(work))
  })
})

describe("formatRagHit", () => {
  test("leads with the location and indents the body", () => {
    const body = formatRagHit({ path: "src/a.ts", start: 3, end: 9, score: 12.34, excerpt: "const a = 1" })
    expect(body.split("\n")[0]).toBe("src/a.ts:3-9  (score 12.3)")
    expect(body.split("\n")[1]).toBe("  const a = 1")
  })
})

// ── The tool ────────────────────────────────────────────────────────────────

describe("code_search tool", () => {
  test("finds code and reports where it is", async () => {
    await write("src/alpha.ts", ALPHA)
    const result = await codeSearchTool.execute({ query: "widget total" }, context())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("src/alpha.ts")
    expect(result.output).toContain("computeWidgetTotal")
    expect(result.title).toContain("match")
  })

  test("explains itself when nothing matches", async () => {
    await write("src/alpha.ts", ALPHA)
    const result = await codeSearchTool.execute({ query: "zzz nothing like this" }, context())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("No match")
    expect(result.output).toContain("grep")
  })

  test("refuses a missing query", async () => {
    await expect(codeSearchTool.execute({}, context())).rejects.toThrow(/query/)
  })

  test("is registered in the default tool set", async () => {
    const { ToolRegistry } = await import("../src/tool/registry")
    const names = ToolRegistry.default().list().map((tool) => tool.name)
    expect(names).toContain("code_search")
    expect(names).toContain("web_search")
  })
})

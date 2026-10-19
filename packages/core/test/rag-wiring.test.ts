/**
 * The RAG settings the docs describe, reaching the index: the exclusion list,
 * the chunk shape, and what `watch` actually means for a search.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImurunConfig } from "@imurun/schema"
import { RagIndex, clearRagCache, isExcludedPath, matchPathGlob, ragIndexOptions, refreshRagIndex } from "../src"

let home: string
let root: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-ragwire-home-"))
  root = await mkdtemp(join(tmpdir(), "imurun-ragwire-root-"))
  process.env.IMURUN_HOME = home
  clearRagCache()
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  clearRagCache()
  await rm(home, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

describe("the exclusion list", () => {
  test("glob patterns match the way people expect", () => {
    expect(matchPathGlob("node_modules/react/index.js", "node_modules/**")).toBe(true)
    expect(matchPathGlob("node_modules", "node_modules/**")).toBe(true)
    expect(matchPathGlob("src/node_modules.ts", "node_modules/**")).toBe(false)
    expect(matchPathGlob("a/b/app.min.js", "**/*.min.*")).toBe(true)
    expect(matchPathGlob("app.min.js", "**/*.min.*")).toBe(true)
    expect(matchPathGlob("bun.lock", "bun.lock")).toBe(true)
    expect(matchPathGlob("src/bun.lock", "bun.lock")).toBe(true)
    expect(matchPathGlob("src/index.ts", "dist/**")).toBe(false)
    expect(matchPathGlob("src/index.ts", "")).toBe(false)
  })

  test("build and generated paths are excluded with no configuration at all", () => {
    expect(isExcludedPath("node_modules/x/y.js")).toBe(true)
    expect(isExcludedPath("dist/main.js")).toBe(true)
    expect(isExcludedPath("src/main.ts")).toBe(false)
  })

  test("configured globs add to the built-in list", () => {
    expect(isExcludedPath("vendor/thing.ts", ["vendor/**"])).toBe(true)
    expect(isExcludedPath("src/thing.ts", ["vendor/**"])).toBe(false)
  })
})

describe("config.rag reaches the index", () => {
  test("every knob maps to a real option", () => {
    const config = ImurunConfig.parse({
      rag: {
        maxFileSizeKB: 10,
        maxFiles: 42,
        maxChunks: 99,
        chunkLines: 5,
        chunkChars: 300,
        chunkOverlapLines: 1,
        excludeGlobs: ["vendor/**"],
      },
    })

    const options = ragIndexOptions(config)
    expect(options.maxFileBytes).toBe(10 * 1024)
    expect(options.maxFiles).toBe(42)
    expect(options.maxChunks).toBe(99)
    expect(options.chunkLines).toBe(5)
    expect(options.chunkChars).toBe(300)
    expect(options.chunkOverlapLines).toBe(1)
    expect(options.excludeGlobs).toEqual(["vendor/**"])
  })

  test("an excluded directory is never indexed", async () => {
    await mkdir(join(root, "vendor"), { recursive: true })
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "vendor", "lib.ts"), "export const vendored = 'kestrel-marker'\n")
    await writeFile(join(root, "src", "app.ts"), "export const app = 'kestrel-marker'\n")

    const index = new RagIndex({ root, excludeGlobs: ["vendor/**"] })
    await index.refresh()

    const paths = index.search("kestrel-marker", { limit: 10 }).map((hit) => hit.path)
    expect(paths.join(" ")).toContain("src/app.ts")
    expect(paths.join(" ")).not.toContain("vendor")
  })

  test("the chunk shape is honoured", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `export const line${i} = ${i}`).join("\n")
    await writeFile(join(root, "chunky.ts"), `${lines}\n`)

    const index = new RagIndex({ root, chunkLines: 3, chunkOverlapLines: 0, chunkChars: 4_000 })
    await index.refresh()
    expect(index.stats().chunks).toBeGreaterThanOrEqual(3)
  })

  test("watch off means a search never re-reads the project", async () => {
    const config = ImurunConfig.parse({ rag: { watch: false } })
    await writeFile(join(root, "one.ts"), "export const one = 'alphaneedle'\n")
    const index = new RagIndex({ root })

    // Nothing is indexed yet, so the first search builds it.
    await refreshRagIndex(index, config)
    expect(index.search("alphaneedle").length).toBeGreaterThan(0)

    // A new file appears. With watching off, a search must not see it.
    await writeFile(join(root, "two.ts"), "export const two = 'betaneedle'\n")
    const refreshed = await refreshRagIndex(index, config)
    expect(refreshed).toBeUndefined()
    expect(index.search("betaneedle")).toHaveLength(0)
  })

  test("an explicit refresh still works with watching off", async () => {
    const config = ImurunConfig.parse({ rag: { watch: false } })
    const index = new RagIndex({ root })
    await writeFile(join(root, "one.ts"), "export const one = 'alphaneedle'\n")
    await refreshRagIndex(index, config)

    await writeFile(join(root, "two.ts"), "export const two = 'betaneedle'\n")
    await refreshRagIndex(index, config, true)
    expect(index.search("betaneedle").length).toBeGreaterThan(0)
  })
})

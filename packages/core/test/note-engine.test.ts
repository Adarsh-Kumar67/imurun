/**
 * The note engine and the retention policy.
 *
 * A note is something the user asked to be kept, and the engine — not a list
 * of phrases — decides what qualifies. The tests here prove that it separates
 * standing instructions from ordinary requests, that it merges what is said
 * twice, that it learns from an explicit "remember that", and that what it
 * keeps ages the way it should.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MemoryStore,
  NoteEngine,
  detectDurableNotes,
  findNearDuplicate,
  noteEngineFor,
  rememberMessage,
  retentionScore,
  KIND_HALF_LIFE_DAYS,
} from "../src"
import type { MemoryRecord } from "../src"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-notes-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
})

describe("what counts as a note", () => {
  test("a standing rule is a note", () => {
    const notes = detectDurableNotes("Always use tabs instead of spaces in this repo, please.")
    expect(notes).toHaveLength(1)
    expect(notes[0]!.kind).toBe("user_style")
  })

  test("a personal fact is a fact", () => {
    const notes = detectDurableNotes("My name is Shubham and I work at ImuTechz.")
    expect(notes.every((note) => note.kind === "fact")).toBe(true)
    expect(notes.some((note) => /Shubham/.test(note.text))).toBe(true)
  })

  test("an explicit request to remember is a note", () => {
    const notes = detectDurableNotes("Remember that deploys run on Fridays.")
    expect(notes.some((note) => /Fridays/.test(note.text))).toBe(true)
  })

  test("a secret in passing is a credential", () => {
    const notes = detectDurableNotes("My deploy token is ghp_example12345.")
    expect(notes[0]!.kind).toBe("credential")
  })

  test("ordinary work requests teach nothing", () => {
    expect(detectDurableNotes("run the tests")).toEqual([])
    expect(detectDurableNotes("fix the parser please")).toEqual([])
    expect(detectDurableNotes("always be careful")).toEqual([])
    expect(detectDurableNotes("")).toEqual([])
  })

  test("a pasted document is not scanned for rules", () => {
    expect(detectDurableNotes(`always ${"x".repeat(5_000)}`)).toEqual([])
  })
})

describe("learning from what the user says", () => {
  test("the engine learns an explicit request, and keeps it after a restart", async () => {
    const path = join(home, "note.json")
    const engine = await noteEngineFor(path)
    const candidate = engine.detect("Remember that the staging URL is staging.imutechz.in")[0]!
    expect(candidate).toBeDefined()
    expect(candidate.explicit).toBe(true)
    engine.learn(candidate, 0.9)
    await engine.save()

    const reloaded = await NoteEngine.load(path)
    const again = reloaded.detect("Remember that the staging URL is staging.imutechz.in")[0]
    expect(again).toBeDefined()
    expect(again!.explicit).toBe(true)
  })

  test("a corrupt state file falls back to the priors instead of crashing", async () => {
    const path = join(home, "note.json")
    await Bun.write(path, "not json at all")
    const engine = await NoteEngine.load(path)
    expect(engine.detect("Always use tabs in this repo.").length).toBeGreaterThan(0)
  })

  test("a state file from another version is ignored", async () => {
    const path = join(home, "note.json")
    await Bun.write(path, JSON.stringify({ version: 999, durable: { version: 1, trained: 1, weights: {} } }))
    const engine = await NoteEngine.load(path)
    expect(engine.detect("Always use tabs in this repo.").length).toBeGreaterThan(0)
  })
})

describe("merging", () => {
  const record = (text: string, kind: MemoryRecord["kind"] = "user_style"): MemoryRecord => ({
    id: "mem_1",
    kind,
    text,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    usageCount: 0,
  })

  test("the same rule said twice is one note", () => {
    const existing = record("Always use tabs in this repository")
    const found = findNearDuplicate({ kind: "user_style", text: "always use tabs in this repository" }, [existing])
    expect(found).toBeDefined()
  })

  test("an unrelated note is not merged", () => {
    const existing = record("Always use tabs in this repository")
    const found = findNearDuplicate({ kind: "user_style", text: "Deploys happen on Friday evenings" }, [existing])
    expect(found).toBeUndefined()
  })

  test("a note of a different kind is not merged", () => {
    const existing = record("Always use tabs in this repository", "user_style")
    const found = findNearDuplicate({ kind: "fact", text: "always use tabs in this repository" }, [existing])
    expect(found).toBeUndefined()
  })

  test("the store writes it once, however many times it is repeated", async () => {
    const store = new MemoryStore()
    await rememberMessage(store, "Always use tabs.", { learnStyle: true })
    await rememberMessage(store, "Always use tabs.", { learnStyle: true })
    const notes = await store.all()
    expect(notes.filter((note) => note.kind === "user_style")).toHaveLength(1)
  })
})

describe("retention", () => {
  test("every kind has a half-life, and credentials outlive everything", () => {
    expect(KIND_HALF_LIFE_DAYS.credential).toBeGreaterThan(KIND_HALF_LIFE_DAYS.fact)
    expect(KIND_HALF_LIFE_DAYS.fact).toBeGreaterThan(KIND_HALF_LIFE_DAYS.todo)
    expect(KIND_HALF_LIFE_DAYS.todo).toBeGreaterThan(0)
  })

  test("a fresh note outranks an old one of the same kind", () => {
    const now = Date.now()
    const fresh = { kind: "fact" as const, updatedAt: now, usageCount: 0 }
    const old = { kind: "fact" as const, updatedAt: now - 400 * 86_400_000, usageCount: 0 }
    expect(retentionScore(fresh)).toBeGreaterThan(retentionScore(old))
  })

  test("use promotes a note", () => {
    const now = Date.now()
    const unused = { kind: "fact" as const, updatedAt: now - 200 * 86_400_000, usageCount: 0 }
    const used = { ...unused, usageCount: 12 }
    expect(retentionScore(used)).toBeGreaterThan(retentionScore(unused))
  })

  test("the score never goes negative and never overflows", () => {
    const ancient = { kind: "fact" as const, updatedAt: 0, usageCount: 0 }
    const score = retentionScore(ancient)
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeGreaterThanOrEqual(0)
  })
})

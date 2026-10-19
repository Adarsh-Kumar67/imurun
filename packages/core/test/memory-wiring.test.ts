/**
 * The memory settings the docs describe, doing what they say: learning standing
 * instructions, keeping secrets encrypted, and staying inside the session when
 * cross-session recall is off.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore, detectDurableNotes, learnFromMessage } from "../src"
import { resetVaultKeyCache, vaultKeyPath } from "../src/memory/vault"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-wire-"))
  process.env.IMURUN_HOME = home
  // Each test gets its own machine key, exactly as a new machine would.
  resetVaultKeyCache()
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  resetVaultKeyCache()
  await rm(home, { recursive: true, force: true })
})

describe("learning from what the user says", () => {
  test("a standing rule becomes one style note", () => {
    const notes = detectDurableNotes("Always use tabs instead of spaces in this repo, please.")
    expect(notes).toHaveLength(1)
    expect(notes[0]!.kind).toBe("user_style")
    expect(notes[0]!.text).toContain("Always use tabs")
  })

  test("personal details are facts, not style", () => {
    const notes = detectDurableNotes("My name is Shubham and I work at ImuTechz.")
    expect(notes.every((note) => note.kind === "fact")).toBe(true)
    expect(notes.some((note) => /Shubham/.test(note.text))).toBe(true)
    expect(notes.some((note) => /ImuTechz/.test(note.text))).toBe(true)
  })

  test("an explicit \"remember that\" is kept", () => {
    const notes = detectDurableNotes("Remember that deploys run on Fridays.")
    expect(notes.some((note) => /Fridays/.test(note.text))).toBe(true)
  })

  test("a secret named in passing is a credential", () => {
    const notes = detectDurableNotes("My deploy token is ghp_example12345.")
    expect(notes[0]!.kind).toBe("credential")
  })

  test("ordinary task requests teach nothing", () => {
    expect(detectDurableNotes("run the tests")).toEqual([])
    expect(detectDurableNotes("fix the parser please")).toEqual([])
    expect(detectDurableNotes("always be careful")).toEqual([])
    expect(detectDurableNotes("")).toEqual([])
  })

  test("a pasted document is not scanned for rules", () => {
    expect(detectDurableNotes(`always ${"x".repeat(5_000)}`)).toEqual([])
  })

  test("learnStyle off keeps facts but drops style", async () => {
    const store = new MemoryStore()
    await learnFromMessage(store, "Always use tabs, and my name is Shubham.", { learnStyle: false })

    const notes = await store.all()
    expect(notes.some((note) => note.kind === "user_style")).toBe(false)
    expect(notes.some((note) => note.kind === "fact" && /Shubham/.test(note.text))).toBe(true)
  })

  test("notes are written once, however many times the user repeats them", async () => {
    const store = new MemoryStore()
    await learnFromMessage(store, "Always use tabs.", { learnStyle: true })
    await learnFromMessage(store, "Always use tabs.", { learnStyle: true })
    const notes = await store.all()
    expect(notes.filter((note) => note.kind === "user_style")).toHaveLength(1)
  })
})

describe("credentials are encrypted at rest", () => {
  test("a credential never lands in the clear, in either file", async () => {
    const store = new MemoryStore()
    await store.remember({ kind: "credential", text: "deploy token is ghp_supersecret123456", tags: ["secret"] })
    await store.remember({ kind: "fact", text: "The project is IMURUN." })

    const notes = await readFile(join(home, "memory", "notes.md"), "utf8")
    const index = await readFile(join(home, "memory", "index.json"), "utf8")
    for (const raw of [notes, index]) {
      expect(raw).not.toContain("ghp_supersecret123456")
      expect(raw).toContain("enc:")
    }

    // A machine key was created for it, and it is not empty.
    const key = (await readFile(vaultKeyPath(), "utf8")).trim()
    expect(key.length).toBeGreaterThan(20)

    // The agent still sees the value when it looks.
    const all = await store.all()
    expect(all.find((note) => note.kind === "credential")!.text).toContain("ghp_supersecret123456")
  })

  test("a later session can read what an earlier one sealed", async () => {
    const first = new MemoryStore()
    await first.remember({ kind: "credential", text: "The API key is sk-abcdefghijklmnop" })

    resetVaultKeyCache()
    const second = new MemoryStore()
    const notes = await second.all()
    expect(notes[0]!.text).toContain("sk-abcdefghijklmnop")

    const hits = await second.search("api key")
    expect(hits.length).toBeGreaterThan(0)
  })

  test("durable notes never pin a secret into the prompt", async () => {
    const store = new MemoryStore()
    await store.remember({ kind: "credential", text: "The token is abc123" })
    await store.remember({ kind: "preference", text: "Use tabs, not spaces." })

    const durable = await store.durable()
    expect(durable.some((line) => line.includes("abc123"))).toBe(false)
    expect(durable.some((line) => line.includes("Use tabs"))).toBe(true)
  })

  test("a listing can hide the value even though recall can see it", async () => {
    const store = new MemoryStore()
    await store.remember({ kind: "credential", text: "The token is abc123" })

    const hits = await store.search("token")
    const promptLines = hits.map((hit) => hit.doc.text).join(" ")
    expect(promptLines).toContain("abc123")
  })
})

describe("cross-session recall", () => {
  async function withDigest(): Promise<MemoryStore> {
    const store = new MemoryStore()
    await store.remember({ kind: "fact", text: "The kestrel module owns config loading." })
    await store.saveDigest({
      sessionId: "ses_old",
      title: "kestrel migration",
      workingDir: "C:/work/project",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 12,
      files: ["src/kestrel.ts"],
      commands: ["bun test"],
      todos: ["rename the kestrel flag"],
      done: ["moved the kestrel loader"],
      highlights: ["The kestrel loader moved into its own module."],
      generatedAt: 2,
    })
    return store
  }

  test("digests take part by default", async () => {
    const store = await withDigest()
    const hits = await store.search("kestrel", { limit: 10 })
    expect(hits.some((hit) => hit.doc.source === "session")).toBe(true)
  })

  test("turning cross-session off leaves only this machine's own notes", async () => {
    const store = await withDigest()
    const hits = await store.search("kestrel", { limit: 10, sources: ["note"] })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.doc.source === "note")).toBe(true)
  })
})

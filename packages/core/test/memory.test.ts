import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planCompaction } from "../src/agent/context"
import { bm25Search, tokenize, type SearchDoc } from "../src/memory/search"
import { MemoryStore } from "../src/memory/store"
import { buildDigest, digestToMarkdown, extractDone, extractTodos } from "../src/memory/summarize"
import type { Message } from "@imurun/schema"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-mem-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
})

function message(partial: Partial<Message> & { role: Message["role"]; content: string }): Message {
  return {
    id: partial.id ?? `msg_${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "ses_test",
    createdAt: Date.now(),
    ...partial,
  } as Message
}

const session = {
  id: "ses_test",
  sessionId: "ses_test",
  title: "Fix the parser",
  workingDir: "C:/work/project",
  model: "local/qwen2.5-coder-7b",
  createdAt: 1,
  updatedAt: 2,
}

describe("todo extraction", () => {
  test("finds unfinished work in several shapes", () => {
    const text = [
      "Here is the plan:",
      "- [ ] wire up the API client",
      "TODO: add retry logic",
      "Next step: write tests for the parser",
      "- [x] read the existing code",
    ].join("\n")
    expect(extractTodos(text)).toEqual(["wire up the API client", "add retry logic", "write tests for the parser"])
  })

  test("finds completed work separately", () => {
    expect(extractDone("- [x] read the existing code\nDONE: extracted the parser")).toEqual([
      "read the existing code",
      "extracted the parser",
    ])
  })

  test("does not mistake ordinary prose for a task or a completion", () => {
    // "Next step" / "Done" only count when they carry a colon (or a checkbox),
    // so a sentence that merely starts with those words stays out of the lists.
    expect(extractTodos("Next I will read the file, then edit it.")).toEqual([])
    expect(extractDone("Done \u2014 I created hello.txt with a greeting.")).toEqual([])
    expect(extractDone("- Done that already")).toEqual([])
  })
})

describe("buildDigest", () => {
  test("collects files, commands and highlights", () => {
    const messages: Message[] = [
      message({ role: "user", content: "please fix src/parser.ts" }),
      message({
        role: "assistant",
        content: "Let me look at the parser.",
        toolCalls: [
          { id: "1", name: "read", args: { path: "src/parser.ts" } },
          { id: "2", name: "shell", args: { command: "bun test" } },
        ],
      }),
      message({ role: "tool", content: "ok" }),
      message({ role: "assistant", content: "- [ ] handle the empty-input case" }),
    ]

    const digest = buildDigest({ ...session, messages })
    expect(digest.files).toContain("src/parser.ts")
    expect(digest.commands).toContain("bun test")
    expect(digest.highlights[0]).toBe("Let me look at the parser.")
    expect(digest.todos).toContain("handle the empty-input case")
    expect(digest.upToMessageId).toBe(messages[messages.length - 1]!.id)
  })

  test("carries unresolved todos forward from the previous digest", () => {
    const first = buildDigest({
      ...session,
      messages: [message({ role: "assistant", content: "- [ ] ship the release" })],
    })
    const second = buildDigest({
      ...session,
      messages: [message({ role: "user", content: "unrelated chatter" })],
      previous: first,
    })
    expect(second.todos).toContain("ship the release")
  })

  test("drops a carried todo once it is marked done", () => {
    const first = buildDigest({
      ...session,
      messages: [message({ role: "assistant", content: "- [ ] ship the release" })],
    })
    const second = buildDigest({
      ...session,
      messages: [message({ role: "assistant", content: "- [x] ship the release" })],
      previous: first,
    })
    expect(second.todos).not.toContain("ship the release")
    expect(second.done).toContain("ship the release")
  })

  test("markdown rendering has real sections", () => {
    const digest = buildDigest({
      ...session,
      messages: [
        message({ role: "assistant", content: "done", toolCalls: [{ id: "1", name: "read", args: { path: "a.ts" } }] }),
      ],
    })
    const md = digestToMarkdown(digest)
    expect(md).toContain("# Fix the parser")
    expect(md).toContain("## Files touched")
    expect(md).toContain("`a.ts`")
  })
})

describe("MemoryStore", () => {
  test("remembers notes and mirrors them into notes.md", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "the user prefers tabs", kind: "preference", tags: ["style"] })
    await store.remember({ text: "auth lives in src/auth.ts", kind: "fact" })

    const notes = await store.all()
    expect(notes).toHaveLength(2)

    const raw = await Bun.file(join(home, "memory", "notes.md")).text()
    expect(raw).toContain("[preference] the user prefers tabs")
    expect(raw).toContain("tags: style")
    expect(raw).toContain("[fact] auth lives in src/auth.ts")
  })

  test("merges an identical note instead of duplicating it", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "same thing", kind: "fact" })
    await store.remember({ text: "same thing", tags: ["extra"] })
    const notes = await store.all()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.tags).toContain("extra")
  })

  test("rebuilds the index from notes.md when the index is lost", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "keep me around", kind: "fact", tags: ["a"] })
    await rm(join(home, "memory", "index.json"))

    const rebuilt = new MemoryStore()
    const notes = await rebuilt.all()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toBe("keep me around")
    expect(notes[0]!.kind).toBe("fact")
  })

  test("forgets by fragment", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "temporary note about bananas" })
    expect(await store.forget("bananas")).toBe(1)
    expect(await store.all()).toHaveLength(0)
  })

  test("search ranks the relevant note first", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "the project uses bun and typescript" })
    await store.remember({ text: "the deployment runs on fly.io in frankfurt" })
    const hits = await store.search("where does the deployment run", { limit: 2 })
    expect(hits[0]!.doc.text).toContain("deployment")
  })

  test("durable() returns pinned notes but not plain notes", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "prefers tabs", kind: "preference" })
    await store.remember({ text: "just an observation", kind: "note" })
    const durable = await store.durable("C:/work/project")
    expect(durable).toEqual(["(preference) prefers tabs"])
  })

  test("writes a session digest to a markdown file", async () => {
    const store = new MemoryStore()
    const messages: Message[] = [
      message({ role: "user", content: "add tests" }),
      message({ role: "assistant", content: "- [ ] cover the error path" }),
    ]
    const digest = await store.summarize(session, messages)

    expect(await Bun.file(store.sessionFile(digest.sessionId)).exists()).toBe(true)
    expect((await store.getDigest(session.id))?.todos).toContain("cover the error path")
    expect(await store.openTodos(session.workingDir)).toContain("cover the error path")
    expect((await store.stats()).sessions).toBe(1)
  })

  test("remembers todos across sessions for the same project", async () => {
    const store = new MemoryStore()
    await store.summarize(session, [message({ role: "assistant", content: "TODO: migrate the config loader" })])
    await store.remember({ text: "rotate the signing key", kind: "todo", projectPath: session.workingDir })

    const todos = await store.openTodos(session.workingDir)
    expect(todos).toContain("migrate the config loader")
    expect(todos).toContain("rotate the signing key")

    // a different project does not inherit them
    expect(await store.openTodos("D:/elsewhere")).not.toContain("migrate the config loader")
  })

  test("ignores a corrupt index file", async () => {
    const store = new MemoryStore()
    await store.remember({ text: "survives corruption" })
    await writeFile(join(home, "memory", "index.json"), "{ not json")

    const rebuilt = new MemoryStore()
    const notes = await rebuilt.all()
    expect(notes.map((note) => note.text)).toContain("survives corruption")
  })
})

describe("bm25Search", () => {
  const docs: SearchDoc[] = [
    { id: "1", text: "the parser handles nested expressions", kind: "note", source: "note", updatedAt: 1 },
    { id: "2", text: "deploy pipeline uses github actions", kind: "note", source: "note", updatedAt: 2 },
    { id: "3", text: "todo fix the parser recursion bug", kind: "todo", source: "note", updatedAt: 3 },
  ]

  test("tokenize drops stopwords and short tokens", () => {
    expect(tokenize("The parser is a very good tool")).toEqual(["parser", "good", "tool"])
  })

  test("ranks matching documents", () => {
    const hits = bm25Search(docs, "parser", { limit: 3 })
    expect(hits.length).toBe(2)
    expect(new Set(hits.map((hit) => hit.doc.id))).toEqual(new Set(["1", "3"]))
  })

  test("boosts todos and the active project", () => {
    const projectDocs: SearchDoc[] = [
      { id: "a", text: "parser project alpha", kind: "note", source: "note", updatedAt: 1, projectPath: "C:/one" },
      { id: "b", text: "parser project beta", kind: "note", source: "note", updatedAt: 2, projectPath: "C:/two" },
    ]
    const hits = bm25Search(projectDocs, "parser", { limit: 2, projectPath: "C:/two" })
    expect(hits[0]!.doc.id).toBe("b")
  })

  test("falls back to recency for an empty query", () => {
    const hits = bm25Search(docs, "", { limit: 1 })
    expect(hits[0]!.doc.id).toBe("3")
  })

  test("returns nothing for an empty corpus", () => {
    expect(bm25Search([], "anything")).toEqual([])
  })
})

describe("planCompaction", () => {
  function history(count: number, charsEach = 100): Message[] {
    return Array.from({ length: count }, (_, i) =>
      message({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(charsEach) }),
    )
  }

  test("keeps everything when the history fits", () => {
    const plan = planCompaction(history(4), { maxChars: 10_000, minMessages: 2 })
    expect(plan.dropped).toHaveLength(0)
    expect(plan.kept).toHaveLength(4)
    expect(plan.upToMessageId).toBeUndefined()
  })

  test("drops the oldest messages and records the watermark", () => {
    const plan = planCompaction(history(10), { maxChars: 500, minMessages: 2 })
    expect(plan.dropped.length).toBeGreaterThan(0)
    expect(plan.kept.length).toBeLessThan(10)
    expect(plan.upToMessageId).toBe(plan.dropped[plan.dropped.length - 1]!.id)
    expect(plan.droppedChars).toBeGreaterThan(0)
    // order is preserved
    expect(plan.kept[0]!.id).toBe(`m${plan.dropped.length}`)
  })

  test("always keeps at least minMessages", () => {
    const plan = planCompaction(history(6), { maxChars: 1, minMessages: 4 })
    expect(plan.kept.length).toBeGreaterThanOrEqual(4)
  })

  test("honours maxMessages", () => {
    const plan = planCompaction(history(30), { maxChars: 10_000_000, maxMessages: 10 })
    expect(plan.kept.length).toBe(10)
    expect(plan.dropped.length).toBe(20)
  })
})

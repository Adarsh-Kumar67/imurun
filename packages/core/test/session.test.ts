import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImurunDatabase, SessionStore, deriveTitle } from "../src"

async function freshStore(): Promise<{ store: ImurunDatabase; sessions: SessionStore; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "imurun-db-"))
  const store = await ImurunDatabase.open(join(dir, "test.db"))
  return { store, sessions: new SessionStore(store), dir }
}

describe("database", () => {
  test("migrations run once and are idempotent", async () => {
    const { store, dir } = await freshStore()
    const migrations = store.sqlite
      .query<{ id: string }, []>("SELECT id FROM _migrations")
      .all()
      .map((r) => r.id)
    expect(migrations).toContain("001_init")
    store.close()

    const reopened = await ImurunDatabase.open(join(dir, "test.db"))
    const after = reopened.sqlite
      .query<{ id: string }, []>("SELECT id FROM _migrations")
      .all()
      .map((r) => r.id)
    expect(after).toEqual(migrations)
    reopened.close()
  })

  test("kv helpers round trip", async () => {
    const { store } = await freshStore()
    store.set("theme", "dark")
    expect(store.get("theme")).toBe("dark")
    store.setJson("recent", { ids: [1, 2] })
    expect(store.getJson<{ ids: number[] }>("recent")).toEqual({ ids: [1, 2] })
    store.deleteKey("theme")
    expect(store.get("theme")).toBeUndefined()
    store.close()
  })

  test("project databases are isolated per working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imurun-projdb-"))
    const prevHome = process.env.IMURUN_HOME
    process.env.IMURUN_HOME = dir
    try {
      const a = await ImurunDatabase.openProject("C:\\proj-a")
      const b = await ImurunDatabase.openProject("C:\\proj-b")
      expect(a.path).not.toBe(b.path)
      a.close()
      b.close()

      const a2 = await ImurunDatabase.openProject("c:/proj-a")
      expect(a2.path).toBe(a.path)
      a2.close()
    } finally {
      process.env.IMURUN_HOME = prevHome
    }
  })
})

describe("sessions", () => {
  test("create / get / list lifecycle", async () => {
    const { store, sessions } = await freshStore()

    const s1 = sessions.create({ workingDir: "C:\\proj" })
    expect(s1.title).toBe("New session")
    expect(s1.messageCount).toBe(0)

    const got = sessions.get(s1.id)
    expect(got?.id).toBe(s1.id)

    sessions.create({ workingDir: "C:\\proj", title: "Second" })
    const list = sessions.list()
    expect(list).toHaveLength(2)
    expect(list[0]!.id).not.toBe(s1.id) // newest first

    sessions.delete(s1.id)
    expect(sessions.get(s1.id)).toBeUndefined()
    store.close()
  })

  test("first user message becomes the session title", async () => {
    const { store, sessions } = await freshStore()
    const s = sessions.create({ workingDir: "C:\\proj" })
    sessions.addMessage({
      sessionId: s.id,
      role: "user",
      content: "fix the login bug in auth.ts please",
    })
    const updated = sessions.get(s.id)
    expect(updated?.title).toBe("fix the login bug in auth.ts please")
    expect(updated?.messageCount).toBe(1)
    store.close()
  })

  test("messages persist with tool calls, usage and metadata round trip", async () => {
    const { store, sessions } = await freshStore()
    const s = sessions.create({ workingDir: "C:\\proj" })

    sessions.addMessage({ sessionId: s.id, role: "user", content: "read auth.ts" })
    sessions.addMessage({
      sessionId: s.id,
      role: "assistant",
      content: "Checking now",
      toolCalls: [{ id: "call_1", name: "read", args: { path: "auth.ts" } }],
      usage: { inputTokens: 120, outputTokens: 30, cost: 0 },
      metadata: {
        model: "qwen2.5-coder-7b",
        ragSources: [{ path: "src/auth.ts", start: 10, end: 42, score: 4.5 }],
      },
    })
    sessions.addMessage({
      sessionId: s.id,
      role: "tool",
      content: "file contents here",
      toolCallId: "call_1",
    })

    const messages = sessions.getMessages(s.id)
    expect(messages).toHaveLength(3)
    expect(messages[1]!.toolCalls?.[0]!.name).toBe("read")
    expect(messages[1]!.usage?.inputTokens).toBe(120)
    expect(messages[1]!.metadata?.ragSources?.[0]!.path).toBe("src/auth.ts")
    expect(messages[1]!.metadata?.ragSources?.[0]!.start).toBe(10)
    expect(messages[2]!.toolCallId).toBe("call_1")

    const session = sessions.get(s.id)
    expect(session?.messageCount).toBe(3)
    expect(session?.totalInputTokens).toBe(120)
    expect(session?.totalOutputTokens).toBe(30)
    store.close()
  })

  test("getRecentMessages returns newest in chronological order", async () => {
    const { store, sessions } = await freshStore()
    const s = sessions.create({ workingDir: "C:\\proj" })
    for (let i = 1; i <= 10; i++) {
      sessions.addMessage({ sessionId: s.id, role: "user", content: `message ${i}` })
    }
    const recent = sessions.getRecentMessages(s.id, 3)
    expect(recent.map((m) => m.content)).toEqual(["message 8", "message 9", "message 10"])
    store.close()
  })

  test("deleting a session cascades to messages", async () => {
    const { store, sessions } = await freshStore()
    const s = sessions.create({ workingDir: "C:\\proj" })
    sessions.addMessage({ sessionId: s.id, role: "user", content: "hello" })
    sessions.delete(s.id)

    const rows = store.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages")
      .get()
    expect(rows?.n).toBe(0)
    store.close()
  })

  test("update applies title/model/summary/topics", async () => {
    const { store, sessions } = await freshStore()
    const s = sessions.create({ workingDir: "C:\\proj" })
    sessions.update(s.id, { title: "Auth refactor", summary: "Moved to JWT", topics: ["auth", "jwt"] })

    const updated = sessions.get(s.id)
    expect(updated?.title).toBe("Auth refactor")
    expect(updated?.summary).toBe("Moved to JWT")
    expect(updated?.topics).toEqual(["auth", "jwt"])
    store.close()
  })

  test("latest scopes to working dir", async () => {
    const { store, sessions } = await freshStore()
    sessions.create({ workingDir: "C:\\proj-a", title: "A" })
    sessions.create({ workingDir: "C:\\proj-b", title: "B" })

    expect(sessions.latest("C:\\proj-a")?.title).toBe("A")
    expect(sessions.latest("c:/proj-b/")?.title).toBe("B")
    store.close()
  })
})

describe("deriveTitle", () => {
  test("collapses whitespace and truncates", () => {
    expect(deriveTitle("  fix   the\n login bug ")).toBe("fix the login bug")
    expect(deriveTitle("")).toBe("New session")
    expect(deriveTitle("x".repeat(100)).length).toBeLessThanOrEqual(60)
  })
})

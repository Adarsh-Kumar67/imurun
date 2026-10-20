import { describe, expect, test } from "bun:test"
import { contextBar, formatTokens, sidebarLines, sidebarSummary, tailPath, type SidebarState } from "../src/sidebar"
import { stripAnsi, visibleWidth } from "../src/text"

const state: SidebarState = {
  width: 26,
  model: "qwen2.5-coder-7b",
  agent: "build",
  session: "ses_9f2c1a4b",
  workingDir: "C:/Users/imu/Desktop/ImuTechz/IMU CLI",
  permissions: "manual",
  context: { used: 13_700, max: 32_768 },
  todos: [
    { title: "finish the sidebar", status: "doing" },
    { title: "write the README", status: "open" },
  ],
  queue: 2,
  busy: true,
}

describe("formatTokens", () => {
  test("is compact and readable", () => {
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(8500)).toBe("8.5k")
    expect(formatTokens(32_768)).toBe("33k")
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(-5)).toBe("0")
  })
})

describe("contextBar", () => {
  test("fills to the percentage and reports it", () => {
    const half = contextBar(50, 100, 20)
    expect(half.percent).toBe(50)
    expect(visibleWidth(half.bar)).toBe(20)
    const full = contextBar(200, 100, 10)
    expect(full.percent).toBe(100)
    expect(visibleWidth(full.bar)).toBe(10)
  })

  test("handles a zero budget", () => {
    expect(contextBar(1, 0, 10).percent).toBe(0)
  })
})

describe("tailPath", () => {
  test("keeps the identifying end of a path", () => {
    expect(tailPath("short", 20)).toBe("short")
    expect(tailPath("C:/Users/imu/some/deep/path", 12)).toBe("\u2026e/deep/path")
  })
})

describe("sidebarLines", () => {
  test("every line fits the panel width", () => {
    for (const line of sidebarLines(state)) expect(visibleWidth(line)).toBe(26)
  })

  test("shows the sections and their values", () => {
    const plain = sidebarLines(state).map(stripAnsi).join("\n")
    expect(plain).toContain("CONTEXT")
    expect(plain).toContain("42%")
    expect(plain).toContain("AGENT")
    expect(plain).toContain("build")
    expect(plain).toContain("MODEL")
    expect(plain).toContain("qwen2.5-coder-7b")
    expect(plain).toContain("PERMISSIONS")
    expect(plain).toContain("manual")
    expect(plain).toContain("DIRECTORY")
    expect(plain).toContain("SESSION")
    expect(plain).toContain("TODOS  0/2")
    expect(plain).toContain("finish the sidebar")
    expect(plain).toContain("QUEUED  2")
  })

  test("omits todos and the queue when there are none", () => {
    const plain = sidebarLines({ ...state, todos: [], queue: 0, busy: false }).map(stripAnsi).join("\n")
    expect(plain).not.toContain("TODOS")
    expect(plain).not.toContain("QUEUED")
  })

  test("says so when no model is loaded", () => {
    const plain = sidebarLines({ ...state, model: undefined, context: undefined }).map(stripAnsi).join("\n")
    expect(plain).toContain("none")
    expect(plain).toContain("not loaded")
  })

  test("says the window is unknown rather than inventing one", () => {
    const plain = sidebarLines({ ...state, context: { used: 13_700 } }).map(stripAnsi).join("\n")
    expect(plain).toContain("14k tok used")
    expect(plain).toContain("window unknown")
    expect(plain).not.toContain("33k")
    expect(stripAnsi(sidebarSummary({ ...state, context: { used: 13_700 } }))).toContain("ctx unknown")
  })

  test("a real window is shown as a bar with a percentage", () => {
    const plain = sidebarLines({ ...state, context: { used: 65_536, max: 131_072 } }).map(stripAnsi).join("\n")
    expect(plain).toContain("50%")
    expect(plain).toContain("66k / 131k tok")
  })

  test("shows the written plan's progress when there is one", () => {
    const withPlan = sidebarLines({ ...state, plan: { done: 2, total: 5 } }).map(stripAnsi).join("\n")
    expect(withPlan).toContain("PLAN")
    expect(withPlan).toContain("2/5 steps")

    const finished = sidebarLines({ ...state, plan: { done: 5, total: 5 } }).map(stripAnsi).join("\n")
    expect(finished).toContain("5/5 steps")

    expect(sidebarLines(state).map(stripAnsi).join("\n")).not.toContain("PLAN")
  })

  test("todos show a tick, a half tick, or an empty box", () => {
    const plain = sidebarLines({
      ...state,
      todos: [
        { title: "finished", status: "done" },
        { title: "in flight", status: "doing" },
        { title: "not started", status: "open" },
      ],
    })
      .map(stripAnsi)
      .join("\n")
    expect(plain).toContain("\u2611 finished")
    expect(plain).toContain("\u25d0 in flight")
    expect(plain).toContain("\u2610 not started")
    expect(plain).toContain("TODOS  1/3")
  })

  test("work in progress is listed above what has not started, and done goes last", () => {
    const lines = sidebarLines({
      ...state,
      todos: [
        { title: "done one", status: "done" },
        { title: "later", status: "open" },
        { title: "now", status: "doing" },
      ],
    }).map(stripAnsi)
    const order = lines.filter((line) => /done one|later|now/.test(line))
    expect(order[0]).toContain("now")
    expect(order[1]).toContain("later")
    expect(order[2]).toContain("done one")
  })

  test("a long plan is summarised, not truncated mid-list", () => {
    const todos = Array.from({ length: 9 }, (_, index) => ({ title: `step ${index}`, status: "open" as const }))
    const plain = sidebarLines({ ...state, todos }).map(stripAnsi).join("\n")
    expect(plain).toContain("TODOS  0/9")
    expect(plain).toContain("+3 more")
  })

  test("the index's sources are named, so the answer's provenance is visible", () => {
    const plain = sidebarLines({
      ...state,
      sources: [
        { path: "packages/tui/src/app.ts", start: 120, end: 160, score: 9.1 },
        { path: "packages/core/src/agent/agent.ts", start: 300, end: 330, score: 7.4 },
      ],
    })
      .map(stripAnsi)
      .join("\n")

    expect(plain).toContain("SOURCES  2")
    expect(plain).toContain("app.ts:120")
    expect(plain).toContain("agent.ts:300")
    // Absent when the turn used none, or when config hides them.
    expect(sidebarLines(state).map(stripAnsi).join("\n")).not.toContain("SOURCES")
  })

  test("memory is reported only when the setting asks for it", () => {
    const withMemory = sidebarLines({ ...state, memory: { notes: 12, sessions: 3 } }).map(stripAnsi).join("\n")
    expect(withMemory).toContain("MEMORY")
    expect(withMemory).toContain("12 note(s) \u00b7 3 session(s)")

    // Nothing remembered yet: no empty section.
    const empty = sidebarLines({ ...state, memory: { notes: 0, sessions: 0 } }).map(stripAnsi).join("\n")
    expect(empty).not.toContain("MEMORY")

    expect(sidebarLines(state).map(stripAnsi).join("\n")).not.toContain("MEMORY")
  })

  test("the vault's health appears beside the notes, and asks for a tidy when it is low", () => {
    const healthy = sidebarLines({ ...state, memory: { notes: 2, sessions: 1, vault: 92, vaultCards: 8 } })
      .map(stripAnsi)
      .join("\n")
    expect(healthy).toContain("2 note(s) \u00b7 1 session(s)")
    expect(healthy).toContain("vault 92")
    expect(healthy).not.toContain("tidy")

    const untidy = sidebarLines({ ...state, memory: { notes: 0, sessions: 0, vault: 41, vaultCards: 3 } })
      .map(stripAnsi)
      .join("\n")
    expect(untidy).toContain("vault 41 \u2014 tidy")

    // An empty vault is not a health problem, so it adds no line of its own.
    const emptyVault = sidebarLines({ ...state, memory: { notes: 0, sessions: 0, vault: 100, vaultCards: 0 } })
      .map(stripAnsi)
      .join("\n")
    expect(emptyVault).not.toContain("MEMORY")
  })
})

describe("sidebarSummary", () => {
  test("summarises the panel in one line", () => {
    const summary = stripAnsi(sidebarSummary(state))
    expect(summary).toContain("agent build")
    expect(summary).toContain("model qwen2.5-coder-7b")
    expect(summary).toContain("perm manual")
    expect(summary).toContain("ctx 42%")
    expect(summary).toContain("2 todo(s)")
    expect(summary).toContain("2 queued")
  })
})

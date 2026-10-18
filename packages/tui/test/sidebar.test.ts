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
  todos: ["finish the sidebar", "write the README"],
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
    expect(plain).toContain("TODOS  2")
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

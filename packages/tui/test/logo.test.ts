import { describe, expect, test } from "bun:test"
import { COMPACT_WIDTH, LOGO_WIDTH, creditLine, logoLines, renderWordmark, welcomeLines } from "../src/logo"
import { stripAnsi, visibleWidth } from "../src/text"

describe("logo", () => {
  test("the big wordmark is a rectangle", () => {
    const art = logoLines()
    expect(art.length).toBeGreaterThan(3)
    for (const line of art) expect(visibleWidth(line)).toBe(LOGO_WIDTH)
  })

  test("the letter I is painted red", () => {
    // chalk wraps the first three columns in a red escape
    const first = logoLines()[0]!
    expect(first).toContain("\u001b[31m")
    expect(stripAnsi(first).startsWith("\u2588\u2588\u2557")).toBe(true)
  })

  test("renderWordmark falls back to the compact form on a narrow screen", () => {
    const big = renderWordmark(LOGO_WIDTH)
    const small = renderWordmark(COMPACT_WIDTH)
    expect(big).toHaveLength(logoLines().length)
    expect(small.length).toBeLessThan(big.length)
    for (const line of small) expect(visibleWidth(line)).toBeLessThanOrEqual(COMPACT_WIDTH)
  })

  test("the credit marks the I and the T", () => {
    const plain = stripAnsi(creditLine())
    expect(plain).toBe("by ImuTechz")
    // two red glyphs inside an otherwise dim string
    const reds = creditLine().match(/\u001b\[31m/g) ?? []
    expect(reds.length).toBe(2)
  })

  test("the welcome carries the wordmark, credit and environment", () => {
    const lines = welcomeLines({
      width: 100,
      version: "0.1.0",
      model: "local/qwen2.5-coder-7b",
      agent: "build",
      workingDir: "C:/work/project",
    })
    const plain = lines.map(stripAnsi).join("\n")
    expect(plain).toContain("by ImuTechz")
    expect(plain).toContain("qwen2.5-coder-7b")
    expect(plain).toContain("build")
    expect(plain).toContain("C:/work/project")
    expect(plain).toContain("/")
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100)
  })

  test("the welcome still fits on a narrow terminal", () => {
    const lines = welcomeLines({ width: 40, version: "0.1.0", model: "m", agent: "build", workingDir: "C:/w" })
    const plain = lines.map(stripAnsi).join("\n")
    expect(plain).toContain("by ImuTechz")
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })
})

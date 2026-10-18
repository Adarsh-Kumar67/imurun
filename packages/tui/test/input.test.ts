import { describe, expect, test } from "bun:test"
import { fitInput } from "../src/app"

describe("fitInput", () => {
  test("leaves short input untouched", () => {
    expect(fitInput("hello", 5, 20)).toEqual({ text: "hello", cursor: 5, start: 0 })
  })

  test("keeps the cursor visible when typing past the right edge", () => {
    const { text, cursor } = fitInput("abcdefghijklmnop", 16, 10)
    expect(text).toHaveLength(10)
    expect(cursor).toBe(10)
    expect(text).toContain("p")
  })

  test("shows a leading ellipsis when scrolled", () => {
    const { text } = fitInput("abcdefghijklmnop", 16, 10)
    expect(text.startsWith("\u2026")).toBe(true)
  })

  test("scrolls back so the cursor stays in view at the start", () => {
    const { text, cursor } = fitInput("abcdefghijklmnop", 0, 10)
    expect(text).not.toContain("\u2026")
    expect(cursor).toBe(0)
  })

  test("never returns a negative slice or an out-of-range cursor", () => {
    for (const max of [1, 2, 3, 8]) {
      for (const cursor of [0, 1, 5, 50, -3]) {
        const { text, cursor: c } = fitInput("abcdefghijklmnopqrstuvwxyz", cursor, max)
        expect(text.length).toBeLessThanOrEqual(Math.max(1, max))
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(text.length)
      }
    }
  })
})

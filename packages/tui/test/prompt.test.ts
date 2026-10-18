import { describe, expect, test } from "bun:test"
import { buildPromptBox, caretPosition, promptRowCount } from "../src/prompt"
import { stripAnsi, visibleWidth } from "../src/text"

describe("caretPosition", () => {
  test("maps an index to a line and column", () => {
    expect(caretPosition("abc", 1)).toEqual({ row: 0, col: 1 })
    expect(caretPosition("ab\ncd", 4)).toEqual({ row: 1, col: 1 })
    expect(caretPosition("ab\ncd", 5)).toEqual({ row: 1, col: 2 })
  })

  test("clamps out-of-range indices", () => {
    expect(caretPosition("ab", 99)).toEqual({ row: 0, col: 2 })
    expect(caretPosition("ab", -5)).toEqual({ row: 0, col: 0 })
  })
})

describe("promptRowCount", () => {
  test("counts explicit lines and clamps", () => {
    expect(promptRowCount("a", 5)).toBe(1)
    expect(promptRowCount("a\nb\nc", 5)).toBe(3)
    expect(promptRowCount("a\nb\nc", 2)).toBe(2)
    expect(promptRowCount("", 5)).toBe(1)
  })
})

describe("buildPromptBox", () => {
  test("draws a bordered box of the exact width", () => {
    const box = buildPromptBox({ input: "hello", cursor: 5, width: 30 })
    expect(box.lines).toHaveLength(3)
    for (const line of box.lines) expect(visibleWidth(line)).toBe(30)
    expect(box.rows).toBe(1)
    expect(stripAnsi(box.lines[1]!)).toContain("hello")
  })

  test("puts the caret just after the text", () => {
    const box = buildPromptBox({ input: "hello", cursor: 5, width: 30 })
    expect(box.cursor).toEqual({ row: 1, col: 10 })
    expect(box.cursor.col).toBeLessThanOrEqual(30)
  })

  test("shows the placeholder when the input is empty", () => {
    const box = buildPromptBox({ input: "", cursor: 0, width: 30, placeholder: "ask anything" })
    expect(stripAnsi(box.lines[1]!)).toContain("ask anything")
    expect(box.cursor.col).toBe(3 + 2 + "ask anything".length)
  })

  test("grows with the input and keeps the caret on its line", () => {
    const box = buildPromptBox({ input: "one\ntwo", cursor: 5, width: 30 })
    expect(box.lines).toHaveLength(4)
    expect(box.rows).toBe(2)
    expect(box.cursor.row).toBe(2)
    expect(stripAnsi(box.lines[2]!)).toContain("two")
  })

  test("scrolls vertically to keep the caret visible", () => {
    const input = "l0\nl1\nl2\nl3\nl4"
    const box = buildPromptBox({ input, cursor: input.length, width: 30, maxRows: 2 })
    expect(box.rows).toBe(2)
    expect(box.cursor.row).toBe(2)
    expect(stripAnsi(box.lines[2]!)).toContain("l4")
  })

  test("scrolls a long line horizontally and marks it", () => {
    const input = "x".repeat(60)
    const box = buildPromptBox({ input, cursor: input.length, width: 20 })
    expect(box.scrolled).toBe(true)
    expect(stripAnsi(box.lines[1]!)).toContain("\u2026")
    expect(box.cursor.col).toBeLessThanOrEqual(20)
    for (const line of box.lines) expect(visibleWidth(line)).toBe(20)
  })

  test("puts a hint on the top border, and drops it when there is no room", () => {
    const wide = buildPromptBox({ input: "hi", cursor: 2, width: 50, hint: "esc interrupts" })
    expect(stripAnsi(wide.lines[0]!)).toContain("esc interrupts")
    const narrow = buildPromptBox({ input: "hi", cursor: 2, width: 12, hint: "esc interrupts" })
    expect(stripAnsi(narrow.lines[0]!)).not.toContain("esc")
    expect(visibleWidth(narrow.lines[0]!)).toBe(12)
  })

  test("applies paint to the text region without changing the geometry", () => {
    const box = buildPromptBox({ input: "/model", cursor: 6, width: 30, paint: (text) => `\u001b[36m${text}\u001b[39m` })
    expect(visibleWidth(box.lines[1]!)).toBe(30)
    expect(box.cursor).toEqual({ row: 1, col: 11 })
  })

  test("reports one layout entry per text row, in order", () => {
    const box = buildPromptBox({ input: "one\ntwo\nthree", cursor: 13, width: 30 })
    expect(box.layout).toHaveLength(box.rows)
    expect(box.layout.map((entry) => entry.line)).toEqual([0, 1, 2])
    expect(box.layout.every((entry) => entry.start === 0)).toBe(true)
  })

  test("reports the horizontal scroll offset so a click can be mapped back", () => {
    const input = `${"a".repeat(40)}tail`
    const box = buildPromptBox({ input, cursor: input.length, width: 20 })
    const row = box.layout[0]!
    expect(row.start).toBeGreaterThan(0)
    // the visible slice starts exactly where the layout says it does
    expect(input.slice(row.start)).toContain("tail")
  })

  test("reports the vertical scroll offset", () => {
    const input = "l0\nl1\nl2\nl3\nl4"
    const box = buildPromptBox({ input, cursor: input.length, width: 30, maxRows: 2 })
    expect(box.layout.map((entry) => entry.line)).toEqual([3, 4])
  })

  test("the placeholder row reports a zero offset", () => {
    const box = buildPromptBox({ input: "", cursor: 0, width: 20, placeholder: "ask anything at all here" })
    expect(box.layout[0]!.start).toBe(0)
  })
})

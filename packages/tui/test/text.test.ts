import { describe, expect, test } from "bun:test"
import { firstLine, stripAnsi, truncateVisible, visibleWidth, wrapText } from "../src"

describe("text helpers", () => {
  test("stripAnsi removes color codes", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red")
    expect(visibleWidth("\u001b[31mred\u001b[0m")).toBe(3)
    expect(visibleWidth("plain")).toBe(5)
  })

  test("firstLine finds the first non-empty line and truncates", () => {
    expect(firstLine("\n\n  hello world  \nsecond")).toBe("hello world")
    expect(firstLine("abcdefghij", 5)).toBe("abcd\u2026")
    expect(firstLine("   ")).toBe("")
  })

  test("truncateVisible only shortens long plain text", () => {
    expect(truncateVisible("short", 10)).toBe("short")
    expect(truncateVisible("abcdefghij", 5)).toBe("abcd\u2026")
  })

  test("wrapText wraps on word boundaries and keeps blank lines", () => {
    expect(wrapText("hello world", 5)).toEqual(["hello", "world"])
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"])
  })

  test("wrapText hard-splits words longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
  })
})

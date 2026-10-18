import { describe, expect, test } from "bun:test"
import { parseJsonc, stripJsonComments } from "../src/json"

describe("stripJsonComments", () => {
  test("removes line and block comments", () => {
    const input = `{
      // a comment
      "a": 1, /* inline */ "b": 2
    }`
    const parsed = parseJsonc<{ a: number; b: number }>(input)
    expect(parsed).toEqual({ a: 1, b: 2 })
  })

  test("preserves comment-like sequences inside strings", () => {
    const input = `{ "url": "http://example.com//path", "note": "not /* a */ comment" }`
    const parsed = parseJsonc<{ url: string; note: string }>(input)
    expect(parsed.url).toBe("http://example.com//path")
    expect(parsed.note).toBe("not /* a */ comment")
  })

  test("removes trailing commas before closers", () => {
    const input = `{ "a": [1, 2, 3,], "b": { "c": 4, }, }`
    const parsed = parseJsonc<{ a: number[]; b: { c: number } }>(input)
    expect(parsed).toEqual({ a: [1, 2, 3], b: { c: 4 } })
  })

  test("handles trailing comma followed by comment", () => {
    const input = `{ "watch": false, /* off */ }`
    expect(parseJsonc(input)).toEqual({ watch: false })
  })

  test("respects escaped quotes in strings", () => {
    const input = `{ "a": "say \\"hi\\" // not comment" }`
    expect(parseJsonc<{ a: string }>(input).a).toBe('say "hi" // not comment')
  })

  test("plain JSON passes through unchanged", () => {
    const input = JSON.stringify({ x: [1, "two", { three: true }] })
    expect(stripJsonComments(input)).toBe(input)
  })
})

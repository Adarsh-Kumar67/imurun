import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MARKDOWN_PALETTE,
  highlightCode,
  inlineSegments,
  isTableSeparator,
  renderMarkdown,
  wrapSegments,
} from "../src/markdown"
import { stripAnsi, visibleWidth } from "../src/text"

/** Renders and returns plain text lines, so assertions stay readable. */
function plain(text: string, width = 60, maxCodeLines?: number): string[] {
  return renderMarkdown(text, { width, maxCodeLines }).map((line) => stripAnsi(line))
}

describe("renderMarkdown", () => {
  test("every line fits the requested width", () => {
    const source = [
      "# A heading that is quite long and needs to wrap somewhere sensible",
      "",
      "A paragraph with **bold text**, `inline code`, and a [link](https://example.com/very/long/path) that goes on for a while.",
      "",
      "- a list item that is long enough to need wrapping at this width for sure",
      "  - and a nested one",
      "",
      "| Column one | Column two |",
      "| ---------- | ---------- |",
      "| a value    | b value    |",
    ].join("\n")
    for (const line of renderMarkdown(source, { width: 40 })) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }
  })

  test("headings are visible and underline only for the top two levels", () => {
    const lines = plain("# Title\n\n## Sub\n\n### Deep")
    expect(lines[0]).toBe("Title")
    expect(lines[1]).toContain("\u2500") // rule after h1
    expect(lines[3]).toBe("Sub")
    expect(lines[4]).toContain("\u2500") // rule after h2
    expect(lines[6]).toBe("# Deep") // deeper headings keep a marker, no rule
  })

  test("fenced code keeps its contents verbatim, in a box", () => {
    const lines = plain("```ts\nconst x = 1\n```", 40)
    expect(lines[0]).toContain("ts")
    expect(lines[0]!.startsWith("\u256d")).toBe(true)
    expect(lines.join("\n")).toContain("const x = 1")
    expect(lines.at(-1)).toContain("\u256f")
  })

  test("long code blocks are truncated with a count", () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")
    const lines = plain(`\`\`\`\n${body}\n\`\`\``, 40, 5)
    expect(lines.join("\n")).toContain("line 4")
    expect(lines.join("\n")).not.toContain("line 5")
    expect(lines.join("\n")).toContain("15 more line(s)")
  })

  test("bullets, ordered items and checkboxes each get a marker", () => {
    const lines = plain("- one\n- two\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done")
    expect(lines[0]!.trimStart().startsWith("\u2022")).toBe(true)
    const ordered = lines.find((line) => line.includes("first"))
    expect(ordered).toContain("1.")
    expect(lines.some((line) => line.includes("\u2610"))).toBe(true)
    expect(lines.some((line) => line.includes("\u2611"))).toBe(true)
  })

  test("blockquotes are prefixed", () => {
    const lines = plain("> quoted text")
    expect(lines[0]).toContain("\u2502")
    expect(lines[0]).toContain("quoted text")
  })

  test("a horizontal rule becomes a drawn line", () => {
    const lines = plain("before\n\n---\n\nafter")
    expect(lines.some((line) => line.includes("\u2500"))).toBe(true)
  })

  test("tables line up the cells", () => {
    const lines = plain("| one | two |\n| --- | --- |\n| a | b |", 40)
    expect(lines[0]).toContain("one")
    expect(lines[0]).toContain("two")
    expect(lines[0]).toContain("\u2502")
    // the divider row, then the body row aligned under the header
    expect(lines[1]).toContain("\u253c")
    const body = lines.find((line) => line.trimStart().startsWith("a"))
    expect(body).toContain("b")
  })

  test("the streaming caret is appended to the last line", () => {
    const lines = renderMarkdown("hello", { width: 40, caret: "\u258c" })
    expect(stripAnsi(lines.at(-1)!)).toContain("\u258c")
  })

  test("blank input produces no lines", () => {
    expect(renderMarkdown("", { width: 40 })).toHaveLength(0)
  })
})

describe("inlineSegments", () => {
  test("splits bold, code and links into styled runs", () => {
    const segments = inlineSegments("a **b** c `d` [e](https://f)")
    const text = segments.map((segment) => segment.text).join("")
    // the URL is kept as plain text so it is selectable in a terminal
    expect(text).toBe("a b c d e (https://f)")
    expect(segments.some((segment) => segment.style === "bold")).toBe(true)
    expect(segments.some((segment) => segment.style === "code")).toBe(true)
    expect(segments.some((segment) => segment.style === "link")).toBe(true)
  })

  test("leaves plain text as a single run", () => {
    const segments = inlineSegments("just words")
    expect(segments).toHaveLength(1)
    expect(segments[0]!.style).toBeUndefined()
  })

  test("keeps underscores inside identifiers intact", () => {
    const segments = inlineSegments("call some_function_name here")
    expect(segments.map((segment) => segment.text).join("")).toBe("call some_function_name here")
    expect(segments.some((segment) => segment.style === "italic")).toBe(false)
  })
})

describe("wrapSegments", () => {
  test("wraps by visible width and never exceeds it", () => {
    const rows = wrapSegments(inlineSegments("alpha beta gamma delta epsilon zeta"), 12)
    for (const row of rows) {
      const width = row.reduce((sum, segment) => sum + segment.text.length, 0)
      expect(width).toBeLessThanOrEqual(12)
    }
    expect(rows.length).toBeGreaterThan(1)
  })

  test("preserves styles across a wrap", () => {
    const rows = wrapSegments(inlineSegments("plain **bold and long enough to wrap** plain"), 14)
    const styled = rows.flat().filter((segment) => segment.style === "bold")
    expect(styled.length).toBeGreaterThan(0)
    expect(styled.map((segment) => segment.text).join("")).toContain("bold")
  })
})

describe("highlightCode", () => {
  test("paints keywords and strings without changing the characters", () => {
    const painted = highlightCode("const name = \"value\" // note", "ts", DEFAULT_MARKDOWN_PALETTE)
    expect(stripAnsi(painted)).toBe("const name = \"value\" // note")
  })

  test("uses hash comments for shell-like languages", () => {
    const painted = highlightCode("echo hi # a note", "bash", DEFAULT_MARKDOWN_PALETTE)
    expect(stripAnsi(painted)).toBe("echo hi # a note")
  })
})

describe("isTableSeparator", () => {
  test("recognises a separator row", () => {
    expect(isTableSeparator("| --- | :--: |")).toBe(true)
    expect(isTableSeparator("|---|---|")).toBe(true)
    expect(isTableSeparator("just text")).toBe(false)
    expect(isTableSeparator("| a | b |")).toBe(false)
  })
})

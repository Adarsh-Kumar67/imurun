/**
 * The new TUI surfaces: clickable links, the thinking categories, the live
 * timer, and the selection mode.
 */
import { describe, expect, test } from "bun:test"
import { categoryForTool, renderBlock, thinkingStyle } from "../src/render"
import { findUrls, hyperlink, LINK_END, linkStart } from "../src/hyperlink"
import { renderMarkdown } from "../src/markdown"
import { stripAnsi, visibleWidth } from "../src/text"

describe("clickable links", () => {
  test("a URL is wrapped in the OSC 8 sequence", () => {
    const link = hyperlink("https://imutechz.in", "the site")
    expect(link).toContain(linkStart("https://imutechz.in"))
    expect(link).toContain(LINK_END)
    expect(link).toContain("the site")
  })

  test("the escape adds no visible characters", () => {
    const link = hyperlink("https://imutechz.in", "the site")
    expect(visibleWidth(link)).toBe("the site".length)
    expect(stripAnsi(link)).toBe("the site")
  })

  test("a markdown link becomes clickable", () => {
    const lines = renderMarkdown("See [the docs](https://imutechz.in/docs) for more.", { width: 60 })
    const plain = stripAnsi(lines.join("\n"))
    expect(plain).toContain("the docs")
    expect(lines.join("")).toContain("\u001b]8;;https://imutechz.in/docs")
  })

  test("a bare URL becomes clickable too", () => {
    const lines = renderMarkdown("The site is https://imutechz.in for details.", { width: 60 })
    expect(lines.join("")).toContain("\u001b]8;;https://imutechz.in")
  })

  test("the width of a line with a link is the width of the text", () => {
    const lines = renderMarkdown("Visit https://imutechz.in now", { width: 40 })
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  test("URLs are found, without the trailing punctuation", () => {
    expect(findUrls("see https://imutechz.in.")).toEqual(["https://imutechz.in"])
    expect(findUrls("no link here")).toEqual([])
  })
})

describe("the thinking categories", () => {
  test("each kind of work has its own colour and icon", () => {
    const categories = ["reasoning", "search", "files", "shell", "plan"] as const
    const icons = new Set(categories.map((category) => thinkingStyle(category).icon))
    expect(icons.size).toBe(categories.length)
    const labels = new Set(categories.map((category) => thinkingStyle(category).label))
    expect(labels.size).toBe(categories.length)
  })

  test("a tool decides the category", () => {
    expect(categoryForTool("web_search")).toBe("search")
    expect(categoryForTool("web_fetch")).toBe("search")
    expect(categoryForTool("github")).toBe("search")
    expect(categoryForTool("read")).toBe("files")
    expect(categoryForTool("grep")).toBe("files")
    expect(categoryForTool("shell")).toBe("shell")
    expect(categoryForTool("plan")).toBe("plan")
    expect(categoryForTool("something-else")).toBe("reasoning")
  })

  test("the block shows the category, not just the word thinking", () => {
    const search = stripAnsi(renderBlock({ kind: "reasoning", text: "", category: "search", seconds: 3 }, 60)[0]!)
    const files = stripAnsi(renderBlock({ kind: "reasoning", text: "", category: "files", seconds: 3 }, 60)[0]!)
    expect(search).toContain("searching")
    expect(files).toContain("reading")
  })
})

describe("the live thinking timer", () => {
  test("a live block counts up as the clock moves", () => {
    const block = { kind: "reasoning" as const, text: "", live: true, startedAt: 1_000_000 }
    const early = stripAnsi(renderBlock(block, 60, { now: 1_000_000 })[0]!)
    const later = stripAnsi(renderBlock(block, 60, { now: 1_003_500 })[0]!)
    expect(early).toContain("00s")
    expect(later).toContain("03s")
  })

  test("a finished block keeps the time it took", () => {
    const block = { kind: "reasoning" as const, text: "", live: false, seconds: 42 }
    const line = stripAnsi(renderBlock(block, 60, { now: 9_999_999 })[0]!)
    expect(line).toContain("42s")
  })

  test("the timer is padded, so the label does not change width", () => {
    const one = stripAnsi(renderBlock({ kind: "reasoning", text: "", live: true, startedAt: 0 }, 60, { now: 1_000 })[0]!)
    const twelve = stripAnsi(renderBlock({ kind: "reasoning", text: "", live: true, startedAt: 0 }, 60, { now: 12_000 })[0]!)
    expect(one).toContain("01s")
    expect(twelve).toContain("12s")
  })
})

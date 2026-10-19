import { describe, expect, test } from "bun:test"
import { composeFrame, renderBlock, renderTranscript, tail, windowSlice } from "../src/render"
import { stripAnsi, visibleWidth } from "../src/text"
import type { Block } from "../src/render"

describe("renderBlock", () => {
  test("user blocks wrap and are prefixed with a marker", () => {
    const lines = renderBlock({ kind: "user", text: "hello world" }, 20)
    expect(lines).toHaveLength(1)
    expect(stripAnsi(lines[0]!)).toContain("hello world")
  })

  test("long user text wraps within the width", () => {
    const lines = renderBlock({ kind: "user", text: "one two three four five six seven" }, 20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
  })

  test("empty assistant blocks render nothing", () => {
    expect(renderBlock({ kind: "assistant", text: "   " }, 40)).toEqual([])
  })

  test("tool blocks show the status glyph and a truncated detail", () => {
    const ok = stripAnsi(renderBlock({ kind: "tool", title: "read", status: "ok", detail: "file.ts" }, 40).join("\n"))
    expect(ok).toContain("read")
    expect(ok).toContain("file.ts")
    const fail = stripAnsi(renderBlock({ kind: "tool", title: "bash", status: "fail" }, 40).join("\n"))
    expect(fail).toContain("bash")
  })

  test("a running tool shows a phase word and a progress bar", () => {
    const block: Block = {
      kind: "tool",
      title: "write index.html",
      status: "running",
      startedAt: 0,
      words: ["starting", "setting the structure", "adding colours", "finishing"],
      estimateMs: 4000,
    }
    const early = stripAnsi(renderBlock(block, 60, { now: 0 }).join("\n"))
    expect(early).toContain("write index.html")
    expect(early).toContain("starting")
    expect(early).toContain("%")

    const later = stripAnsi(renderBlock(block, 60, { now: 3300 }).join("\n"))
    expect(later).toContain("adding colours")
    expect(later).toContain("\u2588") // the bar has filled in
  })

  test("a finished tool drops the bar and shows the outcome", () => {
    const block: Block = {
      kind: "tool",
      title: "write index.html",
      status: "ok",
      detail: "created index.html (1200 bytes, 42 lines)",
      startedAt: 0,
      words: ["starting", "finishing"],
      estimateMs: 4000,
    }
    const lines = stripAnsi(renderBlock(block, 60, { now: 9000 }).join("\n"))
    expect(lines).not.toContain("%")
    expect(lines).toContain("created index.html")
  })

  test("a code block shows the written code in a bordered preview", () => {
    const lines = renderBlock(
      { kind: "code", text: "export const a = 1\nexport const b = 2\n", lang: "ts", title: "wrote src/app.ts" },
      40,
    )
    const plain = lines.map((line) => stripAnsi(line)).join("\n")
    expect(plain).toContain("wrote src/app.ts")
    expect(plain).toContain("export const a = 1")
    expect(plain).toContain("\u256d")
    expect(plain).toContain("\u2570")
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  test("a long code block is truncated with a count", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const plain = stripAnsi(renderBlock({ kind: "code", text, lang: "ts", maxLines: 5 }, 40).join("\n"))
    expect(plain).toContain("line 4")
    expect(plain).not.toContain("line 5")
    expect(plain).toContain("45 more line")
  })

  test("a meta block is right-aligned and fits the width", () => {
    const lines = renderBlock({ kind: "meta", text: "2 steps \u00b7 2235+10 tokens \u00b7 qwen2.5-coder-7b" }, 60)
    expect(lines).toHaveLength(1)
    const text = stripAnsi(lines[0]!)
    expect(text.trimStart()).toBe("2 steps \u00b7 2235+10 tokens \u00b7 qwen2.5-coder-7b")
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(60)
    // the padding is on the left
    expect(text.startsWith(" ")).toBe(true)
  })

  test("a queued message is marked as pending, an undone one as struck out", () => {
    const pending = stripAnsi(renderBlock({ kind: "user", text: "hello", state: "pending" }, 40).join("\n"))
    const plain = stripAnsi(renderBlock({ kind: "user", text: "hello" }, 40).join("\n"))
    const undone = stripAnsi(renderBlock({ kind: "user", text: "hello", state: "undone" }, 40).join("\n"))
    expect(pending).toContain("hello")
    expect(pending).not.toBe(plain)
    expect(undone).toContain("hello")
  })

  test("notices carry their tone", () => {
    const lines = renderBlock({ kind: "notice", text: "all good", tone: "ok" }, 40)
    expect(stripAnsi(lines[0]!)).toContain("all good")
  })

  test("raw blocks keep pre-formatted lines and clamp the width", () => {
    const lines = renderBlock({ kind: "raw", text: "a\nb" }, 40)
    expect(lines).toHaveLength(2)
    expect(visibleWidth(renderBlock({ kind: "raw", text: "x".repeat(80) }, 20)[0]!)).toBeLessThanOrEqual(20)
  })
})

describe("renderTranscript", () => {
  test("flattens blocks and skips empty ones", () => {
    const blocks: Block[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "" },
      { kind: "notice", text: "done", tone: "ok" },
    ]
    const lines = renderTranscript(blocks, 40)
    expect(lines).toHaveLength(2)
  })
})

describe("composeFrame", () => {
  const base = {
    width: 40,
    height: 12,
    header: ["HEADER"],
    transcript: ["a", "b", "c"],
    overlay: [] as string[],
    prompt: ["> hi"],
    promptCursor: { row: 1, col: 2 },
    status: "status",
  }

  test("always fills exactly the frame height", () => {
    const frame = composeFrame(base)
    expect(frame.lines).toHaveLength(12)
  })

  test("keeps status and the prompt box as the last two rows", () => {
    const frame = composeFrame({ ...base, transcript: Array.from({ length: 50 }, (_, i) => `line ${i}`) })
    const lines = frame.lines
    expect(lines[lines.length - 2]!.trim()).toBe("> hi")
    expect(lines[lines.length - 1]!.trim()).toBe("status")
    expect(frame.cursor).toEqual({ row: 11, col: 2 })
  })

  test("shows the newest transcript lines and drops the oldest", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const frame = composeFrame({ ...base, transcript })
    const joined = frame.lines.join("\n")
    expect(joined).toContain("line 29")
    expect(joined).toContain("line 21")
    expect(joined).not.toContain("line 20")
  })

  test("anchors the transcript to the bottom of its area", () => {
    const frame = composeFrame({ ...base, transcript: ["only"] })
    const index = frame.lines.findIndex((line) => line.includes("only"))
    expect(frame.lines[index + 1]!.trim()).toBe("> hi")
    // the slack sits between the header and the transcript
    expect(frame.lines[1]!.trim()).toBe("")
    expect(index).toBe(9)
  })

  test("draws the overlay directly above the prompt box", () => {
    const frame = composeFrame({ ...base, overlay: ["/ box 1", "\\ box 2"] })
    const lines = frame.lines
    expect(lines[lines.length - 3]!.trim()).toBe("\\ box 2")
    expect(lines[lines.length - 2]!.trim()).toBe("> hi")
    expect(lines[lines.length - 1]!.trim()).toBe("status")
  })

  test("scrolls the transcript window by the given offset", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const live = composeFrame({ ...base, transcript })
    expect(live.lines.join("\n")).toContain("line 29")
    const back = composeFrame({ ...base, transcript, scroll: 10 })
    const joined = back.lines.join("\n")
    expect(joined).toContain("line 19")
    expect(joined).not.toContain("line 29")
  })

  test("reports which transcript line is at the top, and how may fit", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const live = composeFrame({ ...base, transcript })
    expect(live.viewportRows).toBe(
      live.lines.length - base.header.length - base.prompt.length - 1,
    )
    // live means the newest window: the last `viewportRows` lines
    expect(live.viewTop).toBe(transcript.length - live.viewportRows)
  })

  test("an explicit viewTop pins the view; growing the log does not move it", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const first = composeFrame({ ...base, transcript, viewTop: 5 })
    expect(first.viewTop).toBe(5)
    expect(first.lines.join("\n")).toContain("line 5")
    expect(first.lines.join("\n")).not.toContain("line 29")

    // a turn appends ten more lines — the reader stays exactly where they were
    const grown = [...transcript, ...Array.from({ length: 10 }, (_, i) => `new ${i}`)]
    const second = composeFrame({ ...base, transcript: grown, viewTop: first.viewTop })
    expect(second.viewTop).toBe(first.viewTop)
    expect(second.lines.join("\n")).toContain("line 5")
    expect(second.lines.join("\n")).not.toContain("new 0")
  })

  test("viewTop beats scroll, and is clamped to the transcript", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const frame = composeFrame({ ...base, transcript, scroll: 20, viewTop: 3 })
    expect(frame.viewTop).toBe(3)
    expect(frame.lines.join("\n")).toContain("line 3")

    const beyond = composeFrame({ ...base, transcript, viewTop: 999 })
    expect(beyond.viewTop).toBe(transcript.length - beyond.viewportRows)
    const negative = composeFrame({ ...base, transcript, viewTop: -5 })
    expect(negative.viewTop).toBe(0)
  })

  test("keeps the prompt visible on a very short terminal", () => {
    const frame = composeFrame({
      ...base,
      height: 4,
      header: ["H1", "H2", "H3"],
      overlay: ["o1", "o2", "o3"],
      transcript: ["t1", "t2"],
    })
    expect(frame.lines).toHaveLength(4)
    expect(frame.lines[frame.lines.length - 2]!.trim()).toBe("> hi")
    expect(frame.lines[frame.lines.length - 1]!.trim()).toBe("status")
  })

  test("draws the sidebar to the right of the transcript", () => {
    const frame = composeFrame({
      ...base,
      width: 40,
      transcript: ["hello"],
      sidebar: { width: 10, lines: ["SIDE", "PANEL"] },
    })
    // the panel starts at the top of the body, not beside the last line
    const first = stripAnsi(frame.lines[1]!)
    expect(first.trimEnd().endsWith("SIDE")).toBe(true)
    expect(first).toContain("\u2502")
    expect(visibleWidth(frame.lines[1]!)).toBe(40)
    expect(stripAnsi(frame.lines[1]!).indexOf("\u2502")).toBeGreaterThan(20)
    // the second panel line follows it down the right edge
    expect(stripAnsi(frame.lines[2]!).trimEnd().endsWith("PANEL")).toBe(true)
    // the transcript still gets the body, just to the left of the panel
    expect(frame.lines[9]).toContain("hello")
  })

  test("a taller prompt box takes its rows from the transcript, not the status line", () => {
    const transcript = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const oneRow = composeFrame({ ...base, transcript, prompt: ["P"] })
    const fourRows = composeFrame({ ...base, transcript, prompt: ["P", "P", "P", "P"] })
    // the transcript gives up exactly the rows the box gained
    expect(oneRow.viewportRows - fourRows.viewportRows).toBe(3)
    // and the status line is still the final row in both
    expect(fourRows.lines[fourRows.lines.length - 1]!.trim()).toBe("status")
    expect(fourRows.lines[fourRows.lines.length - 2]!.trim()).toBe("P")
  })

  test("clamps the caret inside the frame", () => {
    const frame = composeFrame({ ...base, height: 3, header: ["H"], transcript: [], overlay: [] })
    expect(frame.cursor.row).toBeLessThanOrEqual(3)
    expect(frame.cursor.row).toBeGreaterThanOrEqual(1)
  })
})

describe("tail", () => {
  test("returns the last n lines and clamps", () => {
    expect(tail(["a", "b", "c", "d"], 2)).toEqual(["c", "d"])
    expect(tail(["a", "b"], 5)).toEqual(["a", "b"])
    expect(tail(["a", "b"], 0)).toEqual([])
  })
})

describe("windowSlice", () => {
  test("takes the newest lines by default", () => {
    expect(windowSlice(["a", "b", "c", "d"], 2)).toEqual(["c", "d"])
  })

  test("scroll lifts the window above the bottom", () => {
    expect(windowSlice(["a", "b", "c", "d"], 2, 1)).toEqual(["b", "c"])
    expect(windowSlice(["a", "b", "c", "d"], 2, 10)).toEqual(["a", "b"])
    expect(windowSlice(["a", "b"], 2, 0)).toEqual(["a", "b"])
  })
})

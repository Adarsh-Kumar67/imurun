/**
 * Clicking a thinking block.
 *
 * The mapping is the whole of it: the transcript line a block occupies, the
 * screen row that line is drawn on, and the block at that row. When any of
 * the three drifts apart — because the header grew, or the prompt box
 * changed height, or the transcript scrolled — the click lands on the wrong
 * thing and the block does not open. So the chain is proved here, end to end.
 */
import { describe, expect, test } from "bun:test"
import { composeFrame, reasoningRanges, type Block } from "../src/render"
import { buildPromptBox } from "../src/prompt"

const WIDTH = 80
const HEIGHT = 24

/** The same chain the interface uses, from a click's row to a block. */
function blockAtRow(blocks: Block[], row: number, header: string[] = ["HEADER"]): Block | undefined {
  const box = buildPromptBox({ input: "", cursor: 0, width: WIDTH, fixedRows: 3 })
  const transcript = blocks.map(() => "a line of the transcript")
  const frame = composeFrame({
    width: WIDTH,
    height: HEIGHT,
    header,
    transcript,
    overlay: [],
    prompt: box.lines,
    promptCursor: box.cursor,
    status: "status",
  })

  // Where the visible transcript starts on the screen.
  const viewportFirstRow = frame.promptTop - frame.viewportRows
  if (row < viewportFirstRow) return undefined
  const line = frame.viewTop + (row - viewportFirstRow)

  // The ranges are computed over the same blocks, at the same width.
  const ranges = reasoningRanges(blocks, WIDTH, { now: Date.now() })
  const hit = ranges.find((range) => line >= range.start && line <= range.end)
  if (!hit) return undefined
  return blocks[hit.index]
}

describe("clicking a thinking block", () => {
  const blocks: Block[] = [
    { kind: "user", text: "hello" },
    { kind: "reasoning", text: "some thinking", seconds: 3, category: "search" },
    { kind: "assistant", text: "an answer" },
  ]

  test("the block's line is found, wherever it sits", () => {
    // The block is the second one, so its line is the second transcript line.
    const ranges = reasoningRanges(blocks, WIDTH, { now: Date.now() })
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.index).toBe(1)
  })

  test("a click on the block's row finds it", () => {
    // The transcript starts on the row after the header.
    const box = buildPromptBox({ input: "", cursor: 0, width: WIDTH, fixedRows: 3 })
    const frame = composeFrame({
      width: WIDTH,
      height: HEIGHT,
      header: ["HEADER"],
      transcript: blocks.map(() => "a line"),
      overlay: [],
      prompt: box.lines,
      promptCursor: box.cursor,
      status: "status",
    })
    const viewportFirstRow = frame.promptTop - frame.viewportRows
    // The second transcript line is one row below the first.
    const hit = blockAtRow(blocks, viewportFirstRow + 1)
    expect(hit?.kind).toBe("reasoning")
  })

  test("a click on another line does not find it", () => {
    const box = buildPromptBox({ input: "", cursor: 0, width: WIDTH, fixedRows: 3 })
    const frame = composeFrame({
      width: WIDTH,
      height: HEIGHT,
      header: ["HEADER"],
      transcript: blocks.map(() => "a line"),
      overlay: [],
      prompt: box.lines,
      promptCursor: box.cursor,
      status: "status",
    })
    const viewportFirstRow = frame.promptTop - frame.viewportRows
    // The first line is the user's message, not the thinking block.
    expect(blockAtRow(blocks, viewportFirstRow)?.kind).not.toBe("reasoning")
    // And a row above the transcript is nothing at all.
    expect(blockAtRow(blocks, viewportFirstRow - 1)).toBeUndefined()
  })

  test("the mapping survives a taller header", () => {
    const ranges = reasoningRanges(blocks, WIDTH, { now: Date.now() })
    expect(ranges[0]!.start).toBe(1)
    // A second header row moves the block down the screen, but the range
    // inside the transcript does not change — the click follows the content.
    const box = buildPromptBox({ input: "", cursor: 0, width: WIDTH, fixedRows: 3 })
    const frame = composeFrame({
      width: WIDTH,
      height: HEIGHT,
      header: ["HEADER", "SECOND"],
      transcript: blocks.map(() => "a line"),
      overlay: [],
      prompt: box.lines,
      promptCursor: box.cursor,
      status: "status",
    })
    const viewportFirstRow = frame.promptTop - frame.viewportRows
    expect(blockAtRow(blocks, viewportFirstRow + 1, ["HEADER", "SECOND"])?.kind).toBe("reasoning")
  })
})

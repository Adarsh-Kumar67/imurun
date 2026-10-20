/**
 * The screen — what it writes, and what it does not.
 *
 * The screen repaints several times a second, and on a slow machine the
 * terminal emulator is the bottleneck: asking it to redraw every line of a
 * wide window, eight times a second, is enough to make the interface feel
 * stuck. So only the rows that changed are written.
 */
import { describe, expect, test } from "bun:test"
import { Screen } from "../src/screen"

interface FakeStream {
  chunks: string[]
  columns: number
  rows: number
  write(text: string): void
  on(event: string, fn: () => void): void
  off(event: string, fn: () => void): void
  /** Fires the registered resize handler, as a terminal would. */
  fireResize(): void
}

function fakeOutput(columns = 80, rows = 24): FakeStream {
  const chunks: string[] = []
  const handlers = new Map<string, () => void>()
  return {
    chunks,
    columns,
    rows,
    write(text: string) {
      chunks.push(text)
    },
    on(event: string, fn: () => void) {
      handlers.set(event, fn)
    },
    off(event: string) {
      handlers.delete(event)
    },
    fireResize() {
      handlers.get("resize")?.()
    },
  }
}

function fakeInput() {
  return { setRawMode() {}, resume() {}, pause() {}, on() {}, off() {}, isTTY: true }
}

describe("Screen", () => {
  test("the first frame writes every row", () => {
    const output = fakeOutput()
    const screen = new Screen(fakeInput() as never, output as never)
    screen.start()
    output.chunks.length = 0

    screen.draw(["one", "two", "three"])
    const written = output.chunks.join("")
    expect(written).toContain("one")
    expect(written).toContain("two")
    expect(written).toContain("three")
  })

  test("an unchanged row is not written again", () => {
    const output = fakeOutput()
    const screen = new Screen(fakeInput() as never, output as never)
    screen.start()
    screen.draw(["one", "two", "three"])
    output.chunks.length = 0

    // One line changes; the rest are the same.
    screen.draw(["one", "TWO", "three"])
    const written = output.chunks.join("")
    expect(written).toContain("TWO")
    expect(written).not.toContain("one")
    expect(written).not.toContain("three")
  })

  test("a frame that did not change writes almost nothing", () => {
    const output = fakeOutput()
    const screen = new Screen(fakeInput() as never, output as never)
    screen.start()
    screen.draw(["one", "two"])
    output.chunks.length = 0

    screen.draw(["one", "two"])
    const written = output.chunks.join("")
    // Only the cursor position, no repaint.
    expect(written).not.toContain("one")
    expect(written).not.toContain("two")
  })

  test("the mouse can be handed back to the terminal and taken again", () => {
    const output = fakeOutput()
    const screen = new Screen(fakeInput() as never, output as never)
    screen.start()
    expect(screen.mouseEnabled).toBe(true)

    output.chunks.length = 0
    screen.setMouseEnabled(false)
    expect(screen.mouseEnabled).toBe(false)
    expect(output.chunks.join("")).toContain("\u001b[?1006l")

    output.chunks.length = 0
    screen.setMouseEnabled(true)
    expect(screen.mouseEnabled).toBe(true)
    expect(output.chunks.join("")).toContain("\u001b[?1006h")
  })

  test("a resize drops the frame cache, so every row is written again", () => {
    const output = fakeOutput()
    const screen = new Screen(fakeInput() as never, output as never)
    screen.start()
    screen.draw(["one", "two"])
    output.chunks.length = 0

    // The terminal grew: the old lines are the wrong width.
    output.columns = 100
    output.fireResize()
    output.chunks.length = 0
    screen.draw(["one", "two"])
    expect(output.chunks.join("")).toContain("one")
  })
})

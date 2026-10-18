import { describe, expect, test } from "bun:test"
import {
  PHRASE_MS,
  estimateToolMs,
  progressBar,
  progressFraction,
  progressPhrase,
  progressWords,
} from "../src/progress"
import { stripAnsi } from "../src/text"

describe("progressWords", () => {
  test("writing markup talks about the work, not the tool", () => {
    const words = progressWords("write", { path: "index.html" })
    expect(words.length).toBeGreaterThan(3)
    expect(words.join(" ")).toMatch(/structure|content|layer|style|finish/i)
  })

  test("picks a different vocabulary per file family", () => {
    const style = progressWords("write", { path: "styles.css" }).join(" ")
    const script = progressWords("edit", { path: "app.ts" }).join(" ")
    const prose = progressWords("write", { path: "README.md" }).join(" ")
    expect(style).not.toBe(script)
    expect(script).not.toBe(prose)
  })

  test("falls back to a generic vocabulary for an unknown extension", () => {
    expect(progressWords("write", { path: "file.zzz" }).length).toBeGreaterThan(0)
    expect(progressWords("write", {}).length).toBeGreaterThan(0)
  })

  test("every known tool has a vocabulary", () => {
    for (const name of ["read", "grep", "glob", "shell", "web_search", "code_search", "task"]) {
      expect(progressWords(name).length).toBeGreaterThan(0)
    }
  })
})

describe("progressPhrase", () => {
  const words = ["starting", "building", "finishing"] as const

  test("advances one word per interval", () => {
    expect(progressPhrase(words, 0)).toBe("starting")
    expect(progressPhrase(words, PHRASE_MS)).toBe("building")
    expect(progressPhrase(words, PHRASE_MS * 2)).toBe("finishing")
  })

  test("holds on the last word instead of looping", () => {
    expect(progressPhrase(words, PHRASE_MS * 50)).toBe("finishing")
  })

  test("an empty vocabulary is an empty phrase, never a crash", () => {
    expect(progressPhrase([], 5000)).toBe("")
  })

  test("a negative elapsed time does not skip ahead", () => {
    expect(progressPhrase(words, -100)).toBe("starting")
  })
})

describe("progressFraction", () => {
  test("starts at zero and never claims to be finished", () => {
    expect(progressFraction(0, 4000)).toBe(0)
    expect(progressFraction(1_000_000, 4000)).toBeLessThanOrEqual(0.97)
    expect(progressFraction(1_000_000, 4000)).toBeGreaterThan(0.9)
  })

  test("is monotonic", () => {
    let previous = -1
    for (let elapsed = 0; elapsed <= 8000; elapsed += 250) {
      const fraction = progressFraction(elapsed, 4000)
      expect(fraction).toBeGreaterThanOrEqual(previous)
      previous = fraction
    }
  })

  test("survives a zero estimate", () => {
    expect(progressFraction(100, 0)).toBe(0.5)
  })
})

describe("progressBar", () => {
  test("draws exactly the requested number of cells", () => {
    for (const width of [1, 5, 20]) {
      expect(stripAnsi(progressBar(0.5, width))).toHaveLength(width)
    }
  })

  test("is empty at zero and full at one", () => {
    expect(progressBar(0, 8)).toBe("\u2591".repeat(8))
    expect(progressBar(1, 8)).toBe("\u2588".repeat(8))
  })

  test("clamps out-of-range fractions", () => {
    expect(progressBar(-5, 4)).toBe("\u2591".repeat(4))
    expect(progressBar(9, 4)).toBe("\u2588".repeat(4))
  })
})

describe("estimateToolMs", () => {
  test("gives every tool a positive estimate", () => {
    for (const name of ["read", "write", "shell", "web_search", "grep", "unknown-tool"]) {
      expect(estimateToolMs(name)).toBeGreaterThan(0)
    }
  })

  test("a write is expected to take longer than a read", () => {
    expect(estimateToolMs("write")).toBeGreaterThan(estimateToolMs("read"))
  })
})

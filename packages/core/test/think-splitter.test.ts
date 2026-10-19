/**
 * The think-tag splitter — the model's thinking, pulled out of its answer.
 *
 * Local models often do not have a separate reasoning channel: they open a
 * think block inside the ordinary text stream. Getting this wrong either leaks
 * reasoning into the answer or eats the user's prose, so the awkward cases
 * (tags split across deltas, an unclosed block, a stray "<") are all pinned
 * here.
 */
import { describe, expect, test } from "bun:test"
import { ThinkSplitter } from "../src/agent/think-splitter"

const OPEN = "<" + "think>"
const CLOSE = "</" + "think>"

/** Feeds a whole string through one push, then flush. */
function split(input: string): { text: string; reasoning: string } {
  const splitter = new ThinkSplitter()
  const out = splitter.push(input)
  const tail = splitter.flush()
  return { text: (out.text ?? "") + (tail.text ?? ""), reasoning: (out.reasoning ?? "") + (tail.reasoning ?? "") }
}

/** Feeds one character at a time — the worst case for tag matching. */
function splitByChar(input: string): { text: string; reasoning: string } {
  const splitter = new ThinkSplitter()
  let text = ""
  let reasoning = ""
  for (const char of input) {
    const out = splitter.push(char)
    text += out.text ?? ""
    reasoning += out.reasoning ?? ""
  }
  const tail = splitter.flush()
  return { text: text + (tail.text ?? ""), reasoning: reasoning + (tail.reasoning ?? "") }
}

describe("ThinkSplitter", () => {
  test("plain text passes straight through", () => {
    const out = split("Here is the answer: use a Set.")
    expect(out.text).toBe("Here is the answer: use a Set.")
    expect(out.reasoning).toBe("")
  })

  test("a think block becomes reasoning, and the answer is what follows", () => {
    const out = split(`${OPEN}the file is probably small${CLOSE}It is 12 lines.`)
    expect(out.text).toBe("It is 12 lines.")
    expect(out.reasoning).toBe("the file is probably small")
  })

  test("text before and after the block is kept", () => {
    const out = split(`Let me check. ${OPEN}hmm${CLOSE} Done.`)
    expect(out.text).toBe("Let me check.  Done.")
    expect(out.reasoning).toBe("hmm")
  })

  test("a tag split across deltas is still matched", () => {
    const byChar = splitByChar(`${OPEN}thinking about it${CLOSE}the answer`)
    expect(byChar.reasoning).toBe("thinking about it")
    expect(byChar.text).toBe("the answer")
  })

  test("an unclosed block is reasoning, never the answer", () => {
    const out = split(`${OPEN}still working through this`)
    expect(out.text).toBe("")
    expect(out.reasoning).toBe("still working through this")
    expect(new ThinkSplitter().push(`${OPEN}mid`).reasoning).toBe("mid")
  })

  test("the <thinking> and <reasoning> spellings work too", () => {
    expect(split(`<thinking>x</thinking>y`)).toEqual({ text: "y", reasoning: "x" })
    expect(split(`<reasoning>a</reasoning>b`)).toEqual({ text: "b", reasoning: "a" })
  })

  test("several blocks keep their order", () => {
    const out = split(`${OPEN}one${CLOSE}A${OPEN}two${CLOSE}B`)
    expect(out.text).toBe("AB")
    expect(out.reasoning).toBe("onetwo")
  })

  test("a lone < is not a tag and is not swallowed", () => {
    const out = split("a < b and c > d")
    expect(out.text).toBe("a < b and c > d")
    expect(out.reasoning).toBe("")
  })

  test("a partial tag at the end of a stream is not lost", () => {
    const splitter = new ThinkSplitter()
    const first = splitter.push("done <thi")
    expect(first.text).toBe("done ")
    const tail = splitter.flush()
    expect(tail.text).toBe("<thi")
  })

  test("text keeps streaming: at most a tag's length is ever held back", () => {
    const splitter = new ThinkSplitter()
    // A long run of ordinary text must arrive immediately, not accumulate.
    const word = "the quick brown fox ".repeat(20)
    expect(splitter.push(word).text).toBe(word)
    expect(splitter.push("and").text).toBe("and")
  })

  test("insideThink reports the state, for callers that care", () => {
    const splitter = new ThinkSplitter()
    expect(splitter.insideThink).toBe(false)
    splitter.push(`${OPEN}thinking`)
    expect(splitter.insideThink).toBe(true)
    splitter.push(CLOSE)
    expect(splitter.insideThink).toBe(false)
  })
})

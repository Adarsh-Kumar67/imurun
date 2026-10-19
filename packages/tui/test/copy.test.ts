/**
 * What `/copy` can pick out of a transcript.
 *
 * These are the pure parts — reading fences, keeping the newest block first,
 * and never offering an empty block — so the command itself only has to talk to
 * the clipboard.
 */
import { describe, expect, test } from "bun:test"
import { collectCodeBlocks, fencedBlocks, latestAnswer } from "../src/copy"
import type { Block } from "../src/render"

const user: Block = { kind: "user", text: "fix the parser" }
const notice: Block = { kind: "notice", text: "working", tone: "info" }

describe("fencedBlocks", () => {
  test("finds fenced code with its language", () => {
    const text = "Here:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\ndone"
    expect(fencedBlocks(text)).toEqual([{ lang: "ts", text: "const a = 1;\nconst b = 2;" }])
  })

  test("an unterminated fence still yields its body", () => {
    expect(fencedBlocks("```python\nprint('hi')")).toEqual([{ lang: "python", text: "print('hi')" }])
  })

  test("no fences means no blocks", () => {
    expect(fencedBlocks("plain prose only")).toEqual([])
  })

  test("trailing blank lines inside a fence do not become the copy", () => {
    const blocks = fencedBlocks("```\nline one\nline two\n\n\n```")
    expect(blocks).toEqual([{ lang: undefined, text: "line one\nline two" }])
  })
})

describe("latestAnswer", () => {
  test("returns the newest assistant text", () => {
    const blocks: Block[] = [
      user,
      { kind: "assistant", text: "first answer" },
      notice,
      { kind: "assistant", text: "  the real answer  " },
    ]
    expect(latestAnswer(blocks)).toBe("the real answer")
  })

  test("a streaming placeholder is not an answer", () => {
    const blocks: Block[] = [{ kind: "assistant", text: "", streaming: true }]
    expect(latestAnswer(blocks)).toBeUndefined()
  })
})

describe("collectCodeBlocks", () => {
  test("numbers from the newest, and labels where each came from", () => {
    const blocks: Block[] = [
      user,
      {
        kind: "code",
        text: "written file one",
        title: "src/one.ts",
        lang: "ts",
      },
      { kind: "assistant", text: "first reply\n\n```sql\nSELECT 1;\n```" },
      notice,
      {
        kind: "code",
        text: "written file two",
        title: "src/two.ts",
      },
      { kind: "assistant", text: "and\n\n```ts\nconst x = 1;\n```\n" },
    ]
    const blocksFound = collectCodeBlocks(blocks)
    expect(blocksFound.map((entry) => [entry.index, entry.label])).toEqual([
      [1, "ts sample"],
      [2, "src/two.ts"],
      [3, "sql sample"],
      [4, "src/one.ts"],
    ])
    expect(blocksFound[0]?.text).toBe("const x = 1;")
  })

  test("two samples in one reply are told apart", () => {
    const blocks: Block[] = [
      { kind: "assistant", text: "a\n```js\none();\n```\nb\n```js\ntwo();\n```" },
    ]
    expect(collectCodeBlocks(blocks).map((entry) => [entry.label, entry.text])).toEqual([
      ["js sample", "two();"],
      ["js sample", "one();"],
    ])
  })

  test("a reply with no fences contributes nothing", () => {
    expect(collectCodeBlocks([{ kind: "assistant", text: "just words" }])).toEqual([])
  })

  test("the limit keeps the newest", () => {
    const blocks: Block[] = [
      { kind: "code", text: "old", title: "a.ts" },
      { kind: "code", text: "new", title: "b.ts" },
    ]
    expect(collectCodeBlocks(blocks, { limit: 1 }).map((entry) => entry.label)).toEqual(["b.ts"])
  })

  test("an empty preview block is not offered", () => {
    expect(collectCodeBlocks([{ kind: "code", text: "   ", title: "empty.ts" }])).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import {
  isPendingToolCall,
  isToolCallAttempt,
  recoverTextToolCalls,
  retractStartFor,
  toolCallGuardIndex,
} from "../src"

const KNOWN = new Set(["write", "read", "shell"])
const isKnown = (name: string): boolean => KNOWN.has(name)

describe("tool-call recovery", () => {
  test("recovers a bare JSON tool call (the common small-model near-miss)", () => {
    const calls = recoverTextToolCalls(
      '{"name": "write", "arguments": {"path": "hello.txt", "content": "hi"}}',
      isKnown,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("write")
    expect(calls[0]!.input).toEqual({ path: "hello.txt", content: "hi" })
    expect(calls[0]!.id.startsWith("rec_")).toBe(true)
  })

  test("recovers a tool call wrapped in <tool_call> tags", () => {
    const calls = recoverTextToolCalls(
      '<tool_call>\n{"name": "shell", "arguments": {"command": "ls"}}\n</tool_call>',
      isKnown,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("shell")
    expect(calls[0]!.input).toEqual({ command: "ls" })
  })

  test("recovers tool calls inside a fenced code block", () => {
    const calls = recoverTextToolCalls(
      '```json\n{"name": "read", "arguments": {"path": "a.ts"}}\n```',
      isKnown,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("read")
  })

  test("recovers OpenAI-style {function:{name,arguments}} and string arguments", () => {
    const calls = recoverTextToolCalls(
      '{"function": {"name": "write", "arguments": "{\\"path\\": \\"x\\", \\"content\\": \\"y\\"}"}}',
      isKnown,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.input).toEqual({ path: "x", content: "y" })
  })

  test("recovers an array of tool calls", () => {
    const calls = recoverTextToolCalls(
      '[{"name": "read", "arguments": {"path": "a"}}, {"name": "shell", "arguments": {"command": "pwd"}}]',
      isKnown,
    )
    expect(calls.map((c) => c.name)).toEqual(["read", "shell"])
  })

  test("ignores JSON that does not name a registered tool", () => {
    expect(recoverTextToolCalls('{"name": "hello", "arguments": {}}', isKnown)).toEqual([])
    expect(recoverTextToolCalls('{"answer": 42}', isKnown)).toEqual([])
  })

  test("ignores ordinary prose that merely starts with a brace", () => {
    const calls = recoverTextToolCalls('{ In JSON, object keys are strings. }', isKnown)
    expect(calls).toEqual([])
  })

  test("recovers a payload that a sentence runs into", () => {
    const calls = recoverTextToolCalls(
      'Sure, writing that now.\n{"name": "write", "arguments": {"path": "a", "content": "b"}}',
      isKnown,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("write")
  })
})

describe("live stream guard", () => {
  const end = (text: string): number => text.length

  test("holds from the first brace of a bare JSON tool call", () => {
    expect(toolCallGuardIndex('{"name": "write", "arguments": {}}')).toBe(0)
  })

  test("lets ordinary prose stream", () => {
    expect(toolCallGuardIndex("Here is what I found.")).toBe(end("Here is what I found."))
    expect(toolCallGuardIndex("")).toBe(0)
  })

  test("lets an ordinary code block stream", () => {
    const code = "```js\nconst a = 1\n```"
    expect(toolCallGuardIndex(code)).toBe(end(code))
  })

  test("holds a fence that opens a JSON payload", () => {
    expect(toolCallGuardIndex('```json\n{"name": "write"}')).toBe(0)
  })

  test("stops where a sentence runs into JSON", () => {
    const text = 'Writing now: {"name": "write"}'
    expect(toolCallGuardIndex(text)).toBe(text.indexOf("{"))
  })

  test("holds a marker split across two deltas", () => {
    expect(toolCallGuardIndex("<tool")).toBe(0)
    expect(toolCallGuardIndex("a `")).toBe(2)
  })

  test("walks back over the fence a payload sits in", () => {
    const text = 'Let me write it.\n```json\n{"name": "write"}'
    expect(retractStartFor(text, toolCallGuardIndex(text))).toBe(text.indexOf("```"))
  })

  test("does not walk back over a finished code block", () => {
    const text = '```js\nconst a = 1\n```\n{"answer": 42}'
    const guard = toolCallGuardIndex(text)
    expect(guard).toBe(text.indexOf('{"answer"'))
    expect(retractStartFor(text, guard)).toBe(guard)
  })

  test("tells a tool attempt apart from an ordinary JSON answer", () => {
    expect(isToolCallAttempt('{"name": "nope", "arguments": {}}')).toBe(true)
    expect(isToolCallAttempt("<tool_call>oops</tool_call>")).toBe(true)
    expect(isToolCallAttempt('{"answer": 42}')).toBe(false)
    expect(isToolCallAttempt('{"name": "myapp"}')).toBe(false)
  })

  test("flags a payload that stopped mid-write", () => {
    expect(isPendingToolCall('{"name": "write", "argu')).toBe(true)
    expect(isPendingToolCall("<tool_ca")).toBe(true)
    expect(isPendingToolCall('{"name": "write", "arguments": {}}')).toBe(false)
    expect(isPendingToolCall("just prose")).toBe(false)
  })
})

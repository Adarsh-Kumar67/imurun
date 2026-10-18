import { describe, expect, test } from "bun:test"
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW,
  MAX_MESSAGE_CHARS,
  assembleModelMessages,
  compactArgsForModel,
  planCompaction,
  planHistoryChars,
  toModelMessage,
  truncateForContext,
} from "../src/agent/context"
import type { Message } from "@imurun/schema"

let counter = 0
function message(partial: Partial<Message> & { role: Message["role"]; content: string }): Message {
  counter++
  return {
    id: partial.id ?? `msg_${counter}`,
    sessionId: "ses_test",
    createdAt: counter,
    ...partial,
  } as Message
}

describe("planHistoryChars", () => {
  test("scales with the window", () => {
    const small = planHistoryChars(4096)
    const large = planHistoryChars(32768)
    expect(large).toBeGreaterThan(small * 6)
  })

  test("leaves room for the answer and for the fixed part of the prompt", () => {
    const total = 32768 * CHARS_PER_TOKEN
    const budget = planHistoryChars(32768)
    expect(budget).toBeLessThan(total * 0.85)
    expect(planHistoryChars(32768, 20_000)).toBeLessThan(budget)
  })

  test("never returns a budget below a floor, even for an absurd window", () => {
    expect(planHistoryChars(1, 100_000)).toBeGreaterThanOrEqual(1_500)
  })

  test("has a sane default window when the runtime could not say", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThanOrEqual(4096)
    expect(planHistoryChars(DEFAULT_CONTEXT_WINDOW)).toBeGreaterThan(5_000)
  })
})

describe("truncateForContext", () => {
  test("leaves short text alone", () => {
    expect(truncateForContext("hello", 100)).toBe("hello")
  })

  test("keeps the head and the tail, and says how much went", () => {
    const text = `START${"x".repeat(2000)}END`
    const result = truncateForContext(text, 200)
    expect(result.startsWith("START")).toBe(true)
    expect(result.endsWith("END")).toBe(true)
    expect(result).toContain("characters omitted")
    expect(result.length).toBeLessThan(400)
  })
})

describe("compactArgsForModel", () => {
  test("keeps short arguments exactly as they were", () => {
    const args = { path: "src/app.ts", mode: "append" }
    expect(compactArgsForModel(args)).toEqual(args)
  })

  test("shrinks a long file body but keeps the shape of the call", () => {
    const args = { path: "src/app.ts", content: "y".repeat(50_000), mode: "overwrite" }
    const compacted = compactArgsForModel(args) as Record<string, unknown>
    expect(compacted.path).toBe("src/app.ts")
    expect(compacted.mode).toBe("overwrite")
    expect(String(compacted.content).length).toBeLessThan(1_000)
    expect(String(compacted.content)).toContain("more characters not replayed")
  })

  test("recurses into nested objects and arrays", () => {
    const compacted = compactArgsForModel({ edits: [{ old: "a".repeat(2000), next: 1 }] }) as {
      edits: Array<{ old: string; next: number }>
    }
    expect(compacted.edits[0]!.next).toBe(1)
    expect(compacted.edits[0]!.old.length).toBeLessThan(1_000)
  })
})

describe("planCompaction", () => {
  test("keeps everything that fits", () => {
    const messages = [
      message({ role: "user", content: "hello" }),
      message({ role: "assistant", content: "hi there" }),
    ]
    const plan = planCompaction(messages, { maxChars: 10_000 })
    expect(plan.kept).toHaveLength(2)
    expect(plan.dropped).toHaveLength(0)
  })

  test("drops the oldest first and reports what went", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      message({ role: "user", content: `message number ${i} ${"x".repeat(200)}` }),
    )
    const plan = planCompaction(messages, { maxChars: 900 })
    expect(plan.kept.length).toBeGreaterThan(0)
    expect(plan.kept.length).toBeLessThan(messages.length)
    expect(plan.dropped.length).toBeGreaterThan(0)
    // kept is a suffix of the history, so the ids are contiguous
    expect(plan.kept[0]!.id).toBe(messages[messages.length - plan.kept.length]!.id)
    expect(plan.upToMessageId).toBe(plan.dropped.at(-1)!.id)
    expect(plan.droppedChars).toBeGreaterThan(0)
  })

  test("always keeps the minimum number of recent messages", () => {
    const messages = [
      message({ role: "user", content: "a".repeat(5000) }),
      message({ role: "assistant", content: "b".repeat(5000) }),
    ]
    const plan = planCompaction(messages, { maxChars: 10, minMessages: 2 })
    expect(plan.kept).toHaveLength(2)
  })

  test("a huge write argument does not inflate the accounting", () => {
    // The body of a `write` call is compacted before it is ever replayed, so a
    // 20 KB file must not push an ordinary turn out of the window.
    const toolCall = message({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "write", args: { path: "big.ts", content: "z".repeat(20_000) } }],
    })
    const history = [message({ role: "user", content: "go" }), toolCall]
    const generous = planCompaction(history, { maxChars: 4_000, minMessages: 1 })
    expect(generous.kept.map((item) => item.id)).toContain(toolCall.id)

    // and the payload really is small once assembled for the model
    expect(JSON.stringify(assembleModelMessages(history)).length).toBeLessThan(2_000)
  })

  test("respects maxMessages by dropping the excess", () => {
    const messages = Array.from({ length: 12 }, (_, i) => message({ role: "user", content: `m${i}` }))
    const plan = planCompaction(messages, { maxChars: 100_000, maxMessages: 5 })
    expect(plan.kept).toHaveLength(5)
    expect(plan.dropped).toHaveLength(7)
  })
})

describe("assembleModelMessages", () => {
  test("converts roles and skips stored system messages", () => {
    const messages = [
      message({ role: "system", content: "you are a test" }),
      message({ role: "user", content: "hello" }),
      message({ role: "assistant", content: "hi" }),
    ]
    const model = assembleModelMessages(messages)
    expect(model).toHaveLength(2)
    expect(model[0]).toEqual({ role: "user", content: "hello" })
  })

  test("drops a leading orphaned tool result", () => {
    const messages = [
      message({ role: "tool", content: "result", toolCallId: "call_1" }),
      message({ role: "assistant", content: "there you go" }),
    ]
    const model = assembleModelMessages(messages)
    expect(model).toHaveLength(1)
    expect(model[0]!.role).toBe("assistant")
  })

  test("omits tool-call arguments that no longer need replaying", () => {
    const messages = [
      message({
        role: "assistant",
        content: "",
        toolCallId: undefined,
        toolCalls: [{ id: "call_1", name: "write", args: { path: "a.ts", content: "q".repeat(9000) } }],
      }),
    ]
    const model = assembleModelMessages(messages)
    const serialised = JSON.stringify(model)
    expect(serialised).toContain("a.ts")
    expect(serialised.length).toBeLessThan(2_000)
  })

  test("truncates an oversized tool result instead of failing", () => {
    const huge = message({ role: "tool", content: "t".repeat(200_000), toolCallId: "call_1" })
    const converted = toModelMessage(huge, { maxMessageChars: MAX_MESSAGE_CHARS })
    const text = (converted as { content: Array<{ output: { value: string } }> }).content[0]!.output.value
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 200)
    expect(text).toContain("characters omitted")
  })

  test("never emits a message with neither text nor tool calls", () => {
    const model = assembleModelMessages([message({ role: "assistant", content: "" })])
    expect(model).toHaveLength(0)
  })
})

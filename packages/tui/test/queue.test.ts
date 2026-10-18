import { describe, expect, test } from "bun:test"
import { MessageQueue, formatQueue } from "../src/queue"

describe("MessageQueue", () => {
  test("keeps messages in order", () => {
    const queue = new MessageQueue()
    queue.push("first", 1)
    queue.push("second", 2)
    expect(queue.size).toBe(2)
    expect(queue.peek()?.text).toBe("first")
    expect(queue.shift()?.text).toBe("first")
    expect(queue.shift()?.text).toBe("second")
    expect(queue.shift()).toBeUndefined()
    expect(queue.pending).toBe(false)
  })

  test("assigns growing ids", () => {
    const queue = new MessageQueue()
    expect(queue.push("a").id).toBe(1)
    expect(queue.push("b").id).toBe(2)
  })

  test("removes by id and moves within the list", () => {
    const queue = new MessageQueue()
    const a = queue.push("a")
    queue.push("b")
    const c = queue.push("c")
    expect(queue.remove(a.id)).toBe(true)
    expect(queue.list().map((item) => item.text)).toEqual(["b", "c"])
    expect(queue.move(c.id, -1)).toBe(true)
    expect(queue.list().map((item) => item.text)).toEqual(["c", "b"])
    // clamped at the edges
    expect(queue.move(c.id, -5)).toBe(false)
    expect(queue.list().map((item) => item.text)).toEqual(["c", "b"])
    expect(queue.remove(999)).toBe(false)
  })

  test("caps the queue and clears it", () => {
    const queue = new MessageQueue(3)
    for (let i = 0; i < 5; i++) queue.push(`m${i}`)
    expect(queue.size).toBe(3)
    expect(queue.peek()?.text).toBe("m2")
    queue.clear()
    expect(queue.size).toBe(0)
  })
})

describe("formatQueue", () => {
  test("labels the count and numbers the items", () => {
    const queue = new MessageQueue()
    queue.push("do the thing")
    queue.push("then the other thing")
    const lines = formatQueue(queue.list(), 60)
    expect(lines[0]).toContain("queued (2)")
    expect(lines[1]).toContain("1. do the thing")
    expect(lines[2]).toContain("2. then the other thing")
  })

  test("is empty when nothing is queued", () => {
    expect(formatQueue([], 60)).toEqual([])
  })
})

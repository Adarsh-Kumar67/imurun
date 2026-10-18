/**
 * Message queue — messages the user sends while the agent is still working.
 *
 * Sending during a turn should never be rejected and never clobber the turn in
 * flight: the message is parked here and drained, in order, as soon as the
 * current turn finishes (or is interrupted). The user can also reorder or drop
 * queued items before they run.
 */
import { truncateVisible } from "./text"

export interface QueuedMessage {
  id: number
  text: string
  /** ms epoch, for display and stable ordering. */
  at: number
}

export class MessageQueue {
  private items: QueuedMessage[] = []
  private nextId = 1

  constructor(private readonly limit = 50) {}

  push(text: string, now = Date.now()): QueuedMessage {
    const item: QueuedMessage = { id: this.nextId++, text, at: now }
    this.items.push(item)
    if (this.items.length > this.limit) this.items.shift()
    return item
  }

  shift(): QueuedMessage | undefined {
    return this.items.shift()
  }

  peek(): QueuedMessage | undefined {
    return this.items[0]
  }

  get size(): number {
    return this.items.length
  }

  get pending(): boolean {
    return this.items.length > 0
  }

  list(): readonly QueuedMessage[] {
    return this.items
  }

  remove(id: number): boolean {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    return true
  }

  /** Moves an item by `delta` positions, clamped to the ends. */
  move(id: number, delta: number): boolean {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0 || delta === 0) return false
    const next = Math.min(Math.max(index + delta, 0), this.items.length - 1)
    if (next === index) return false
    const [item] = this.items.splice(index, 1)
    if (!item) return false
    this.items.splice(next, 0, item)
    return true
  }

  clear(): void {
    this.items = []
  }
}

/** Renders the queue as dim lines for the transcript area. */
export function formatQueue(items: readonly QueuedMessage[], width: number): string[] {
  if (items.length === 0) return []
  const lines = [`  queued (${items.length})`]
  items.slice(0, 8).forEach((item, index) => {
    lines.push(`   ${index + 1}. ${truncateVisible(item.text.replace(/\s+/g, " "), Math.max(width - 8, 10))}`)
  })
  if (items.length > 8) lines.push(`   \u2026 ${items.length - 8} more`)
  return lines
}

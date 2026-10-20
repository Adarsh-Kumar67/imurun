/**
 * How long a memory stays worth pinning into a prompt.
 *
 * Retention is data, not a chain of `if (kind === ...)`: every kind declares a
 * half-life, every access makes a note stronger, and the two combine into one
 * score. A credential you use daily outranks a style note you touched once
 * months ago; a todo that has been open for a year has faded on its own.
 *
 * The score is deliberately simple and explainable. It is used to order
 * durable notes and to decide which ones fall outside the prompt limit.
 */
import type { MemoryKind } from "@imurun/schema"

/** Days after which half of a note's strength is considered gone. */
export const KIND_HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  credential: 3650,
  fact: 1095,
  preference: 730,
  user_style: 365,
  todo: 30,
  note: 120,
  session_summary: 90,
}

const DAY_MS = 86_400_000

export interface Retainable {
  kind: MemoryKind
  updatedAt: number
  usageCount: number
}

/**
 * Decay from age, multiplied by a logarithmic use bonus.
 *
 * `1 + ln(1 + uses)` rather than `uses` keeps a note that happens to match a
 * common word from burying everything else after a dozen recalls.
 */
export function retentionScore(record: Retainable, now = Date.now()): number {
  const halfLife = KIND_HALF_LIFE_DAYS[record.kind] ?? KIND_HALF_LIFE_DAYS.note
  const ageDays = Math.max(0, (now - record.updatedAt) / DAY_MS)
  const decay = Math.pow(0.5, ageDays / halfLife)
  const strength = 1 + Math.log1p(Math.max(0, record.usageCount))
  return decay * strength
}

/** Newest and most-used first, with the kind's half-life taken into account. */
export function rankByRetention<T extends Retainable>(records: readonly T[], now = Date.now()): T[] {
  return [...records].sort((a, b) => retentionScore(b, now) - retentionScore(a, now))
}

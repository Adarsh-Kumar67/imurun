/**
 * ID generation — short, sortable, collision-resistant IDs.
 *
 * Format: <base36 time><random suffix>, optionally prefixed, e.g.
 *   ses_m3k2p1a9x8f2q7
 */
import { randomBytes, randomUUID } from "node:crypto"

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

function randomString(length: number): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

/** Generates a sortable ID with an optional prefix, e.g. newId("ses"). */
export function newId(prefix?: string): string {
  const time = Date.now().toString(36)
  const id = `${time}${randomString(9)}`
  return prefix ? `${prefix}_${id}` : id
}

/** Standard UUID v4 for cases that need one (e.g. HTTP headers). */
export function uuid(): string {
  return randomUUID()
}

/** Random hex token of `bytes` length (default 32 = 64 hex chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex")
}

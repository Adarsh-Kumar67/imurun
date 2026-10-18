/**
 * Crypto helpers — AES-256-GCM encryption for the credential vault.
 *
 * Payload format (versioned for future migration):
 *   { v: 1, iv: base64, tag: base64, data: base64 }
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const IV_BYTES = 12 // GCM standard

export interface EncryptedPayload {
  v: 1
  iv: string
  tag: string
  data: string
}

/** Generates a fresh 256-bit key for the vault. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** Encodes a key for storage (keychain entries, env vars). */
export function encodeKey(key: Buffer): string {
  return key.toString("base64")
}

/** Decodes a stored key; throws on malformed input. */
export function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64")
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid key length: expected ${KEY_BYTES} bytes, got ${key.length}`)
  }
  return key
}

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  if (key.length !== KEY_BYTES) throw new Error("encrypt: key must be 32 bytes")
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  }
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error("decrypt: key must be 32 bytes")
  if (payload.v !== 1) throw new Error(`decrypt: unsupported payload version ${payload.v}`)
  const iv = Buffer.from(payload.iv, "base64")
  const tag = Buffer.from(payload.tag, "base64")
  const data = Buffer.from(payload.data, "base64")
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

/** Serializes a payload for storage in the memory table. */
export function serializePayload(payload: EncryptedPayload): string {
  return JSON.stringify(payload)
}

/** Parses a stored payload; throws when the record is corrupt. */
export function parsePayload(serialized: string): EncryptedPayload {
  const parsed = JSON.parse(serialized) as Partial<EncryptedPayload>
  if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.data !== "string") {
    throw new Error("parsePayload: malformed encrypted payload")
  }
  return parsed as EncryptedPayload
}

/** Constant-time string comparison (for tokens and hashes). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Masks a secret for display: "ghp_1234567890abc" -> "ghp_…abc". */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "\u2026"
  return `${secret.slice(0, 4)}\u2026${secret.slice(-3)}`
}

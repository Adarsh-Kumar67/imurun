/**
 * Hash helpers — content hashing for change detection and integrity checks.
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

/** SHA-256 of a string or byte buffer, returned as lowercase hex. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Streaming SHA-256 of a file — safe for multi-GB model downloads. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  return hash.digest("hex")
}

/** Short stable hash for cache keys and change detection. */
export function shortHash(input: string, length = 12): string {
  return sha256(input).slice(0, length)
}

/** Non-cryptographic FNV-1a hash — fast, for in-memory lookups only. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

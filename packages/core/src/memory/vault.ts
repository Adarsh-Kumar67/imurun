/**
 * The credential vault — one machine key, used to encrypt secrets at rest.
 *
 * A secret the user asks IMURUN to keep (a token, a password) is written into
 * the same human-readable files as every other note, so it is encrypted first.
 * The key is 32 random bytes in `~/.imurun/key`, created on first use, readable
 * only by the user, and never printed, logged or sent anywhere. If that file is
 * lost the secrets it protected cannot be recovered — which is the point of
 * encrypting them rather than leaving them in a markdown file.
 *
 * The key is not a password and is not derived from one: it protects against a
 * secret leaking through a copy of `notes.md` (a sync folder, a support bundle,
 * a screenshot), not against someone with the machine.
 */
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  decodeKey,
  decrypt,
  encodeKey,
  encrypt,
  ensureDir,
  generateKey,
  imurunDir,
  parsePayload,
  serializePayload,
} from "@imurun/util"

/** Prefix on a sealed value, so a human reading the file knows what it is. */
export const SEALED_PREFIX = "enc:"

let cached: Buffer | undefined

/** Where the machine key lives. */
export function vaultKeyPath(): string {
  return join(imurunDir(), "key")
}

/** True when a value has already been sealed. */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

/** Loads the machine key, creating it on first use. */
export async function vaultKey(): Promise<Buffer> {
  if (cached) return cached
  const path = vaultKeyPath()

  try {
    const encoded = (await readFile(path, "utf8")).trim()
    if (encoded) {
      cached = decodeKey(encoded)
      return cached
    }
  } catch {
    // No key yet — this is the first secret this machine has kept.
  }

  const key = generateKey()
  await ensureDir(imurunDir())
  await writeFile(path, `${encodeKey(key)}\n`, { mode: 0o600 })
  // Windows ignores the mode above; tighten it where the platform honours chmod.
  await chmod(path, 0o600).catch(() => {})
  cached = key
  return key
}

/** Encrypts a secret for storage, marked so the file stays readable. */
export async function sealSecret(plaintext: string): Promise<string> {
  if (isSealed(plaintext)) return plaintext
  return SEALED_PREFIX + serializePayload(encrypt(plaintext, await vaultKey()))
}

/**
 * Decrypts a stored secret. Returns undefined when it is unreadable (a missing
 * or rotated key, a corrupt payload) so a lost secret never breaks a run.
 */
export async function openSecret(sealed: string): Promise<string | undefined> {
  if (!isSealed(sealed)) return sealed
  try {
    return decrypt(parsePayload(sealed.slice(SEALED_PREFIX.length)), await vaultKey())
  } catch {
    return undefined
  }
}

/** Forgets the cached key. Tests only. */
export function resetVaultKeyCache(): void {
  cached = undefined
}

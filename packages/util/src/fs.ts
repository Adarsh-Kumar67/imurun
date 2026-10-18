/**
 * Filesystem helpers — atomic writes, JSON helpers, directory utilities.
 */
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { dirname, join, resolve } from "node:path"

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

/** Writes a file via temp-file + rename so readers never see partial content. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8")
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export async function writeJsonAtomic(path: string, value: unknown, pretty = true): Promise<void> {
  const data = pretty ? JSON.stringify(value, null, 2) + "\n" : JSON.stringify(value)
  await writeFileAtomic(path, data)
}

/** Removes a file or directory if it exists; never throws for missing paths. */
export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Recursively measures the total size of a directory in bytes. */
export async function directorySize(path: string): Promise<number> {
  let total = 0
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(full)
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size
      } catch {
        // raced with a delete; ignore
      }
    }
  }
  return total
}

/** Free disk space in bytes for the volume containing `path`, or undefined if unavailable. */
export async function freeDiskBytes(path: string): Promise<number | undefined> {
  try {
    const { statfs } = await import("node:fs/promises")
    // the path itself may not exist yet (e.g. before the first model install) —
    // walk up to the nearest existing ancestor
    let current = resolve(path)
    for (let depth = 0; depth < 32; depth++) {
      try {
        const stats = await statfs(current)
        return Number(stats.bavail) * Number(stats.bsize)
      } catch {
        const parent = dirname(current)
        if (parent === current) return undefined
        current = parent
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Expands a leading ~ to the user's home directory. */
export function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    return join(home, path.slice(2))
  }
  return path
}

/**
 * A directory walker that never throws.
 *
 * The index has to walk whatever directory the user pointed IMURUN at, and
 * that directory is often not a tidy source tree: it may be a home directory,
 * a drive root, or a checkout that sits next to `AppData`. Any of those can
 * hold a directory the process may not read — `WinSAT` under
 * `AppData\Local\Temp` raises `EPERM` on Windows, and `/proc` raises `EACCES`
 * on Linux.
 *
 * A glob scan treats that as a fatal error for the whole walk. This walker
 * treats it as a fact about one directory: skip it, say nothing, keep going.
 * The index is an optimisation, and a directory it cannot read is a directory
 * it does not need.
 *
 * Two rules keep the walk small and safe:
 *
 *   - **System and hidden directories are skipped by name.** `AppData`,
 *     `Application Data`, `Temp`, `node_modules`, `.git` and friends are
 *     skipped before they are opened, so the walk never even tries.
 *   - **Everything is optional.** A directory that cannot be listed, a file
 *     that vanished, a symlink loop — each is skipped, and the walk carries on.
 */

import { join } from "node:path"

/** Directory names that are never worth indexing, on any platform. */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  // Windows
  "appdata",
  "application data",
  "local settings",
  "history",
  "cookies",
  "microsoft",
  "windows",
  "system volume information",
  "recovery",
  "$recycle.bin",
  "perflogs",
  // Everywhere
  "node_modules",
  "vendor",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".m2",
  ".npm",
  ".cargo",
  ".bun",
  ".cache",
  "site-packages",
  "dist-newstyle",
  "target",
  "bin",
  "obj",
  "debug",
  "release",
  // macOS
  "library",
  "system",
  "caches",
  "volumes",
])

/** True when a directory entry should not be descended into. */
export function isSkippedDirectory(name: string): boolean {
  if (!name) return true
  const lower = name.toLowerCase()
  if (SKIP_DIRECTORIES.has(lower)) return true
  // A dot-directory is hidden by convention on every platform.
  if (name.startsWith(".")) return true
  // Windows keeps some of its system names with a trailing space or a special
  // character; the lower-cased comparison above catches the common ones.
  return false
}

export interface WalkOptions {
  /** Where the walk starts. */
  root: string
  /** The largest number of files to return. */
  maxFiles?: number
  /** The largest file to consider, in bytes. */
  maxFileBytes?: number
  /** Called for every candidate; return false to skip it. */
  accept?: (relativePath: string, absolutePath: string) => boolean
  /** How deep the walk may go. A source tree rarely needs more. */
  maxDepth?: number
}

export interface WalkResult {
  /** Project-relative paths, sorted, of the files that were accepted. */
  files: string[]
  /** Directories that could not be read, for the log — never fatal. */
  skipped: string[]
}

/** The error codes that mean "not allowed", across platforms. */
function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  return code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "ELOOP"
}

/**
 * Walks the tree and returns the files that were accepted.
 *
 * Never throws: a directory that cannot be read is recorded and skipped.
 */
export async function walkFiles(options: WalkOptions): Promise<WalkResult> {
  const { root, maxFiles = 5_000, maxFileBytes = 512 * 1024, accept, maxDepth = 24 } = options
  const files: string[] = []
  const skipped: string[] = []

  // An explicit stack, so a deep tree cannot blow the call stack.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.pop()!
    if (current.depth > maxDepth) continue

    let entries: Awaited<ReturnType<typeof readDirSafe>> = []
    try {
      entries = await readDirSafe(current.dir)
    } catch (error) {
      if (isPermissionError(error)) skipped.push(current.dir)
      continue
    }

    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith(".")) continue
      const absolute = join(current.dir, name)
      const relative = absolute.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/")
      if (!relative) continue

      let isDirectory = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        // A symlink can point anywhere, including back up the tree. Resolve it
        // once and refuse to follow it into a cycle.
        const target = await statSafe(absolute)
        if (!target) continue
        isDirectory = target.isDirectory()
        const key = target.isDirectory() ? absolute : `${absolute}:${target.size}`
        if (seen.has(key)) continue
        seen.add(key)
      }

      if (isDirectory) {
        if (isSkippedDirectory(name)) continue
        queue.push({ dir: absolute, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile()) continue
      if (accept && !accept(relative, absolute)) continue
      files.push(relative)
      if (files.length >= maxFiles) return { files: files.sort(), skipped }
    }
  }

  return { files: files.sort(), skipped }
}

type DirEntry = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }

/** `readdir` that reports what it can, rather than failing on one bad name. */
async function readDirSafe(dir: string): Promise<DirEntry[]> {
  const { readdir } = await import("node:fs/promises")
  return (await readdir(dir, { withFileTypes: true })) as unknown as DirEntry[]
}

async function statSafe(path: string): Promise<Awaited<ReturnType<typeof import("node:fs/promises").stat>> | undefined> {
  try {
    const { stat } = await import("node:fs/promises")
    return await stat(path)
  } catch {
    return undefined
  }
}

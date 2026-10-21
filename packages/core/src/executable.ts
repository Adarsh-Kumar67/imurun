/**
 * Replacing or removing the program that is currently running.
 *
 * A program that can be installed three ways (npm, pip, a downloaded binary)
 * has to be able to update itself three ways, and the binary case is the one
 * with a catch: on Windows a running executable cannot be overwritten or
 * deleted, only renamed. So the update is always "write beside it, then move
 * it into place", and the old image is left under a name that the next start
 * sweeps away.
 *
 * Nothing here downloads anything. It takes bytes that were already fetched,
 * checks that they are a program for this machine (never an HTML error page),
 * and moves them into position - with a rollback if the move fails, because a
 * failed update must leave a working program behind.
 */
import {
  chmodSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, dirname, join } from "node:path"

export interface ReplaceResult {
  replaced: boolean
  /** The old program, when it had to be renamed out of the way. */
  backup?: string
}

export interface RemoveResult {
  removed: boolean
  /** A file that will disappear shortly after this process exits. */
  pending?: string
  error?: string
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A name no other update or run can collide with. */
function unique(): string {
  return `${process.pid}-${Date.now()}`
}

/**
 * True when the first bytes are the magic number for an executable on
 * `platform` (PE, ELF or Mach-O). A proxy or a captive portal answers with
 * HTML, and an HTML page written over the program would brick the install.
 */
export function looksExecutable(
  bytes: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (bytes.byteLength < 64) return false
  const startsWith = (offset: number, text: string): boolean => {
    for (let index = 0; index < text.length; index++) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }

  switch (platform) {
    case "win32":
      return startsWith(0, "MZ")
    case "darwin":
      // Mach-O 64 in both byte orders, and the universal ("fat") header.
      return (
        (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
        (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && bytes[3] === 0xcf) ||
        (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe)
      )
    default:
      return bytes[0] === 0x7f && startsWith(1, "ELF")
  }
}

/**
 * Puts `bytes` at `target`, replacing the program.
 *
 * POSIX: write a sibling file and rename it over the target, which is atomic,
 * so a crash leaves either the old program or the new one - never a half one.
 *
 * Windows: rename the running program aside, move the new one into its place,
 * then try to delete the old one. The delete normally fails while the program
 * is running, which is fine: it is renamed and swept up on the next start.
 */
export function replaceExecutable(
  target: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): ReplaceResult {
  if (!looksExecutable(bytes, platform)) {
    throw new Error("the download is not a program for this machine")
  }

  const directory = dirname(target)
  const name = basename(target)
  const fresh = join(directory, `${name}.new-${unique()}`)
  writeFileSync(fresh, bytes)
  if (platform !== "win32") chmodSync(fresh, 0o755)

  if (platform === "win32") {
    const backup = join(directory, `${name}.old-${unique()}`)
    renameSync(target, backup)
    try {
      renameSync(fresh, target)
    } catch (error) {
      // Put the working program back before reporting the failure.
      renameSync(backup, target)
      try {
        unlinkSync(fresh)
      } catch {
        // The next start sweeps it.
      }
      throw error
    }
    // The old image is still mapped by this process, so the delete here
    // normally fails; the scheduled removal and the next start both try.
    try {
      unlinkSync(backup)
    } catch {
      scheduleRemoval(backup)
    }
    return { replaced: true, backup }
  }

  renameSync(fresh, target)
  return { replaced: true }
}

/**
 * Asks Windows to delete `path` a moment after this process exits.
 *
 * A running executable cannot be deleted, only renamed, so the renamed copy
 * needs someone to remove it once this process is gone. A child process will
 * not do: on Windows the whole process tree is killed with the parent, so the
 * deletion is handed to the Task Scheduler instead, which runs it from the
 * service - outside this process entirely - and then deletes the task. If
 * scheduling fails, the sweep at the next start is the fallback.
 */
function scheduleRemoval(path: string): void {
  const task = `ImurunCleanup-${process.pid}-${Date.now()}`
  const command =
    `cmd /c ping -n 3 127.0.0.1 >nul & del /f /q "${path}"` +
    ` & schtasks /delete /tn "${task}" /f`
  try {
    const created = spawnSync(
      "schtasks",
      ["/create", "/f", "/sc", "once", "/st", "23:59", "/tn", task, "/tr", command],
      { stdio: "ignore", windowsHide: true },
    )
    if ((created.status ?? 1) !== 0) return
    spawnSync("schtasks", ["/run", "/tn", task], { stdio: "ignore", windowsHide: true })
  } catch {
    // Left for the next start's sweep; never a reason to fail.
  }
}

/**
 * Removes the program. On Windows the running image is renamed first and a
 * detached shell deletes it after this process ends.
 */
export function removeExecutable(
  target: string,
  platform: NodeJS.Platform = process.platform,
): RemoveResult {
  if (!existsSync(target)) return { removed: true }

  if (platform === "win32") {
    const backup = join(dirname(target), `${basename(target)}.old-${unique()}`)
    try {
      renameSync(target, backup)
    } catch (error) {
      return { removed: false, error: reason(error) }
    }
    scheduleRemoval(backup)
    return { removed: true, pending: backup }
  }

  try {
    unlinkSync(target)
    return { removed: true }
  } catch (error) {
    return { removed: false, error: reason(error) }
  }
}

/**
 * Deletes the leftovers of a previous update: the renamed old program and any
 * half-written new one. Called at startup, where the old image is no longer
 * running and the files are free.
 */
export function cleanupStaleExecutables(
  directory: string = dirname(process.execPath),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return removed
  }

  for (const entry of entries) {
    if (platform !== "win32" && !entry.includes(".new-")) continue
    // Only names this module writes: <program>.old-<pid>-<time> and
    // <program>.new-<pid>-<time>.
    if (!/\.(old|new)-\d+-\d+$/.test(entry)) continue
    const path = join(directory, entry)
    try {
      if (!statSync(path).isFile()) continue
      unlinkSync(path)
      removed.push(path)
    } catch {
      // Still mapped, or already gone. Neither is a problem.
    }
  }
  return removed
}

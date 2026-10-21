/**
 * Uninstalling IMURUN.
 *
 * There are three things on a machine after an install, and they are not the
 * same kind of thing:
 *
 *   1. **The program.** The npm package and its platform executables, the pip
 *      package, or a standalone binary. This is what "uninstall" removes.
 *   2. **The cached executable** the pip launcher downloads
 *      (`~/.imurun/python`). Also the program, so also removed.
 *   3. **Your data.** Models, the memory vault, sessions, configuration —
 *      everything under `~/.imurun`. Measured in gigabytes, and not
 *      replaceable by reinstalling. **Kept** unless `--purge` is given
 *      explicitly.
 *
 * Getting that distinction wrong is expensive in one direction only: deleting
 * someone's models because they wanted to upgrade is not recoverable, while
 * leaving a few files behind costs nothing. So the default is to keep them,
 * and the removal is spelled out before it happens.
 */
import { existsSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { imurunDir, logger } from "@imurun/util"
import { detectInstallMethod, type InstallMethod } from "./update"

export interface UninstallOptions {
  /** Also remove `~/.imurun`: models, memory, sessions, configuration. */
  purge?: boolean
  /** Say what would happen, and change nothing. */
  dryRun?: boolean
  /** The npm executable to use. */
  npmCommand?: string
}

export interface UninstallResult {
  /** What was actually removed. */
  removed: string[]
  /** What was deliberately left behind. */
  kept: string[]
  /** What could not be removed, and why. */
  errors: string[]
  /** How the program was installed. */
  method: InstallMethod
}

/** The npm executable for this platform. */
function defaultNpm(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

/** Runs a command and reports whether it succeeded. */
function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" })
  return (result.status ?? 1) === 0
}

/**
 * Removes the program, and leaves the data alone.
 *
 * Safe to run more than once: what is already gone is reported as gone.
 */
export function uninstall(options: UninstallOptions = {}): UninstallResult {
  const method = detectInstallMethod()
  const removed: string[] = []
  const kept: string[] = []
  const errors: string[] = []
  const home = imurunDir()
  const npm = options.npmCommand ?? defaultNpm()

  // ── the program ──────────────────────────────────────────────────────────
  if (method === "npm" || method === "unknown") {
    if (options.dryRun) {
      removed.push("the npm package (npm uninstall -g imurun)")
    } else if (run(npm, ["uninstall", "-g", "imurun"])) {
      removed.push("the npm package")
    } else {
      // Not there, or npm could not do it. Either way the program may still
      // be installed another way, so this is a note rather than a failure.
      logger.debug("npm did not report removing imurun; it may be installed another way")
      errors.push("npm could not remove imurun — it may not have been installed with npm")
    }
    // The executables come with it, but npm leaves them if they were not
    // pulled in as dependencies.
    for (const name of ["imurun-windows-x64", "imurun-linux-x64", "imurun-linux-arm64", "imurun-darwin-x64", "imurun-darwin-arm64"]) {
      if (options.dryRun) continue
      run(npm, ["uninstall", "-g", name])
    }
  }

  if (method === "pip" || method === "unknown") {
    if (options.dryRun) {
      removed.push("the pip package (python -m pip uninstall -y imurun)")
    } else if (run(process.execPath, ["-m", "pip", "uninstall", "-y", "imurun"])) {
      removed.push("the pip package")
    } else {
      logger.debug("pip did not report removing imurun; it may not have been installed with pip")
    }
  }

  // ── the executable the pip launcher downloaded ───────────────────────────
  const cache = join(home, "python")
  if (existsSync(cache)) {
    if (options.dryRun) {
      removed.push(`the downloaded executable (${cache})`)
    } else {
      try {
        rmSync(cache, { recursive: true, force: true })
        removed.push("the downloaded executable")
      } catch (error) {
        errors.push(`could not remove ${cache}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ── your data ────────────────────────────────────────────────────────────
  const durable = ["models", "engines", "memory", "vault", "data", "rag", "logs", "runtime"]
  if (options.purge) {
    if (existsSync(home)) {
      if (options.dryRun) {
        removed.push(`everything under ${home}`)
      } else {
        try {
          rmSync(home, { recursive: true, force: true })
          removed.push("models, memory, sessions and configuration")
        } catch (error) {
          errors.push(`could not remove ${home}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  } else {
    kept.push(`models, memory, sessions and configuration (${home})`)
    for (const name of durable) if (existsSync(join(home, name))) kept.push(join(home, name))
  }

  return { removed, kept, errors, method }
}

/** A plain description of how the program was installed. */
export function describeInstallMethod(method: InstallMethod): string {
  switch (method) {
    case "npm":
      return "npm (npm install -g imurun)"
    case "pip":
      return "pip (pip install imurun)"
    case "binary":
      return "a standalone binary"
    default:
      return "an unknown method"
  }
}

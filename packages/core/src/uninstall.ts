/**
 * Uninstalling IMURUN.
 *
 * There are three things on a machine after an install, and they are not the
 * same kind of thing:
 *
 *   1. **The program.** The npm/bun/pnpm package and its platform executables,
 *      the pip package, or a standalone binary. This is what "uninstall"
 *      removes.
 *   2. **The cached executable** the pip launcher downloads
 *      (`~/.imurun/python`). Also the program, so also removed.
 *   3. **Your data.** Models, the memory vault, sessions, configuration —
 *      everything under `~/.imurun`. Measured in gigabytes, and not
 *      replaceable by reinstalling. **Kept** unless `--purge` is given
 *      explicitly. A source checkout is the user's own work, so it is never
 *      deleted either.
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
import { removeExecutable, type RemoveResult } from "./executable"
import {
  detectInstallMethod,
  probeInstallMethod,
  pythonCommand,
  type InstallMethod,
} from "./update"

export interface UninstallOptions {
  /** Also remove `~/.imurun`: models, memory, sessions, configuration. */
  purge?: boolean
  /** Say what would happen, and change nothing. */
  dryRun?: boolean
  /** The npm executable to use. */
  npmCommand?: string
  /** How this copy was installed. Detected when it is not given. */
  method?: InstallMethod
  /** Injected by tests: runs a command and reports whether it succeeded. */
  run?: (command: string, args: string[]) => boolean
  /** Injected by tests: removes the running program. */
  removeSelf?: (target: string) => RemoveResult
}

export interface UninstallResult {
  /** What was actually removed. */
  removed: string[]
  /** What was deliberately left behind. */
  kept: string[]
  /** What could not be removed, and why. */
  errors: string[]
  /** Explanations that are neither a removal nor a failure. */
  notes: string[]
  /** How the program was installed. */
  method: InstallMethod
}

/** The npm executable for this platform. */
function defaultNpm(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

/** The package-manager executable for this platform. */
function manager(name: "npm" | "bun" | "pnpm"): string {
  if (process.platform !== "win32") return name
  return name === "npm" ? "npm.cmd" : name === "bun" ? "bun.exe" : "pnpm.cmd"
}

/** Runs a command and reports whether it succeeded. */
function runCommand(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", shell: process.platform === "win32" })
  return (result.status ?? 1) === 0
}

/**
 * Removes the program, and leaves the data alone.
 *
 * Safe to run more than once: what is already gone is reported as gone.
 */
export function uninstall(options: UninstallOptions = {}): UninstallResult {
  let method = options.method ?? detectInstallMethod()
  if (method === "unknown" && !options.method) method = probeInstallMethod()
  const removed: string[] = []
  const kept: string[] = []
  const errors: string[] = []
  const notes: string[] = []
  const home = imurunDir()
  const npm = options.npmCommand ?? defaultNpm()
  const run = options.run ?? runCommand
  const removeSelf = options.removeSelf ?? removeExecutable

  // ── the program ──────────────────────────────────────────────────────────
  switch (method) {
    case "npm": {
      if (options.dryRun) {
        removed.push("the npm package (npm uninstall -g imurun)")
      } else if (run(npm, ["uninstall", "-g", "imurun"])) {
        removed.push("the npm package")
      } else {
        logger.debug("npm did not report removing imurun; it may be installed another way")
        errors.push("npm could not remove imurun — it may not have been installed with npm")
      }
      // The executables come with it, but npm leaves them if they were not
      // pulled in as dependencies.
      for (const name of [
        "imurun-windows-x64",
        "imurun-linux-x64",
        "imurun-linux-arm64",
        "imurun-darwin-x64",
        "imurun-darwin-arm64",
      ]) {
        if (options.dryRun) continue
        run(npm, ["uninstall", "-g", name])
      }
      break
    }

    case "bun":
    case "pnpm": {
      const command = manager(method)
      if (options.dryRun) {
        removed.push(`the ${method} package (${command} remove -g imurun)`)
      } else if (run(command, ["remove", "-g", "imurun"])) {
        removed.push(`the ${method} package`)
      } else {
        errors.push(`${method} could not remove imurun — remove it by hand with ${command} remove -g imurun`)
      }
      break
    }

    case "pip": {
      if (options.dryRun) {
        removed.push("the pip package (python -m pip uninstall -y imurun)")
      } else if (run(pythonCommand(), ["-m", "pip", "uninstall", "-y", "imurun"])) {
        removed.push("the pip package")
      } else {
        logger.debug("pip did not report removing imurun; it may not have been installed with pip")
        errors.push("pip could not remove imurun — try it by hand: python -m pip uninstall -y imurun")
      }
      break
    }

    case "binary": {
      const target = process.execPath
      if (options.dryRun) {
        removed.push(`the program (${target})`)
      } else {
        const result = removeSelf(target)
        if (result.removed) {
          removed.push(`the program (${target})`)
          if (result.pending) {
            notes.push("the file itself is removed a moment after this process exits")
          }
        } else {
          errors.push(
            `could not remove ${target}: ${result.error}. Close IMURUN and delete the file yourself.`,
          )
        }
      }
      break
    }

    case "source":
      notes.push(
        "this is a source checkout — IMURUN did not delete any files. " +
          "Remove the directory yourself, or keep it and update it with git.",
      )
      break

    case "ephemeral":
      notes.push(
        "this copy is running from npx's cache, which is not an installation. " +
          "There is nothing to remove; npx clears the cache on its own.",
      )
      break

    default: {
      // Not identified. Try both package managers before giving up; each one
      // says whether it owned the copy.
      if (options.dryRun) {
        removed.push("the npm package, if npm installed it (npm uninstall -g imurun)")
        removed.push("the pip package, if pip installed it (python -m pip uninstall -y imurun)")
      } else {
        if (run(npm, ["uninstall", "-g", "imurun"])) removed.push("the npm package")
        else if (run(pythonCommand(), ["-m", "pip", "uninstall", "-y", "imurun"])) {
          removed.push("the pip package")
        } else {
          notes.push(
            "could not tell how this copy was installed. Remove it the way you installed it, " +
              "or delete the program file yourself.",
          )
        }
      }
      break
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

  return { removed, kept, errors, notes, method }
}

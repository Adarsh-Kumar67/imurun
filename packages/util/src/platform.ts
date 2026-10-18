/**
 * Platform helpers — OS detection and IMURUN directory layout.
 *
 * All IMURUN state lives under $IMURUN_HOME (default ~/.imurun):
 *   ~/.imurun/
 *     models/     installed GGUF files + runtime binaries
 *     data/       SQLite databases (global + per-project)
 *     logs/       rolling logs
 *     cache/      embeddings cache, downloaded assets
 *     skills/     user-created skills
 *     agents/     user-created agents
 *     memory/     durable notes + per-session summaries
 */
import os from "node:os"
import { join } from "node:path"
import { ensureDir } from "./fs"

export type OS = "windows" | "macos" | "linux"

export function currentOS(): OS {
  switch (process.platform) {
    case "win32":
      return "windows"
    case "darwin":
      return "macos"
    default:
      return "linux"
  }
}

export function currentArch(): string {
  return process.arch
}

export function isWindows(): boolean {
  return process.platform === "win32"
}

/**
 * Hands a path or URL to the desktop to open with its normal application
 * (Explorer/Finder/xdg). Detached and unref'ed, so a viewer that stays open
 * never holds IMURUN back. Returns false when the opener could not be started.
 */
export function openInSystem(target: string): boolean {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin, so it has to go through cmd itself. The empty
      // "" is the window title — without it, a quoted path is taken as one.
      Bun.spawnSync(["cmd", "/c", "start", "", target], { stdio: ["ignore", "ignore", "ignore"] })
    } else if (process.platform === "darwin") {
      Bun.spawnSync(["open", target], { stdio: ["ignore", "ignore", "ignore"] })
    } else {
      Bun.spawnSync(["xdg-open", target], { stdio: ["ignore", "ignore", "ignore"] })
    }
    return true
  } catch {
    return false
  }
}

export function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
}

/** Root of all IMURUN state. Overridable via IMURUN_HOME for tests. */
export function imurunHome(): string {
  return process.env.IMURUN_HOME ?? join(homeDir(), ".imurun")
}

export function imurunDir(...parts: string[]): string {
  return join(imurunHome(), ...parts)
}

export function modelsDir(): string {
  return imurunDir("models")
}

export function dataDir(): string {
  return imurunDir("data")
}

export function logsDir(): string {
  return imurunDir("logs")
}

export function cacheDir(): string {
  return imurunDir("cache")
}

export function skillsDir(): string {
  return imurunDir("skills")
}

export function agentsDir(): string {
  return imurunDir("agents")
}

/** Long-term memory: durable notes, per-session digests, todo state. */
export function memoryDir(): string {
  return imurunDir("memory")
}

/** Creates the entire IMURUN directory skeleton if missing. */
export async function ensureImurunDirs(): Promise<void> {
  await Promise.all(
    [modelsDir(), dataDir(), logsDir(), cacheDir(), skillsDir(), agentsDir(), memoryDir()].map((d) => ensureDir(d)),
  )
}

/** Default interactive shell for this platform (used by the shell tool). */
export function defaultShell(): { shell: string; args: string[] } {
  if (isWindows()) {
    return { shell: process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c"] }
  }
  return { shell: process.env.SHELL ?? "/bin/sh", args: ["-c"] }
}

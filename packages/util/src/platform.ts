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
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
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

export interface ShellSpec {
  /** Executable that runs the command. */
  shell: string
  /** Arguments that precede the command string. */
  args: string[]
  /**
   * True when the shell speaks POSIX: `grep`, `sed`, `cat`, pipes, `&&` and
   * variables all behave the way a coding model expects. False only on Windows
   * with no POSIX shell installed, where cmd is the last resort.
   */
  posix: boolean
  /** Short name for the shell, for tool descriptions and notices. */
  label: string
}

let cachedShell: ShellSpec | undefined

/** Git for Windows puts its bash in a few predictable places. */
function windowsShellCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files"
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const localAppData = process.env.LOCALAPPDATA ?? ""
  const candidates = [
    join(programFiles, "Git", "bin", "bash.exe"),
    join(programFiles, "Git", "usr", "bin", "bash.exe"),
    join(programFilesX86, "Git", "bin", "bash.exe"),
    localAppData ? join(localAppData, "Programs", "Git", "bin", "bash.exe") : "",
    join(programFiles, "Git", "bin", "sh.exe"),
  ]
  return candidates.filter((candidate) => candidate !== "")
}

/** Looks for an executable on PATH, skipping the Store's WSL stub. */
function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    // WindowsApps\bash.exe is an alias that raises WSL; it is not a shell we
    // can hand a command to, so it never wins over a real one.
    if (/WindowsApps/i.test(dir)) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function shellLabel(shell: string, fallback: string): string {
  return shell.split(/[\\/]/).pop() ?? fallback
}

function detectShell(): ShellSpec {
  if (!isWindows()) {
    const fromEnv = process.env.SHELL ?? ""
    const shell = fromEnv.endsWith("sh") ? fromEnv : "/bin/sh"
    return { shell, args: ["-c"], posix: true, label: shellLabel(shell, "sh") }
  }
  for (const candidate of windowsShellCandidates()) {
    if (existsSync(candidate)) return { shell: candidate, args: ["-c"], posix: true, label: "bash" }
  }
  const onPath = findOnPath("bash.exe")
  if (onPath) return { shell: onPath, args: ["-c"], posix: true, label: "bash" }
  const cmd = process.env.COMSPEC ?? "cmd.exe"
  return { shell: cmd, args: ["/d", "/s", "/c"], posix: false, label: shellLabel(cmd, "cmd") }
}

/**
 * The shell every command runs through.
 *
 * A POSIX shell is preferred on every platform. `grep`, `sed`, `cat`, `head`,
 * `tail`, pipes and `&&` are what a coding model reaches for, and they behave
 * identically on macOS, Linux and — through Git for Windows — Windows. cmd is
 * used only when nothing better exists, and the shell tool says so in that case
 * so the model does not reach for tools that are not there.
 */
export function resolveShell(): ShellSpec {
  cachedShell ??= detectShell()
  return cachedShell
}

/** Forgets the detected shell so it is looked up again. Used by tests. */
export function resetShellCache(): void {
  cachedShell = undefined
}

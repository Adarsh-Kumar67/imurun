/**
 * Updating IMURUN.
 *
 * The program is distributed on npm, so the update path is the one npm
 * already knows how to do: `npm install -g imurun@latest`. What this module
 * adds is the part npm cannot: knowing whether there *is* an update, and
 * saying so in a way that fits the interface.
 *
 * Two rules:
 *
 *   1. **Nothing is fetched unless the user asked.** A check reads one small
 *      field from the registry. An update is never started on its own.
 *   2. **The current version is never overwritten by a broken one.** npm
 *      handles the install; this module only reports what happened.
 */
import { spawnSync } from "node:child_process"
import { logger } from "@imurun/util"

const REGISTRY = "https://registry.npmjs.org/imurun/latest"

export interface UpdateStatus {
  /** The version that is running right now. */
  current: string
  /** The newest version published, when the registry could be reached. */
  latest?: string
  /** True when `latest` is newer than `current`. */
  updateAvailable: boolean
  /** Why the check failed, when it did. */
  error?: string
}

/**
 * Compares two dotted version numbers.
 *
 * Returns a positive number when `a` is newer, negative when `b` is, and
 * zero when they are the same. Pre-release tags (`1.2.0-beta.1`) sort below
 * the release they belong to, which is the usual convention.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: boolean } => {
    const [core = "", pre = ""] = value.trim().replace(/^v/, "").split("-")
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0)
    return { parts, pre: pre.length > 0 }
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.parts.length, right.parts.length)
  for (let index = 0; index < length; index++) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  // A pre-release is older than the release with the same number.
  return left.pre ? -1 : 1
}

/**
 * Asks the registry what the newest published version is.
 *
 * The request is small and read-only, and it is sent to the registry the
 * package came from — not to anywhere else.
 */
export async function checkForUpdate(
  current: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<UpdateStatus> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)
  try {
    const response = await doFetch(REGISTRY, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) {
      return { current, updateAvailable: false, error: `the registry answered HTTP ${response.status}` }
    }
    const body = (await response.json()) as { version?: string }
    const latest = body.version
    if (!latest) return { current, updateAvailable: false, error: "the registry did not name a version" }
    return { current, latest, updateAvailable: compareVersions(latest, current) > 0 }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { current, updateAvailable: false, error: `could not reach the registry: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

/** The npm executable for this platform. */
function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

/** How this copy of IMURUN was installed. */
export type InstallMethod = "npm" | "pip" | "binary" | "unknown"

/**
 * Works out how IMURUN was installed, so an update can use the right tool.
 *
 * The Python launcher says so in the environment; otherwise the path tells:
 * a copy inside `node_modules` came from npm, and a copy beside a Python
 * package came from pip.
 */
export function detectInstallMethod(): InstallMethod {
  const declared = process.env.IMURUN_INSTALL?.trim().toLowerCase()
  if (declared === "npm" || declared === "pip" || declared === "binary") return declared

  const executable = process.execPath ?? ""
  const entry = process.argv[1] ?? ""
  const path = `${executable} ${entry}`.replace(/\\/g, "/").toLowerCase()
  if (path.includes("/node_modules/") || path.includes("/npm/")) return "npm"
  if (path.includes("/site-packages/") || path.includes("/scripts/imurun")) return "pip"
  if (process.env.VIRTUAL_ENV) return "pip"
  return "unknown"
}

/** The command that updates this installation. */
export function updateCommandFor(method: InstallMethod): { command: string; args: string[] } {
  if (method === "pip") {
    // The same interpreter that is running now, so a virtualenv stays
    // self-contained.
    return { command: process.execPath, args: ["-m", "pip", "install", "--upgrade", "imurun"] }
  }
  return { command: npmCommand(), args: ["install", "-g", "imurun@latest"] }
}

export interface UpdateResult {
  ok: boolean
  /** The version that was running before. */
  from: string
  /** The version that is running now, when the install succeeded. */
  to?: string
  message: string
}

/**
 * Installs the newest published version.
 *
 * The install is npm's, not ours: `npm install -g imurun@latest`. If the
 * program was installed some other way, npm says so and the message explains
 * what to do instead.
 */
export function runUpdate(current: string, options: { dryRun?: boolean; method?: InstallMethod } = {}): UpdateResult {
  if (options.dryRun) {
    return { ok: false, from: current, message: "dry run — nothing was installed" }
  }
  const method = options.method ?? detectInstallMethod()
  const { command, args } = updateCommandFor(method)
  logger.info(`updating: ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, { stdio: "inherit", shell: false })
  if (result.status !== 0) {
    return {
      ok: false,
      from: current,
      message:
        method === "pip"
          ? "the install did not finish. Try it by hand: python -m pip install --upgrade imurun"
          : "the install did not finish. If IMURUN was installed another way, update it that way instead — " +
            "or download the new release from https://github.com/ImuTechz/imurun/releases",
    }
  }
  return { ok: true, from: current, message: "updated to the latest version" }
}

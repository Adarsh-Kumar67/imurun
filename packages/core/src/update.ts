/**
 * Updating IMURUN — from any way it was installed.
 *
 * The program can arrive on a machine in five ways, and an update that only
 * understands one of them strands the others:
 *
 *   npm / bun / pnpm   the registry package, and the npm-style tarball on the
 *                      GitHub release page (same package name, so both update
 *                      through the package manager)
 *   pip                the Python launcher, which downloads the compiled
 *                      program on its next start
 *   binary             a downloaded executable, replaced in place
 *   source             a git checkout, updated with git and bun
 *   npx                ephemeral: the newest is one `npx imurun@latest` away
 *
 * Two rules:
 *
 *   1. **Nothing is fetched unless the user asked.** A check reads two small
 *      version fields. An update is never started on its own.
 *   2. **A failed update leaves a working program.** Every path either
 *      completes or explains what to do by hand; none of them half-write.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { logger } from "@imurun/util"
import { replaceExecutable } from "./executable"

/** Where the releases live. One place, so a move is a one-line change. */
export const REPO = "shubham001312/imurun"
const REGISTRY = "https://registry.npmjs.org/imurun/latest"
const GITHUB_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

export interface UpdateStatus {
  /** The version that is running right now. */
  current: string
  /** The newest version published, when it could be read. */
  latest?: string
  /** True when `latest` is newer than `current`. */
  updateAvailable: boolean
  /** Why the check failed, when it did. */
  error?: string
  /** Where `latest` was read from, when it was. */
  channel?: "npm" | "github"
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface VersionReply {
  version?: string
  error?: string
}

async function readNpm(
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<VersionReply> {
  try {
    const response = await doFetch(REGISTRY, {
      headers: { accept: "application/json" },
      signal,
    })
    if (!response.ok) return { error: `the registry answered HTTP ${response.status}` }
    const body = (await response.json()) as { version?: string }
    if (!body.version) return { error: "the registry did not name a version" }
    return { version: body.version }
  } catch (error) {
    return { error: `could not reach the registry: ${reason(error)}` }
  }
}

async function readGithub(
  doFetch: typeof fetch,
  signal: AbortSignal,
): Promise<VersionReply> {
  try {
    const response = await doFetch(GITHUB_LATEST, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "imurun",
      },
      signal,
    })
    if (!response.ok) return { error: `GitHub answered HTTP ${response.status}` }
    const body = (await response.json()) as { tag_name?: string }
    const version = body.tag_name?.replace(/^v/, "")
    if (!version) return { error: "the release did not name a version" }
    return { version }
  } catch (error) {
    return { error: `could not reach GitHub: ${reason(error)}` }
  }
}

/**
 * Asks both channels what the newest version is and takes the newer answer.
 *
 * npm publishes the package and GitHub hosts the binaries, so a release can
 * be ahead on one and behind on the other for a few minutes. Reading both is
 * what lets a pip user and a binary user be told about the same release, and
 * what makes the check work when one registry is blocked and the other is not.
 */
export async function checkForUpdate(
  current: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<UpdateStatus> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)
  try {
    const [npm, github] = await Promise.all([
      readNpm(doFetch, controller.signal),
      readGithub(doFetch, controller.signal),
    ])
    const candidates = [npm.version, github.version].filter(
      (value): value is string => Boolean(value),
    )
    if (candidates.length === 0) {
      const errors = [npm.error, github.error].filter(Boolean).join("; ")
      return {
        current,
        updateAvailable: false,
        error: errors || "no release could be read",
      }
    }
    const latest = candidates.reduce((best, value) =>
      compareVersions(value, best) > 0 ? value : best,
    )
    return {
      current,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
      channel: github.version === latest ? "github" : "npm",
    }
  } finally {
    clearTimeout(timer)
  }
}

/** How this copy of IMURUN was installed. */
export type InstallMethod =
  | "npm"
  | "bun"
  | "pnpm"
  | "pip"
  | "binary"
  | "source"
  | "ephemeral"
  | "unknown"

export interface InstallProbe {
  execPath?: string
  argv1?: string
  env?: Record<string, string | undefined>
  /** Whether this is a compiled single-file program (Bun/Node runtime excluded). */
  compiled?: boolean
  platform?: NodeJS.Platform
}

/**
 * Works out how IMURUN was installed, so an update can use the right tool.
 *
 * The Python launcher says so in the environment; otherwise the paths are
 * distinctive enough to tell the package managers apart, and a compiled
 * program is one whose executable is not a JavaScript runtime.
 */
export function detectInstallMethod(probe: InstallProbe = {}): InstallMethod {
  const env = probe.env ?? process.env
  const declared = env.IMURUN_INSTALL?.trim().toLowerCase()
  if (
    declared === "npm" ||
    declared === "bun" ||
    declared === "pnpm" ||
    declared === "pip" ||
    declared === "binary" ||
    declared === "source"
  ) {
    return declared
  }

  const executable = probe.execPath ?? process.execPath ?? ""
  const entry = probe.argv1 ?? process.argv[1] ?? ""
  const path = `${executable} ${entry}`.replace(/\\/g, "/").toLowerCase()

  // A checkout run through Bun.
  if (/\/packages\/cli\/src\/index\.[tj]s$/.test(path) || /\/imurun\/packages\/[^/]+\/src\//.test(path)) {
    return "source"
  }
  // npx runs from a throwaway cache and should keep doing so.
  if (path.includes("/_npx/") || path.includes("/npm/_npx/")) return "ephemeral"
  // Bun and pnpm keep their globals in node_modules too, so they are tested first.
  if (path.includes("/.bun/install/global/") || path.includes("/bun/install/global/")) return "bun"
  if (path.includes("/pnpm/global/") || path.includes("/pnpm-global/")) return "pnpm"
  if (path.includes("/node_modules/")) return "npm"
  if (path.includes("/site-packages/") || path.includes("/dist-packages/")) return "pip"

  // A compiled program: not a JavaScript runtime, and not Python either -
  // a Python interpreter means the launcher is in play.
  const base = (executable.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase()
  const runtime = /^(bun|node|deno|py|python[0-9.]*)(\.exe)?$/.test(base)
  const compiled =
    probe.compiled ??
    Boolean((process.versions as Record<string, string | undefined>).bun)
  if (!runtime && compiled) return "binary"

  // A virtualenv can be active around an npm install; the path decides first.
  if (env.VIRTUAL_ENV) return "pip"
  return "unknown"
}

/** The package-manager executable for this platform. */
function packageManager(name: "npm" | "bun" | "pnpm", platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return name === "npm" ? "npm.cmd" : name === "bun" ? "bun.exe" : "pnpm.cmd"
  }
  return name
}

/** The Python interpreter that owns a pip install, when it is known. */
export function pythonCommand(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const declared = env.IMURUN_PYTHON?.trim()
  if (declared) return declared
  return platform === "win32" ? "python" : "python3"
}

/**
 * Asks the package managers whether they own this copy, for the rare install
 * an environment variable and a path cannot identify. Two small reads, only
 * ever run from an explicit `update` or `uninstall`.
 */
export function probeInstallMethod(
  options: {
    env?: Record<string, string | undefined>
    platform?: NodeJS.Platform
    run?: (command: string, args: string[]) => number | null
  } = {},
): InstallMethod {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run =
    options.run ??
    ((command: string, args: string[]): number | null => {
      const result = spawnSync(command, args, {
        stdio: "ignore",
        shell: process.platform === "win32",
      })
      return result.status
    })

  for (const manager of ["npm", "bun", "pnpm"] as const) {
    if (run(packageManager(manager, platform), ["ls", "-g", "--depth=0", "imurun"]) === 0) {
      return manager
    }
  }
  if (run(pythonCommand(env, platform), ["-m", "pip", "show", "imurun"]) === 0) return "pip"
  return "unknown"
}

/** The release asset name for a platform, e.g. `imurun-windows-x64.exe`. */
export function gitHubAsset(platform: NodeJS.Platform, arch: string): string {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux"
  const cpu = arch === "arm64" ? "arm64" : "x64"
  return `imurun-${os}-${cpu}${platform === "win32" ? ".exe" : ""}`
}

/** Where a release asset is downloaded from, versioned when it is known. */
export function downloadUrl(
  latest: string | undefined,
  asset: string,
  repo = REPO,
): string {
  return latest
    ? `https://github.com/${repo}/releases/download/v${latest}/${asset}`
    : `https://github.com/${repo}/releases/latest/download/${asset}`
}

export interface CommandSpec {
  command: string
  args: string[]
  cwd?: string
}

export interface UpdatePlan {
  current: string
  method: InstallMethod
  kind: "npm" | "pip" | "binary" | "source" | "manual"
  /** One sentence the interface can show before doing anything. */
  summary: string
  command?: CommandSpec
  fallback?: CommandSpec
  download?: { url: string; target: string; asset: string }
  sourceRoot?: string
  manual?: string
}

/** The checkout a `packages/cli/src/index.ts` path belongs to. */
export function sourceRoot(entry: string): string | undefined {
  const path = entry.replace(/\\/g, "/")
  const marker = path.indexOf("/packages/")
  if (marker <= 0) return undefined
  return path.slice(0, marker)
}

/**
 * What an update would do, for the interface to show and for `--dry-run`.
 *
 * Pure: it decides, it does not run anything. That is what makes "the upgrade
 * works however it was installed" testable without installing anything.
 */
export function planUpdate(
  current: string,
  options: {
    method?: InstallMethod
    latest?: string
    platform?: NodeJS.Platform
    arch?: string
    execPath?: string
    argv1?: string
    env?: Record<string, string | undefined>
    repo?: string
  } = {},
): UpdatePlan {
  const method =
    options.method ??
    detectInstallMethod({
      execPath: options.execPath,
      argv1: options.argv1,
      env: options.env,
    })
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const repo = options.repo ?? REPO
  const latest = options.latest
  const npm = packageManager("npm", platform)
  const python = pythonCommand(options.env, platform)
  const versionNote = latest ? ` to ${latest}` : " to the newest version"

  switch (method) {
    case "npm":
    case "bun":
    case "pnpm": {
      const manager = packageManager(method, platform)
      const add =
        method === "npm"
          ? ["install", "-g", "imurun@latest"]
          : method === "bun"
            ? ["add", "-g", "imurun@latest"]
            : ["add", "-g", "imurun@latest"]
      return {
        current,
        method,
        kind: "npm",
        summary: `${method} will install IMURUN${versionNote} from the registry`,
        command: { command: manager, args: add },
        // If the registry is unreachable, the same package is attached to the
        // GitHub release. npm can install that file directly.
        fallback: {
          command: method === "npm" ? npm : manager,
          args:
            method === "npm"
              ? ["install", "-g", `https://github.com/${repo}/releases/latest/download/imurun-npm.tgz`]
              : ["add", "-g", `https://github.com/${repo}/releases/latest/download/imurun-npm.tgz`],
        },
      }
    }

    case "pip":
      return {
        current,
        method,
        kind: "pip",
        summary:
          `pip will upgrade the launcher${versionNote}; ` +
          "the launcher downloads the matching program on the next start",
        command: { command: python, args: ["-m", "pip", "install", "--upgrade", "imurun"] },
        // A `--user` install cannot be upgraded without the flag.
        fallback: { command: python, args: ["-m", "pip", "install", "--upgrade", "--user", "imurun"] },
      }

    case "binary": {
      const target = options.execPath ?? process.execPath
      const asset = gitHubAsset(platform, arch)
      return {
        current,
        method,
        kind: "binary",
        summary: `${asset} will be downloaded and swapped in at ${target}`,
        download: { url: downloadUrl(latest, asset, repo), target, asset },
      }
    }

    case "source": {
      const root = sourceRoot(options.argv1 ?? process.argv[1] ?? "")
      return {
        current,
        method,
        kind: "source",
        summary: root
          ? `this is a source checkout at ${root}; it updates with git pull and bun install`
          : "this is a source checkout; it updates with git pull and bun install",
        sourceRoot: root,
        command: root
          ? { command: "git", args: ["-C", root, "pull", "--ff-only"] }
          : undefined,
        fallback: root ? { command: "bun", args: ["install"], cwd: root } : undefined,
      }
    }

    case "ephemeral":
      return {
        current,
        method,
        kind: "manual",
        summary: "this copy is running from npx's cache, which is not an install",
        manual:
          `Run the newest version with: npx imurun@latest\n` +
          `To keep it: npm install -g imurun   (or: bun add -g imurun)`,
      }

    default:
      return {
        current,
        method: "unknown",
        kind: "manual",
        summary: "could not tell how this copy was installed",
        manual:
          `Update it the way you installed it, or download the newest release from ${RELEASES_PAGE}`,
      }
  }
}

/** The command line as a person would type it. */
export function describeCommand(spec: CommandSpec | undefined): string | undefined {
  if (!spec) return undefined
  const quote = (part: string): string => (part.includes(" ") ? `"${part}"` : part)
  return [spec.command, ...spec.args].map(quote).join(" ")
}

export interface UpdateResult {
  ok: boolean
  /** The version that was running before. */
  from: string
  /** The version that was installed, when it is known. */
  to?: string
  method: InstallMethod
  /** What actually ran, or the URL that was downloaded. */
  command?: string
  /** False for a dry run. */
  performed: boolean
  message: string
}

/** Downloads an asset and returns its bytes. */
async function download(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "imurun" },
    redirect: "follow",
  })
  if (!response.ok) throw new Error(`the server answered HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  // The smallest real build is tens of megabytes; an error page is a few
  // kilobytes. This catches a proxy or a captive portal before it can be
  // written over a working program.
  if (bytes.byteLength < 512 * 1024) {
    throw new Error(`the download was only ${bytes.byteLength} bytes`)
  }
  return bytes
}

/**
 * Installs the newest published version, using the method this copy came
 * from, and returns what happened.
 */
export async function runUpdate(
  current: string,
  options: {
    dryRun?: boolean
    method?: InstallMethod
    latest?: string
    execPath?: string
    argv1?: string
    platform?: NodeJS.Platform
    arch?: string
    env?: Record<string, string | undefined>
    fetchImpl?: typeof fetch
    /** Injected by tests; returns whether the command succeeded. */
    run?: (spec: CommandSpec) => boolean
  } = {},
): Promise<UpdateResult> {
  const platform = options.platform ?? process.platform
  let method = options.method ?? detectInstallMethod({
    execPath: options.execPath,
    argv1: options.argv1,
    env: options.env,
  })
  if (method === "unknown") method = probeInstallMethod({ platform, env: options.env })

  const plan = planUpdate(current, {
    method,
    latest: options.latest,
    platform,
    arch: options.arch,
    execPath: options.execPath,
    argv1: options.argv1,
    env: options.env,
  })
  method = plan.method

  if (options.dryRun) {
    return {
      ok: true,
      from: current,
      method,
      performed: false,
      command: describeCommand(plan.command) ?? plan.download?.url,
      message: `dry run — ${plan.summary}`,
    }
  }

  const run =
    options.run ??
    ((spec: CommandSpec): boolean => {
      logger.info(`updating: ${spec.command} ${spec.args.join(" ")}`)
      const result = spawnSync(spec.command, spec.args, {
        stdio: "inherit",
        cwd: spec.cwd,
        shell: process.platform === "win32",
      })
      return (result.status ?? 1) === 0
    })

  switch (plan.kind) {
    case "npm": {
      if (plan.command && run(plan.command)) {
        return {
          ok: true,
          from: current,
          to: options.latest,
          method,
          performed: true,
          command: describeCommand(plan.command),
          message: `installed${options.latest ? ` ${options.latest}` : " the newest version"}`,
        }
      }
      if (plan.fallback && run(plan.fallback)) {
        return {
          ok: true,
          from: current,
          to: options.latest,
          method,
          performed: true,
          command: describeCommand(plan.fallback),
          message: "installed the package from the GitHub release",
        }
      }
      return {
        ok: false,
        from: current,
        method,
        performed: true,
        message:
          "the install did not finish. Try it by hand:\n" +
          `  ${describeCommand(plan.command) ?? "npm install -g imurun@latest"}\n` +
          `Or download the newest release from ${RELEASES_PAGE}`,
      }
    }

    case "pip": {
      if (plan.command && run(plan.command)) {
        return {
          ok: true,
          from: current,
          to: options.latest,
          method,
          performed: true,
          command: describeCommand(plan.command),
          message:
            "the launcher is upgraded — start IMURUN again and it downloads the matching program on the next start",
        }
      }
      if (plan.fallback && run(plan.fallback)) {
        return {
          ok: true,
          from: current,
          to: options.latest,
          method,
          performed: true,
          command: describeCommand(plan.fallback),
          message:
            "the launcher is upgraded (user install) — start IMURUN again and it downloads the matching program on the next start",
        }
      }
      return {
        ok: false,
        from: current,
        method,
        performed: true,
        message:
          "the install did not finish. Try it by hand:\n" +
          `  ${describeCommand(plan.command) ?? "python -m pip install --upgrade imurun"}`,
      }
    }

    case "binary": {
      const target = plan.download!.target
      const url = plan.download!.url
      try {
        const bytes = await download(url, options.fetchImpl ?? fetch)
        replaceExecutable(target, bytes, platform)
        return {
          ok: true,
          from: current,
          to: options.latest,
          method,
          performed: true,
          command: url,
          message: `the new program is in place at ${target} — start IMURUN again to use it`,
        }
      } catch (error) {
        return {
          ok: false,
          from: current,
          method,
          performed: true,
          command: url,
          message:
            `could not replace the program: ${reason(error)}\n` +
            `Download it from ${url} and put it at ${target} yourself, or use ` +
            "npm install -g imurun instead.",
        }
      }
    }

    case "source": {
      if (!plan.sourceRoot || !plan.command) {
        return {
          ok: false,
          from: current,
          method,
          performed: false,
          message: plan.manual ?? "this is a source checkout; update it with git pull and bun install",
        }
      }
      if (!run(plan.command)) {
        return {
          ok: false,
          from: current,
          method,
          performed: true,
          command: describeCommand(plan.command),
          message:
            "git could not fast-forward this checkout (local changes, or it has diverged). " +
            `Update it by hand in ${plan.sourceRoot}, then run bun install.`,
        }
      }
      if (plan.fallback && !run(plan.fallback)) {
        return {
          ok: false,
          from: current,
          method,
          performed: true,
          command: describeCommand(plan.fallback),
          message: `the code is updated, but dependencies are not: run bun install in ${plan.sourceRoot}`,
        }
      }
      return {
        ok: true,
        from: current,
        method,
        performed: true,
        command: describeCommand(plan.command),
        message: `updated the checkout at ${plan.sourceRoot}`,
      }
    }

    default:
      return {
        ok: false,
        from: current,
        method,
        performed: false,
        message: plan.manual ?? `download the newest release from ${RELEASES_PAGE}`,
      }
  }
}

/** A plain description of how the program was installed. */
export function describeInstallMethod(method: InstallMethod): string {
  switch (method) {
    case "npm":
      return "npm (npm install -g imurun)"
    case "bun":
      return "Bun (bun add -g imurun)"
    case "pnpm":
      return "pnpm (pnpm add -g imurun)"
    case "pip":
      return "pip (pip install imurun)"
    case "binary":
      return "a standalone binary"
    case "source":
      return "a source checkout"
    case "ephemeral":
      return "npx (not installed)"
    default:
      return "an unknown method"
  }
}

/** Kept for callers that only need the command, not the whole plan. */
export function updateCommandFor(
  method: InstallMethod,
  latest?: string,
): { command: string; args: string[] } {
  const plan = planUpdate("", { method, latest })
  return plan.command ?? { command: packageManager("npm", process.platform), args: ["install", "-g", "imurun@latest"] }
}

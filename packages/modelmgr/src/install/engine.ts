/**
 * llama.cpp binary management — downloads the right prebuilt llama-server for
 * whatever machine IMURUN lands on, with no manual steps:
 *
 *   1. pick builds by platform + GPU (Vulkan first for compatibility and a
 *      small download, CUDA/ROCm when they are the better fit)
 *   2. download + extract the build
 *   3. verify the binary actually runs
 *   4. if it does not, fall back to the next build and try again
 *
 * Layout: ~/.imurun/engines/llama.cpp/<release-tag>/llama-server[.exe]
 * The verified build is recorded in active.json so status output is precise.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import type { HardwareProfile } from "@imurun/schema"
import { ensureDir, formatBytes, imurunDir, logger, readJson, sleep, writeJsonAtomic } from "@imurun/util"
import { downloadFile, type DownloadProgress } from "../huggingface/download"
import { detectHardware, detectPlatform } from "../hardware/detect"

const RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15"

export type EngineVariant = "cuda" | "vulkan" | "cpu" | "rocm" | "metal"

export interface ActiveEngine {
  tag: string
  variant: EngineVariant
  binaryPath: string
  installedAt: number
}

export interface EngineInstallResult {
  installed: boolean
  /** Directory containing llama-server. */
  dir: string
  binaryPath: string
  version?: string
  variant?: EngineVariant
}

export interface EngineInstallOptions {
  hardware?: HardwareProfile
  /** Force a specific build ("auto" or unset = pick by hardware). */
  preferVariant?: string
  onProgress?: (progress: DownloadProgress & { file?: string }) => void
  onStatus?: (message: string) => void
  signal?: AbortSignal
  /** Force re-download even when a binary exists. */
  force?: boolean
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

interface Release {
  tag: string
  assets: ReleaseAsset[]
}

interface AssetPreference {
  variant: EngineVariant
  pattern: RegExp
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "imurun",
  }
  // GITHUB_TOKEN first, then GH_TOKEN — the two names people actually use.
  // The token goes into a header, never into a URL, and is never logged.
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * Build preference order per platform and GPU. Vulkan comes first on
 * Windows/Linux because it works on virtually any modern GPU, needs no CUDA
 * runtime, and downloads in ~30 MB; CUDA/ROCm follow for maximum speed. The
 * CPU build is always the last resort.
 */
function assetPreferences(hardware: HardwareProfile, preferVariant?: string): AssetPreference[] {
  const platform = hardware.os
  const hasNvidia = hardware.gpu.some((g) => g.usable && g.vendor === "nvidia")
  const hasAmd = hardware.gpu.some((g) => g.usable && g.vendor === "amd")
  const hasUsableGpu = hardware.gpu.some((g) => g.usable)

  let prefs: AssetPreference[]
  if (platform === "windows") {
    const vulkan = { variant: "vulkan" as const, pattern: /llama-.*bin-win-vulkan-x64\.zip$/i }
    const cuda = { variant: "cuda" as const, pattern: /llama-.*bin-win-cuda-12[^/]*x64\.zip$/i }
    const cpu = { variant: "cpu" as const, pattern: /llama-.*bin-win-cpu-x64\.zip$/i }
    // Vulkan works on NVIDIA, AMD and Intel GPUs alike and installs in ~30 MB,
    // so it leads; CUDA is the (larger) speed option and stays a fallback.
    prefs = hasNvidia ? [vulkan, cuda, cpu] : hasUsableGpu ? [vulkan, cpu] : [cpu]
  } else if (platform === "macos") {
    prefs = [
      {
        variant: "metal",
        pattern: hardware.arch === "arm64" ? /bin-macos-arm64\.tar\.gz$/i : /bin-macos-x64\.tar\.gz$/i,
      },
    ]
  } else {
    const cuda = { variant: "cuda" as const, pattern: /llama-.*bin-ubuntu-cuda-12[^/]*x64\.tar\.gz$/i }
    const rocm = { variant: "rocm" as const, pattern: /llama-.*bin-ubuntu-rocm[^/]*x64\.tar\.gz$/i }
    const vulkan = { variant: "vulkan" as const, pattern: /llama-.*bin-ubuntu-vulkan-x64\.tar\.gz$/i }
    const cpu = { variant: "cpu" as const, pattern: /llama-.*bin-ubuntu-x64\.tar\.gz$/i }
    prefs = hasNvidia
      ? [cuda, vulkan, cpu]
      : hasAmd
        ? [rocm, vulkan, cpu]
        : hasUsableGpu
          ? [vulkan, cpu]
          : [cpu]
  }

  const pinned = (preferVariant ?? process.env.IMURUN_LLAMA_VARIANT)?.toLowerCase()
  if (pinned && pinned !== "auto") {
    const matching = prefs.filter((p) => p.variant === pinned)
    if (matching.length > 0) prefs = [...matching, ...prefs.filter((p) => p.variant !== pinned)]
  }
  return prefs
}

/**
 * The ordered build variants IMURUN will try for a machine. Exported so the
 * automatic variant policy can be tested without downloading anything.
 */
export function preferredEngineVariants(hardware: HardwareProfile, preferVariant?: string): EngineVariant[] {
  return assetPreferences(hardware, preferVariant).map((p) => p.variant)
}

/** CUDA builds need the matching cudart companion archive on Windows. */
function companionAssetFor(asset: ReleaseAsset, release: Release): ReleaseAsset | undefined {
  const match = asset.name.match(/bin-win-cuda-(\d[\d.]*)-x64\.zip$/i)
  if (!match) return undefined
  const wanted = `cudart-llama-bin-win-cuda-${match[1]}-x64.zip`
  return release.assets.find((a) => a.name === wanted)
}

async function fetchReleases(): Promise<Release[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(RELEASES_API, { headers: githubHeaders(), signal: AbortSignal.timeout(20_000) })
      if (response.status === 403) {
        throw new Error("GitHub API rate limit reached. Set GITHUB_TOKEN and retry, or install llama.cpp manually.")
      }
      if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
      const body = (await response.json()) as Array<{
        tag_name?: string
        assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
      }>
      const releases = body
        .map((entry) => ({
          tag: entry.tag_name ?? "unknown",
          assets: (entry.assets ?? [])
            .filter((a): a is { name: string; browser_download_url: string; size: number } =>
              Boolean(a.name && a.browser_download_url),
            )
            .map((a) => ({ name: a.name, browser_download_url: a.browser_download_url, size: a.size ?? 0 })),
        }))
        .filter((release) => release.assets.length > 0)
      if (releases.length === 0) throw new Error("no releases with binary assets found")
      return releases
    } catch (error) {
      if (attempt === 3) throw error
      await sleep(attempt * 1000)
    }
  }
  throw new Error("unreachable")
}

export function llamaCppEngineDir(): string {
  return imurunDir("engines", "llama.cpp")
}

function activeEnginePath(): string {
  return join(llamaCppEngineDir(), "active.json")
}

export function readActiveEngine(): Promise<ActiveEngine | undefined> {
  return readJson<ActiveEngine>(activeEnginePath())
}

export function findInstalledEngineBinary(): string | undefined {
  const base = llamaCppEngineDir()
  const binaryName = process.platform === "win32" ? "llama-server.exe" : "llama-server"
  // Prefer the build we verified on this machine — a stale, non-working build
  // from another variant must never shadow it.
  try {
    const active = JSON.parse(readFileSync(activeEnginePath(), "utf8")) as ActiveEngine
    if (active?.binaryPath && existsSync(active.binaryPath)) return active.binaryPath
  } catch {
    // no active.json yet
  }
  const direct = join(base, binaryName)
  if (existsSync(direct)) return direct
  try {
    const glob = new Bun.Glob(`**/${binaryName}`)
    for (const found of glob.scanSync({ cwd: base, onlyFiles: true })) {
      return join(base, found)
    }
  } catch {
    // no dir yet
  }
  return undefined
}

/** The versioned directory a binary belongs to (used for clean reinstalls). */
function versionDirOf(binaryPath: string): string {
  const base = llamaCppEngineDir()
  const relative = binaryPath.slice(base.length).replace(/^[/\\]+/, "")
  const firstSegment = relative.split(/[/\\]/)[0]
  return firstSegment ? join(base, firstSegment) : base
}

/** Runs `llama-server --version` to prove the build loads on this machine. */
async function binaryRuns(binaryPath: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const proc = Bun.spawn([binaryPath, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // gone
      }
    }, 30_000)
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => ""),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => ""),
    ])
    const code = await proc.exited
    clearTimeout(timer)
    const output = `${stdout}\n${stderr}`.trim()
    if (code === 0) return { ok: true }
    return { ok: false, detail: output.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 200) || `exit code ${code}` }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}

/** Extracts a .zip or .tar.gz using platform tools (no native node deps needed). */
async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await ensureDir(destination)
  const platform = detectPlatform()
  const isTarGz = /\.tar\.gz$/i.test(archivePath)

  let attempts: Array<string[]>
  if (isTarGz) {
    attempts = [["tar", "-xzf", archivePath, "-C", destination]]
  } else if (platform === "windows") {
    attempts = [
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`,
      ],
    ]
  } else if (platform === "macos") {
    attempts = [
      ["ditto", "-x", "-k", archivePath, destination],
      ["unzip", "-o", "-q", archivePath, "-d", destination],
    ]
  } else {
    attempts = [
      ["unzip", "-o", "-q", archivePath, "-d", destination],
      ["bsdtar", "-xf", archivePath, "-C", destination],
    ]
  }

  let lastError: Error | undefined
  for (const [command, ...args] of attempts) {
    try {
      const proc = Bun.spawnSync([command!, ...args], { stdout: "ignore", stderr: "pipe", windowsHide: true })
      if (proc.exitCode === 0) return
      lastError = new Error(`${command} exited with ${proc.exitCode}: ${proc.stderr.toString()}`)
    } catch (error) {
      lastError = error as Error
    }
  }
  throw new Error(`Could not extract ${archivePath}: ${lastError?.message ?? "no extraction tool available"}`)
}

/** Removes stale partial downloads and archives from the engine directory. */
async function cleanStaleDownloads(): Promise<void> {
  try {
    const entries = await readdir(llamaCppEngineDir(), { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (/\.part$/.test(entry.name) || /\.(zip|tar\.gz)$/.test(entry.name)) {
        await rm(join(entry.parentPath ?? llamaCppEngineDir(), entry.name), { force: true }).catch(() => {})
      }
    }
  } catch {
    // nothing to clean
  }
}

function binaryName(): string {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server"
}

function locateBinary(dir: string): string | undefined {
  try {
    const glob = new Bun.Glob(`**/${binaryName()}`)
    for (const found of glob.scanSync({ cwd: dir, onlyFiles: true })) {
      return join(dir, found)
    }
  } catch {
    // missing
  }
  return undefined
}

/**
 * Ensures a working llama-server binary exists. Installs one when missing or
 * broken, verifying that it actually runs and falling back to the next build
 * variant when a download cannot run on this machine.
 */
export async function ensureLlamaCppEngine(options: EngineInstallOptions = {}): Promise<EngineInstallResult> {
  const existing = findInstalledEngineBinary()
  if (existing && !options.force) {
    const check = await binaryRuns(existing)
    if (check.ok) {
      const active = await readActiveEngine()
      return { installed: false, dir: versionDirOf(existing), binaryPath: existing, variant: active?.variant, version: active?.tag }
    }
    logger.warn(`installed llama-server does not run (${check.detail ?? "unknown"}) — reinstalling`)
    await rm(versionDirOf(existing), { recursive: true, force: true })
  }
  if (existing && options.force) {
    // A forced reinstall replaces the current build entirely.
    await rm(versionDirOf(existing), { recursive: true, force: true }).catch(() => {})
  }

  const hardware = options.hardware ?? (await detectHardware())
  options.onStatus?.("finding the right llama.cpp build for this machine")
  const releases = await fetchReleases()
  const preferences = assetPreferences(hardware, options.preferVariant)
  const failures: string[] = []

  for (const preference of preferences) {
    const candidate = releases
      .map((release) => ({ release, asset: release.assets.find((a) => preference.pattern.test(a.name)) }))
      .find((entry): entry is { release: Release; asset: ReleaseAsset } => Boolean(entry.asset))
    if (!candidate) continue

    const { release, asset } = candidate
    const companion = companionAssetFor(asset, release)
    const versionDir = join(llamaCppEngineDir(), release.tag)
    await cleanStaleDownloads()

    try {
      await ensureDir(versionDir)
      for (const item of [asset, companion].filter((a): a is ReleaseAsset => Boolean(a))) {
        options.onStatus?.(`downloading ${item.name} (${formatBytes(item.size)})`)
        await downloadFile({
          url: item.browser_download_url,
          destination: join(versionDir, item.name),
          signal: options.signal,
          expectedSizeBytes: item.size,
          onProgress: (p) => options.onProgress?.({ ...p, file: item.name }),
        })
      }

      for (const archive of [asset, companion].filter((a): a is ReleaseAsset => Boolean(a))) {
        options.onStatus?.(`extracting ${basename(archive.name)}`)
        const archivePath = join(versionDir, archive.name)
        await extractArchive(archivePath, versionDir)
        await rm(archivePath, { force: true })
      }

      const found = locateBinary(versionDir)
      if (!found) throw new Error(`${binaryName()} is missing from ${asset.name}`)
      await stat(found)

      options.onStatus?.(`verifying ${release.tag} (${preference.variant})`)
      const check = await binaryRuns(found)
      if (!check.ok) {
        throw new Error(`build does not run here: ${check.detail ?? "unknown error"}`)
      }

      await writeJsonAtomic(activeEnginePath(), {
        tag: release.tag,
        variant: preference.variant,
        binaryPath: found,
        installedAt: Date.now(),
      } satisfies ActiveEngine)

      logger.info(`llama.cpp ${release.tag} (${preference.variant}) installed at ${found}`)
      return { installed: true, dir: versionDir, binaryPath: found, version: release.tag, variant: preference.variant }
    } catch (error) {
      const message = (error as Error).message
      failures.push(`${preference.variant}: ${message}`)
      options.onStatus?.(`${preference.variant} build failed (${message}) — trying another`)
      await rm(versionDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  throw new Error(
    `Could not install a working llama.cpp build for this machine.\n  ${failures.join("\n  ")}\n` +
      `Install llama.cpp manually into ${llamaCppEngineDir()} (the llama-server binary alone is enough).`,
  )
}

/** Removes every installed llama.cpp build. */
export async function removeLlamaCppEngines(): Promise<{ freedBytes: number }> {
  let freedBytes = 0
  try {
    const entries = await readdir(llamaCppEngineDir(), { withFileTypes: true })
    for (const entry of entries) {
      const size = await dirSize(join(llamaCppEngineDir(), entry.name)).catch(() => 0)
      freedBytes += size
    }
  } catch {
    // nothing installed
  }
  await rm(llamaCppEngineDir(), { recursive: true, force: true })
  await mkdir(llamaCppEngineDir(), { recursive: true }).catch(() => {})
  return { freedBytes }
}

export async function dirSize(path: string): Promise<number> {
  const info = await stat(path).catch(() => undefined)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    total += await dirSize(join(path, entry.name)).catch(() => 0)
  }
  return total
}

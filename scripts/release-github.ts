#!/usr/bin/env bun
/**
 * IMURUN GitHub release — stages the artifacts and publishes them as a release.
 *
 * What it does:
 *
 *   1. Bundles the CLI and stages the npm package (`bun run package`).
 *   2. Compiles standalone binaries for the requested platforms.
 *   3. Packs the staged package into `imurun-npm.tgz` (a stable asset name, so
 *      the documented install URLs never change between versions).
 *   4. Creates the `v<version>` release through the GitHub REST API and uploads
 *      the tarball and every binary as assets.
 *
 * Credentials come from the `GH_TOKEN` (or `GITHUB_TOKEN`) environment variable
 * and are used only for these requests — never written to disk, never logged,
 * never placed in a URL. A classic token with the `repo` scope is enough.
 *
 * Usage (from the workspace root):
 *
 *   GH_TOKEN=... bun run release
 *   bun run release -- --repo=shubham001312/imurun --targets=bun-windows-x64,bun-linux-x64
 *   bun run release -- --dry-run     # stage + pack, print the plan, touch nothing
 */
import { copyFile, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dir, "..")
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const withEquals = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (withEquals) return withEquals.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : (argv[index + 1] ?? "")
}
const has = (name: string): boolean => argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))

const repo = flag("repo") ?? "shubham001312/imurun"
const dryRun = has("dry-run")
const targets = flag("targets") ?? "bun-windows-x64,bun-linux-x64,bun-linux-arm64,bun-darwin-x64,bun-darwin-arm64"
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const api = "https://api.github.com"

/**
 * The npm credential, when there is one.
 *
 * The platform packages are published to npm as well as the main one, so a
 * plain install brings the right standalone executable along and never needs
 * Bun. The token is read from the environment and used through a temporary
 * npm configuration that references it — the secret itself is never written
 * to a file.
 */
const npmToken = process.env.NPM_TOKEN?.trim() || process.env.NPM_CONFIG_TOKEN?.trim()

const manifest = await Bun.file(join(root, "packages/cli/package.json")).json()
const version: string = manifest.version

const outDir = resolve(root, "dist/package")
const releaseDir = resolve(root, "dist/release")
const npmDir = join(outDir, "npm/imurun")
const binariesDir = join(outDir, "binaries")
const npmConfig = join(releaseDir, ".npmrc")

function run(command: string, args: string[], options: { cwd?: string } = {}): void {  // No shell: paths with spaces ("IMU CLI") must reach the child as one argv
  // entry, and every command here exists as an executable (.cmd on Windows).
  const result = spawnSync(command, args, { stdio: "inherit", cwd: options.cwd ?? root, windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "signal"}`)
  }
}

/** The npm executable for this platform. */
function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

/**
 * Quotes an argument for the shell.
 *
 * npm on Windows is a batch file, so it has to be run through a shell — and a
 * path with a space in it has to be quoted, or the shell cuts it in half.
 */
function quoteArg(arg: string): string {
  if (process.platform !== "win32") return arg
  if (!/[\s"&|<>^]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

/** Runs npm with the publishing credential in the environment. */
function runNpm(args: string[], env: Record<string, string>): number {
  const line = [npmCommand(), ...args].map(quoteArg).join(" ")
  const result = spawnSync(line, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  })
  return result.status ?? 1
}

/** True when the package version is already on the registry. */
async function isPublished(name: string, version: string): Promise<boolean> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${name}`)
    if (!response.ok) return false
    const body = (await response.json()) as { versions?: Record<string, unknown> }
    return Boolean(body.versions?.[version])
  } catch {
    return false
  }
}

/**
 * Waits for a package to appear on the registry.
 *
 * A hundred-megabyte tarball takes the registry a few minutes to finish, and
 * the version is not really there until it has. The main package is published
 * only after the executables it depends on are.
 */
async function waitForPackage(name: string, version: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${name}`)
      if (response.ok) {
        const body = (await response.json()) as { versions?: Record<string, unknown> }
        if (body.versions?.[version]) return true
      }
    } catch {
      // The registry is unreachable; try again in a moment.
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  }
  return false
}

function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "imurun-release",
    Authorization: `Bearer ${token}`,
    ...extra,
  }
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const isBinary = Boolean(init.body) && typeof init.body !== "string"
  const headers: Record<string, string> = githubHeaders(isBinary ? { "Content-Type": "application/octet-stream" } : undefined)
  return fetch(`${api}${path}`, { ...init, headers })
}

/** Release notes: the commits since the previous tag, newest first. */
async function releaseNotes(): Promise<string> {
  const previous = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: root, encoding: "utf8" })
  const range = previous.status === 0 ? `${previous.stdout.trim()}..HEAD` : "HEAD"
  const log = spawnSync("git", ["log", range, "--pretty=format:%s", "-40"], { cwd: root, encoding: "utf8" })
  const lines = (log.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("Merge "))
    .map((line) => `- ${line}`)
  return [
    `IMURUN v${version}`,
    "",
    "Install:",
    "",
    "```bash",
    "npm install -g imurun",
    "```",
    "",
    "or, straight from this release:",
    "",
    "```bash",
    "npm install -g https://github.com/" + repo + "/releases/download/v" + version + "/imurun-npm.tgz",
    "```",
    "",
    "Standalone binaries (no Bun or npm needed) are attached below.",
    "",
    "## Changes",
    "",
    ...(lines.length > 0 ? lines : [`- IMURUN v${version}`]),
  ].join("\n")
}

if (!token && !dryRun) {
  console.error("No GitHub token. Set GH_TOKEN (repo scope) and run again — it is read from the")
  console.error("environment only and is never written to disk.")
  process.exit(1)
}

console.log(`\n▶ IMURUN v${version} → ${repo}${dryRun ? " (dry run)" : ""}\n`)

// Nothing is published until everything has been proved: the type check, the
// whole test suite, and the package installed into a clean directory and run.
if (!has("skip-check")) {
  console.log("▶ checking the release")
  const check = spawnSync(process.execPath, ["run", "scripts/check-release.ts"], {
    stdio: "inherit",
    cwd: root,
    shell: false,
  })
  if (check.status !== 0) {
    console.error("\n✖ the release check failed — nothing was published.")
    process.exit(1)
  }
  console.log("")
}

console.log("▶ building and staging")
run(process.execPath, ["run", "package", "--", "--binaries", `--targets=${targets}`])

console.log("\n▶ packing the npm tarball")
await rm(releaseDir, { recursive: true, force: true })
const packDir = join(releaseDir, "package")
await mkdir(packDir, { recursive: true })
// npm's tarball format: one root folder named `package/`. Built with the
// system tar so no shell quoting is involved (the checkout path has spaces).
await cp(npmDir, packDir, { recursive: true })
const tarball = join(releaseDir, "imurun-npm.tgz")
run("tar", ["-czf", tarball, "-C", releaseDir, "package"])
console.log(`  imurun-npm.tgz  ${((await stat(tarball)).size / 1024 / 1024).toFixed(2)} MB`)

const assets: Array<{ path: string; name: string; type: string }> = [
  { path: tarball, name: "imurun-npm.tgz", type: "application/gzip" },
]
if (existsSync(binariesDir)) {
  for (const file of await readdir(binariesDir)) {
    assets.push({ path: join(binariesDir, file), name: file, type: "application/octet-stream" })
  }
}

console.log("\n▶ release assets")
for (const asset of assets) {
  const size = await stat(asset.path)
  console.log(`  ${asset.name}  ${(size.size / 1024 / 1024).toFixed(1)} MB`)
}

if (dryRun) {
  console.log("\ndry run — nothing was published. Remove --dry-run to publish.")
  process.exit(0)
}

const notes = await releaseNotes()

console.log("\n▶ creating the release")
let release: { id: number; upload_url: string; html_url: string }
const created = await apiRequest(`/repos/${repo}/releases`, {
  method: "POST",
  body: JSON.stringify({
    tag_name: `v${version}`,
    target_commitish: "main",
    name: `IMURUN v${version}`,
    body: notes,
    draft: false,
    prerelease: false,
  }),
})
if (created.ok) {
  release = (await created.json()) as { id: number; upload_url: string; html_url: string }
} else if (created.status === 422) {
  // The tag/release already exists: publish onto it instead of failing.
  const existing = await apiRequest(`/repos/${repo}/releases/tags/v${version}`)
  if (!existing.ok) {
    console.error(`a release for v${version} exists but could not be read (${existing.status}).`)
    process.exit(1)
  }
  release = (await existing.json()) as { id: number; upload_url: string; html_url: string }
  console.log(`  release v${version} already exists — updating assets`)
} else {
  console.error(`could not create the release: ${created.status} ${await created.text()}`)
  process.exit(1)
}

const uploadBase = release.upload_url.replace(/\{.*\}$/, "")

for (const asset of assets) {
  console.log(`▶ uploading ${asset.name}`)
  // A re-run replaces an asset that is already attached.
  const listed = await apiRequest(`/repos/${repo}/releases/${release.id}/assets?per_page=100`)
  if (listed.ok) {
    const existing = (await listed.json()) as Array<{ id: number; name: string }>
    for (const item of existing) {
      if (item.name === asset.name) {
        await apiRequest(`/repos/${repo}/releases/assets/${item.id}`, { method: "DELETE" })
      }
    }
  }
  const body = new Uint8Array(await Bun.file(asset.path).arrayBuffer())
  const uploaded = await fetch(`${uploadBase}?name=${encodeURIComponent(asset.name)}`, {
    method: "POST",
    headers: { ...githubHeaders({ "Content-Type": asset.type }), "Content-Length": String(body.byteLength) },
    body: body,
  })
  if (!uploaded.ok) {
    console.error(`  upload failed: ${uploaded.status} ${await uploaded.text()}`)
    process.exit(1)
  }
  console.log(`  done`)
}

console.log(`\n✔ published ${release.html_url}`)
console.log("\n  install with npm (needs Bun):")
console.log(`    npm install -g imurun`)
console.log("  or straight from this release:")
console.log(`    npm install -g https://github.com/${repo}/releases/download/v${version}/imurun-npm.tgz`)
console.log("  or download a standalone binary from the release page — it needs nothing else.")

// ── the platform packages on npm ────────────────────────────────────────────
//
// The main package lists the standalone executables as optional dependencies,
// so a plain `npm install -g imurun` brings the right one along and the
// program never needs Bun at all. They have to be published too, or the
// optional dependency resolves to nothing and the install falls back to the
// JavaScript bundle.
if (npmToken) {
  const npmRoot = join(outDir, "npm")
  const platformDirs = existsSync(npmRoot)
    ? (await readdir(npmRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("imurun-"))
        .map((entry) => join(npmRoot, entry.name))
    : []
  if (platformDirs.length === 0) {
    console.log("\n  (no platform packages were built — the install will need Bun)")
  }
  // The configuration refers to the environment variable, so the secret
  // itself is never written to disk.
  await mkdir(releaseDir, { recursive: true })
  await Bun.write(npmConfig, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n")
  const published: string[] = []

  // A version that is already on the registry is not published again. npm
  // would refuse it anyway, and the attempt is noise.
  const already = await isPublished("imurun", version)
  if (already) {
    console.log(`\n  imurun@${version} is already on npm — it is left alone.`)
  }
  for (const dir of platformDirs) {
    const name = JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name as string
    console.log(`\n▶ publishing ${name} to npm`)
    const status = runNpm(["publish", dir, "--access", "public"], {
      NPM_TOKEN: npmToken,
      NPM_CONFIG_USERCONFIG: npmConfig,
    })
    if (status !== 0) {
      console.error(`  ${name} was not published — the install will fall back to Bun for this platform.`)
      continue
    }
    console.log(`  done`)
    published.push(name)
  }

  // The registry finalises a hundred-megabyte tarball in its own time. The
  // main package waits for the executables it depends on, so an install can
  // never ask for a version that is not there yet.
  for (const [index, name] of published.entries()) {
    let ready = await waitForPackage(name, version, 5 * 60_000)
    if (!ready) {
      // npm drops an upload that never finished, so it is sent again.
      console.log(`  ${name}@${version} did not land — publishing it again`)
      const dir = platformDirs[index]!
      runNpm(["publish", dir, "--access", "public"], {
        NPM_TOKEN: npmToken,
        NPM_CONFIG_USERCONFIG: npmConfig,
      })
      ready = await waitForPackage(name, version, 5 * 60_000)
    }
    if (ready) console.log(`  ${name}@${version} is on the registry`)
    else console.error(`  ${name}@${version} is taking a while — the install will use the last one published.`)
  }

  // And only then the main package, which depends on them.
  if (already) {
    console.log("  (the main package is not published again)")
  } else {
    console.log(`\n▶ publishing imurun@${version} to npm`)
    const mainStatus = runNpm(["publish", npmDir, "--access", "public"], {
      NPM_TOKEN: npmToken,
      NPM_CONFIG_USERCONFIG: npmConfig,
    })
    if (mainStatus !== 0) {
      console.error("  imurun was not published to npm.")
    } else {
      console.log("  done")
    }
  }
  await rm(npmConfig, { force: true })
}

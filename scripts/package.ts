#!/usr/bin/env bun
/**
 * IMURUN packaging — turns the workspace into distributable artifacts.
 *
 * Two forms are produced, because IMURUN targets two different users:
 *
 *   1. An npm package (`imurun`) for `npm install -g imurun`. The payload is a
 *      single self-contained JavaScript bundle; the bin shim runs it with Bun,
 *      which is declared as the engine. This is the small download.
 *
 *   2. Standalone executables (`imurun-<os>-<arch>[.exe]`) for machines that
 *      have no Bun at all — `bun build --compile` embeds the runtime, so the
 *      file is the whole program. These are published as platform packages
 *      (`@imurun/<os>-<arch>`) that the main package pulls in through
 *      `optionalDependencies`; the launcher prefers the native binary and falls
 *      back to Bun when one is not available.
 *
 * Usage (from the workspace root):
 *
 *   bun run package                       # bundle + stage the npm package
 *   bun run package -- --binaries         # also compile for this machine
 *   bun run package -- --binaries --targets=bun-windows-x64,bun-linux-x64
 *   bun run package -- --out=dist/release # choose the staging directory
 *
 * Nothing here reaches the network or the registry; it only stages files. The
 * version comes from `packages/cli/package.json`, so a release is a one-line
 * change plus this script.
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const cliEntry = join(root, "packages/cli/src/index.ts")
const cliManifestPath = join(root, "packages/cli/package.json")

// ── options ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const withEquals = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (withEquals) return withEquals.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : (argv[index + 1] ?? "")
}
const has = (name: string): boolean =>
  argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))

const wantBinaries = has("binaries") || has("targets")
const outDir = resolve(root, flag("out") ?? "dist/package")
const explicitTargets = flag("targets")

// ── helpers ─────────────────────────────────────────────────────────────────

const EXTENSION = process.platform === "win32" ? ".exe" : ""

/** `win32` → `windows`, everything else keeps its `process.platform` name. */
function platformName(platform: string): string {
  return platform === "win32" ? "windows" : platform
}

/** The host's own compile target, e.g. `bun-windows-x64`. */
function hostTarget(): string {
  return `bun-${platformName(process.platform)}-${process.arch}`
}

/** `bun-windows-x64` → `{ platform, arch }` in package.json terms. */
function splitTarget(target: string): { platform: string; arch: string; nodeOs: string } {
  const [, platform, arch] = target.split("-")
  if (!platform || !arch) throw new Error(`unrecognised target "${target}" — expected bun-<os>-<arch>`)
  const nodeOs = platform === "windows" ? "win32" : platform
  return { platform, arch, nodeOs }
}

/** Runs a command in the workspace root; returns false instead of throwing. */
async function run(command: string[], label: string): Promise<boolean> {
  const proc = Bun.spawn(command, { cwd: root, stdio: ["ignore", "inherit", "inherit"] })
  const code = await proc.exited
  if (code !== 0) console.error(`  ✖ ${label} failed (exit ${code})`)
  return code === 0
}

async function readVersion(): Promise<string> {
  const manifest = (await Bun.file(cliManifestPath).json()) as { version?: string }
  if (!manifest.version) throw new Error(`no version in ${cliManifestPath}`)
  return manifest.version
}

/**
 * The published launcher. Prefers the prebuilt executable when a platform
 * package is installed, and falls back to the bundle (which needs Bun).
 */
const LAUNCHER = `#!/usr/bin/env bun
// IMURUN launcher — prefers the prebuilt executable for this platform and falls
// back to the bundled JavaScript, which needs Bun on PATH.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

const osName = process.platform === "win32" ? "windows" : process.platform
const ext = process.platform === "win32" ? ".exe" : ""

function nativeBinary() {
  try {
    const pkg = require.resolve(\`@imurun/\${osName}-\${process.arch}/package.json\`)
    const candidate = join(dirname(pkg), "bin", \`imurun\${ext}\`)
    if (existsSync(candidate)) return candidate
  } catch {
    // no platform package installed — fall through to the bundle
  }
  return undefined
}

const args = process.argv.slice(2)
const binary = nativeBinary()
const child = binary
  ? spawnSync(binary, args, { stdio: "inherit" })
  : spawnSync("bun", [join(here, "..", "dist", "imurun.js"), ...args], { stdio: "inherit" })

if (child.error) {
  console.error(child.error.message)
  process.exit(1)
}
process.exit(child.status ?? 0)
`

const README = `# IMURUN

Local-first AI coding agent for the terminal. Installs, manages and runs large
language models entirely on your own hardware — no cloud, no telemetry.

    npm install -g imurun
    imurun

On first run IMURUN inspects your machine, recommends a model for it, downloads
the engine and the weights, and opens the chat UI. Requires Bun (>= 1.2) on
PATH — from https://bun.sh, or installed for you by the official installer.

Prebuilt standalone executables are published as optional platform packages and
are used automatically when present, so an install with a matching binary needs
no Bun at all.

MIT © ImuTechz
`

// ── 1. bundle ───────────────────────────────────────────────────────────────

console.log("\n▶ bundling the CLI")
if (!existsSync(cliEntry)) {
  console.error(`  CLI entry not found at ${cliEntry}`)
  process.exit(1)
}

const version = await readVersion()
const bundleDir = join(outDir, "bundle")
const bundlePath = join(bundleDir, "imurun.js")

await rm(outDir, { recursive: true, force: true })
await mkdir(bundleDir, { recursive: true })

// `--target=bun` keeps `bun:sqlite` and the Bun APIs native and inlines every
// dependency, so the staged package needs no node_modules at all.
const bundled = await run(
  [
    process.execPath,
    "build",
    cliEntry,
    "--target=bun",
    `--outfile=${bundlePath}`,
    "--minify-whitespace",
    "--minify-identifiers",
  ],
  "bundle",
)
if (!bundled) process.exit(1)

const bundleBytes = (await Bun.file(bundlePath).arrayBuffer()).byteLength
console.log(`  imurun.js  ${(bundleBytes / 1024 / 1024).toFixed(2)} MB  (self-contained)`)

// ── 2. standalone executables ───────────────────────────────────────────────

const targets = wantBinaries
  ? explicitTargets
    ? explicitTargets.split(",").map((target) => target.trim()).filter(Boolean)
    : [hostTarget()]
  : []
const binaries: Array<{ target: string; file: string; bytes: number }> = []

for (const target of targets) {
  const { platform, arch } = splitTarget(target)
  const binaryDir = join(outDir, "binaries")
  await mkdir(binaryDir, { recursive: true })
  // The extension follows the *target*, not the machine doing the build: a
  // Linux binary compiled on Windows is still a Linux binary, and naming it
  // `imurun-linux-x64.exe` would break every documented download URL.
  const extension = platform === "windows" ? ".exe" : ""
  const file = join(binaryDir, `imurun-${platform}-${arch}${extension}`)

  console.log(`\n▶ compiling ${target}`)
  const ok = await run(
    [process.execPath, "build", "--compile", `--target=${target}`, cliEntry, `--outfile=${file}`],
    target,
  )
  if (!ok) continue

  const bytes = (await Bun.file(file).arrayBuffer()).byteLength
  binaries.push({ target, file, bytes })
  console.log(`  imurun-${platform}-${arch}${extension}  ${(bytes / 1024 / 1024).toFixed(1)} MB`)
}

if (wantBinaries && binaries.length === 0) {
  console.error("\n✖ no executables were produced")
  process.exit(1)
}

// ── 3. stage the npm packages ───────────────────────────────────────────────

const npmDir = join(outDir, "npm")
const mainPackageDir = join(npmDir, "imurun")
const optionalDependencies: Record<string, string> = {}

for (const binary of binaries) {
  const { platform, arch, nodeOs } = splitTarget(binary.target)
  const name = `@imurun/${platform}-${arch}`
  const dir = join(npmDir, `imurun-${platform}-${arch}`)
  await mkdir(join(dir, "bin"), { recursive: true })
  await cp(binary.file, join(dir, "bin", `imurun${platform === "windows" ? ".exe" : ""}`))

  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version,
        private: false,
        description: `IMURUN standalone executable for ${platform}-${arch}`,
        license: "MIT",
        author: "ImuTechz",
        repository: "https://github.com/shubham001312/imurun",
        os: [nodeOs],
        cpu: [arch],
        files: ["bin/"],
      },
      null,
      2,
    ) + "\n",
  )
  optionalDependencies[name] = version
}

await mkdir(join(mainPackageDir, "dist"), { recursive: true })
await mkdir(join(mainPackageDir, "bin"), { recursive: true })
await cp(bundlePath, join(mainPackageDir, "dist", "imurun.js"))
await cp(join(root, "LICENSE"), join(mainPackageDir, "LICENSE"))
await Bun.write(join(mainPackageDir, "README.md"), README)
await Bun.write(join(mainPackageDir, "bin", "imurun.js"), LAUNCHER)
// Harmless on Windows (where npm writes a .cmd shim anyway), required on Unix.
await chmod(join(mainPackageDir, "bin", "imurun.js"), 0o755).catch(() => {})

const manifest = {
  name: "imurun",
  version,
  private: false,
  type: "module",
  description: "Local-first AI coding agent — installs, manages and runs local LLMs on your own machine.",
  license: "MIT",
  author: "ImuTechz",
  repository: "https://github.com/shubham001312/imurun",
  homepage: "https://github.com/shubham001312/imurun#readme",
  bugs: "https://github.com/shubham001312/imurun/issues",
  // Bun is the runtime the bundle is built for; the SQLite store cannot open
  // without it, so this is a hard floor rather than a suggestion.
  engines: { bun: ">=1.2.0" },
  bin: { imurun: "./bin/imurun.js" },
  files: ["bin/", "dist/", "LICENSE", "README.md"],
  keywords: ["ai", "agent", "llm", "local", "llama.cpp", "coding", "cli", "offline"],
  ...(Object.keys(optionalDependencies).length > 0 ? { optionalDependencies } : {}),
}
await Bun.write(join(mainPackageDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")

const platformCount = Object.keys(optionalDependencies).length
console.log("\n▶ staged npm package")
console.log(`  ${mainPackageDir}`)
console.log(`  imurun@${version}${platformCount > 0 ? ` + ${platformCount} platform package(s)` : ""}`)

console.log(`\n✔ packaged imurun@${version}`)
console.log(`  artifacts in ${outDir}`)
console.log("  install locally with:")
console.log(`    npm install -g ${mainPackageDir}`)
console.log("")

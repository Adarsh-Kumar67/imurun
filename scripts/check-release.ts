#!/usr/bin/env bun
/**
 * The release check — everything that must work before anything is published.
 *
 * A release that is not tested is a release that might not start. The unit
 * suite proves the logic; this proves the *package*: the files npm and PyPI
 * will actually hand to a person.
 *
 * What it does, in order:
 *
 *   1. Type checks every package.
 *   2. Runs the whole test suite, and the Python launcher's suite.
 *   3. Builds the npm package and the Python wheel.
 *   4. Installs the npm package into a **clean directory** — not the one on
 *      PATH — and runs the installed command: the version, the help, the
 *      model list, the setup check. A package that installs but does not run
 *      is caught here, not by the person who installs it.
 *   5. Installs the wheel into a **clean virtual environment** and runs it
 *      the same way.
 *   6. Checks the launcher says something useful when Bun is missing.
 *   7. Checks that the release assets the README promises are really there.
 *
 * It never touches the machine's own installation, and it never reaches the
 * network except through the package managers' own registries.
 *
 * Usage:
 *
 *   bun run check              # everything
 *   bun run check -- --quick   # skip the install-and-run steps
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const argv = process.argv.slice(2)
const quick = argv.includes("--quick")
const skipPython = argv.includes("--no-python")

let failures = 0
let checks = 0

function heading(text: string): void {
  console.log(`\n▶ ${text}`)
}

function ok(text: string): void {
  checks++
  console.log(`  \x1b[32m✔\x1b[39m ${text}`)
}

function bad(text: string, detail?: string): void {
  checks++
  failures++
  console.log(`  \x1b[31m✖\x1b[39m ${text}`)
  if (detail) {
    for (const line of detail.split("\n").slice(0, 12)) console.log(`      ${line}`)
  }
}

/**
 * Quotes an argument for the shell.
 *
 * Windows needs this: a path with a space in it — and the workspace usually
 * has one — is cut in half by the shell unless it is quoted. Every path this
 * script passes goes through here.
 */
function quoteArg(arg: string): string {
  if (process.platform !== "win32") return arg
  if (!/[\s"&|<>^]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): {
  status: number
  output: string
} {
  // On Windows the command is run through the shell (npm and pip are batch
  // files), so the whole line is built here, with every part quoted. On
  // Unix the arguments are passed as an array, where the shell cannot touch
  // them at all.
  const line = [command, ...args].map(quoteArg).join(" ")
  const result =
    process.platform === "win32"
      ? spawnSync(line, {
          cwd: options.cwd ?? root,
          encoding: "utf8",
          env: { ...process.env, ...options.env },
          shell: true,
        })
      : spawnSync(command, args, {
          cwd: options.cwd ?? root,
          encoding: "utf8",
          env: { ...process.env, ...options.env },
        })
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

const bun = process.execPath
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const python = process.platform === "win32" ? "python" : "python3"

/** The version the whole project is at, read from the CLI's own source. */
function readVersion(): string {
  const source = readFileSync(join(root, "packages", "cli", "src", "version.ts"), "utf8")
  return /VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? "0.0.0"
}

// ── 1. the static checks ────────────────────────────────────────────────────

heading("type check")
{
  const result = run(bun, ["run", "typecheck"])
  if (result.status === 0) ok("every package type checks")
  else bad("the type check failed", result.output)
}

heading("test suite")
{
  const result = run(bun, ["test"])
  if (result.status === 0) {
    const line = result.output.split("\n").find((text) => /\d+ pass/.test(text)) ?? ""
    ok(`the TypeScript suite passes (${line.trim()})`)
  } else {
    bad("the TypeScript suite failed", result.output)
  }
}

if (!skipPython) {
  heading("python launcher suite")
  {
    const result = run(python, ["-m", "unittest", "discover", "-s", "tests", "-t", "."], {
      cwd: join(root, "python"),
    })
    if (result.status === 0) ok("the Python launcher suite passes")
    else bad("the Python launcher suite failed", result.output)
  }
}

// ── 2. build ────────────────────────────────────────────────────────────────

heading("build the npm package")
{
  const result = run(bun, ["run", "package"])
  if (result.status === 0) ok("the npm package is staged")
  else bad("the npm package could not be built", result.output)
}

const packageDir = join(root, "dist", "package", "npm", "imurun")

if (!quick) {
  // ── 3. install it the way a person would, and run it ─────────────────────

  heading("install the npm package into a clean directory and run it")
  const prefix = join(tmpdir(), `imurun-check-npm-${Date.now()}`)
  mkdirSync(prefix, { recursive: true })
  {
    const result = run(npm, ["install", "--prefix", prefix, "--no-audit", "--no-fund", packageDir], {
      // The setup must not run here: this is a check, not an install for the
      // person who is watching. The hook is exercised separately below.
      env: { IMURUN_SKIP_SETUP: "1" },
    })
    if (result.status === 0) ok("the package installs")
    else bad("the package does not install", result.output)
  }

  const installed = join(prefix, "node_modules", ".bin", process.platform === "win32" ? "imurun.cmd" : "imurun")
  if (!existsSync(installed)) {
    bad("the imurun command was not created on PATH by the install")
  } else {
    ok("the imurun command is created")

    const version = run(installed, ["--version"])
    if (version.status === 0 && version.output.includes(readVersion())) {
      ok(`the installed command runs: ${version.output.trim()}`)
    } else {
      bad("the installed command does not run", version.output)
    }

    const help = run(installed, ["--help"])
    if (help.status === 0 && help.output.includes("setup") && help.output.includes("update")) {
      ok("the installed command lists its commands")
    } else {
      bad("the installed command does not print its help", help.output)
    }

    const models = run(installed, ["models"], { env: { IMURUN_HOME: join(prefix, "home") } })
    if (models.status === 0 && models.output.includes("Detected")) {
      ok("the installed command detects the machine")
    } else {
      bad("the installed command cannot detect the machine", models.output)
    }

    const check = run(installed, ["setup", "--check"], { env: { IMURUN_HOME: join(prefix, "home") } })
    if (check.status === 0 && check.output.includes("What would be installed")) {
      ok("the installed command can plan a setup")
    } else {
      bad("the installed command cannot plan a setup", check.output)
    }

    const update = run(installed, ["update", "check"], { env: { IMURUN_HOME: join(prefix, "home") } })
    if (update.status === 0) ok("the installed command can check for an update")
    else bad("the installed command cannot check for an update", update.output)
  }
  rmSync(prefix, { recursive: true, force: true })

  // ── 4. the launcher, when Bun is missing ─────────────────────────────────

  heading("the launcher explains a missing Bun")
  {
    const launcher = join(packageDir, "bin", "imurun.js")
    if (!existsSync(launcher)) {
      bad("the launcher was not packaged")
    } else {
      // An empty PATH: no bun, no node, nothing. The launcher must say what
      // to do rather than printing a spawn error.
      const result = run(bun, [launcher, "--version"], {
        env: { PATH: "", IMURUN_HOME: join(tmpdir(), "imurun-check-empty") },
      })
      const output = result.output
      if (output.includes("Bun") && output.includes("bun.sh")) {
        ok("a missing Bun is explained, not dumped as a spawn error")
      } else {
        bad("a missing Bun is not explained", output)
      }
    }
  }

  // ── 5. the postinstall hook, on its own ──────────────────────────────────

  heading("the postinstall hook runs and never fails the install")
  {
    const hook = join(packageDir, "bin", "postinstall.js")
    if (!existsSync(hook)) {
      bad("the postinstall hook was not packaged")
    } else {
      const result = run(process.execPath, [hook], {
        env: { IMURUN_SKIP_SETUP: "1", IMURUN_HOME: join(tmpdir(), "imurun-check-hook") },
      })
      if (result.status === 0 && result.output.includes("IMURUN is installed")) {
        ok("the hook runs and says what it did")
      } else {
        bad("the hook did not run cleanly", result.output)
      }
    }
  }

  // ── 6. the python wheel, in a clean virtual environment ──────────────────

  if (!skipPython) {
    heading("install the wheel into a clean virtual environment and run it")
    const venv = join(tmpdir(), `imurun-check-venv-${Date.now()}`)
    {
      const result = run(python, ["-m", "venv", venv])
      if (result.status !== 0) {
        bad("a virtual environment could not be created", result.output)
      } else {
        ok("a virtual environment was created")
        const vpython = join(venv, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python")

        // The wheel is built here, so the check never depends on a leftover
        // from an earlier build — and the old ones are cleared, so the wheel
        // that gets installed is the one that was just built.
        const wheelDir = join(root, "python", "dist")
        rmSync(wheelDir, { recursive: true, force: true })
        const build = run(python, ["-m", "build", "--wheel", "--outdir", "dist"], {
          cwd: join(root, "python"),
        })
        if (build.status !== 0) {
          bad("the wheel could not be built", build.output)
        } else {
          ok("the wheel is built")
          const wheels = readdirSync(wheelDir).filter((file) => file.endsWith(".whl"))
          const wheel = wheels.sort().pop()
          if (!wheel) {
            bad("no wheel was produced")
          } else {
            // The wheel must carry the same version as the program, or the
            // launcher would report a version the CLI does not have.
            const expected = readVersion()
            if (!wheel.includes(expected)) {
              bad(`the wheel is not the current version (expected ${expected}, built ${wheel})`)
            } else {
              ok(`the wheel carries version ${expected}`)
            }
            const install = run(vpython, ["-m", "pip", "install", "--quiet", join(wheelDir, wheel!)])
            if (install.status === 0) {
              ok("the wheel installs")
              const script = join(venv, process.platform === "win32" ? "Scripts" : "bin", "imurun")
              const version = run(script, ["--version"])
              if (version.status === 0 && version.output.includes(expected)) {
                ok(`the installed launcher runs: ${version.output.trim()}`)
              } else {
                bad("the installed launcher does not run", version.output)
              }
            } else {
              bad("the wheel does not install", install.output)
            }
          }
        }
        rmSync(venv, { recursive: true, force: true })
      }
    }
  }
}

// ── 7. what the release promises ────────────────────────────────────────────

heading("the package contains what the docs promise")
{
  const manifest = join(packageDir, "package.json")
  if (!existsSync(manifest)) {
    bad("the staged package has no manifest")
  } else {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      bin?: Record<string, string>
      scripts?: Record<string, string>
      files?: string[]
      version?: string
    }
    if (pkg.bin?.imurun && !pkg.bin.imurun.startsWith("./")) ok("the bin entry points at the launcher")
    else bad("the bin entry is wrong", JSON.stringify(pkg.bin))
    if (pkg.scripts?.postinstall) ok("the install sets the machine up")
    else bad("there is no postinstall hook")
    for (const file of ["bin/imurun.js", "bin/postinstall.js", "dist/imurun.js", "README.md", "LICENSE"]) {
      if (existsSync(join(packageDir, file))) ok(`${file} is in the package`)
      else bad(`${file} is missing from the package`)
    }
  }
}

// ── the verdict ─────────────────────────────────────────────────────────────

console.log("")
if (failures === 0) {
  console.log(`  \x1b[32m✔ ${checks} checks passed — ready to release.\x1b[39m`)
  console.log("")
  process.exit(0)
}
console.log(`  \x1b[31m✖ ${failures} of ${checks} checks failed — not ready to release.\x1b[39m`)
console.log("")
process.exit(1)

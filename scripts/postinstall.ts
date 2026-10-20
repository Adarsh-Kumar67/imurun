#!/usr/bin/env bun
/**
 * The npm `postinstall` hook — the machine is ready when the install finishes.
 *
 * Installing the program is only half of it. To answer a question you also
 * need the inference engine and a model file, and until both are there the
 * `imurun` command does nothing useful. So the install does that part too:
 * the engine is downloaded, the model that fits the machine is chosen, and
 * the weights are fetched.
 *
 * The rules that keep this safe:
 *
 *   1. **It never fails the install.** A machine with no network, no disk
 *      space, or no working package manager still ends up with IMURUN
 *      installed. The hook reports what went wrong and exits successfully.
 *   2. **It never downloads anything twice.** A machine that already has a
 *      model is left alone.
 *   3. **It can be turned off.** `IMURUN_SKIP_SETUP=1 npm install -g imurun`
 *      installs the program and nothing else.
 *
 * The same work is available by hand as `imurun setup`.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = join(fileURLToPath(new URL(".", import.meta.url)))
const require = createRequire(import.meta.url)
const quiet = process.env.IMURUN_QUIET === "1" || process.env.npm_config_loglevel === "silent"

function say(message: string): void {
  if (!quiet) process.stdout.write(`${message}\n`)
}

/** The bundled program, which is what the hook should run. */
function programPath(): string | undefined {
  const candidate = join(here, "..", "dist", "imurun.js")
  return existsSync(candidate) ? candidate : undefined
}

/**
 * The standalone executable, when the platform package was installed.
 *
 * A machine with the binary does not need Bun at all, and the binary is
 * faster to start than the bundle.
 */
function nativeBinary(): string | undefined {
  const osName = process.platform === "win32" ? "windows" : process.platform
  const ext = process.platform === "win32" ? ".exe" : ""
  try {
    const pkg = require.resolve(`@imurun/${osName}-${process.arch}/package.json`)
    const candidate = join(pkg.replace(/[\\/]package\.json$/, ""), "bin", `imurun${ext}`)
    if (existsSync(candidate)) return candidate
  } catch {
    // No platform package — fall through to the bundle.
  }
  return undefined
}

if (process.env.IMURUN_SKIP_SETUP === "1") {
  say("")
  say("  IMURUN is installed. Run `imurun setup` when you want the engine and a model.")
  say("")
  process.exit(0)
}

say("")
say("  IMURUN is installed.")
say("  Setting this machine up — the engine and a model that fits it.")
say("  This downloads a few gigabytes. To skip it, run:")
say("    IMURUN_SKIP_SETUP=1 npm install -g imurun")
say("")

const binary = nativeBinary()
const program = programPath()

// The standalone binary, else Bun with the bundle, else nothing to run.
let child: ReturnType<typeof spawnSync> | undefined
if (binary) {
  child = spawnSync(binary, ["setup", "--quiet"], { stdio: quiet ? "ignore" : "inherit" })
} else if (program) {
  child = spawnSync("bun", [program, "setup", "--quiet"], { stdio: quiet ? "ignore" : "inherit" })
}

if (!child || child.error || child.status !== 0) {
  // A failed setup must not undo the install.
  say("")
  say("  IMURUN is installed, but the automatic setup did not finish.")
  if (child?.error && /bun/i.test(child.error.message)) {
    say("  Bun does not seem to be on your PATH. Install it from https://bun.sh, then run `imurun setup`.")
  } else {
    say("  Run `imurun setup` to try again, or `imurun models list --all` to choose a model yourself.")
  }
  say("")
  process.exit(0)
}

say("")
say("  Ready. Run `imurun` to start.")
say("")
process.exit(0)

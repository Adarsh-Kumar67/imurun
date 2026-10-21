/**
 * Installing the deep engine.
 *
 * AirLLM and PyTorch live in Python, so the deep engine gets its own
 * virtualenv under `~/.imurun/engines/airllm/venv` rather than touching the
 * user's site-packages. That is deliberate: torch is two gigabytes and pins
 * specific CUDA builds, and a coding tool has no business changing the Python
 * a person uses for their own work.
 *
 * The download is large, so progress is reported line by line. An install
 * that says nothing for five minutes looks broken, and this one takes about
 * that long on a slow connection.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { imurunDir, logger } from "@imurun/util"

const log = logger.child("airllm-install")

export interface AirllmInstallOptions {
  /** Explicit Python 3 interpreter. */
  python?: string
  /** Force a reinstall even when the engine already imports. */
  force?: boolean
  /** One line of progress (pip output, or a stage description). */
  onStatus?: (message: string) => void
}

export interface AirllmInstallResult {
  installed: boolean
  /** The interpreter that has airllm, when it worked. */
  python?: string
  reason?: string
}

export function airllmEngineDir(): string {
  return join(imurunDir("engines"), "airllm")
}

export function airllmVenvDir(): string {
  return join(airllmEngineDir(), "venv")
}

/** The virtualenv's interpreter, when the virtualenv exists. */
export function airllmVenvPython(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [join(airllmVenvDir(), "Scripts", "python.exe")]
      : [join(airllmVenvDir(), "bin", "python3"), join(airllmVenvDir(), "bin", "python")]
  return candidates.find((candidate) => existsSync(candidate))
}

/** The system interpreter, for creating the virtualenv. */
function systemPython(explicit?: string): { command: string; prefix: string[] } | undefined {
  if (explicit && existsSync(explicit)) return { command: explicit, prefix: [] }
  const python = Bun.which("python")
  if (python) return { command: python, prefix: [] }
  const python3 = Bun.which("python3")
  if (python3) return { command: python3, prefix: [] }
  const py = Bun.which("py")
  if (py) return { command: py, prefix: ["-3"] }
  return undefined
}

/** Runs a command, passing every line of output to `onStatus`. */
async function run(
  command: string,
  args: string[],
  onStatus: (message: string) => void,
): Promise<number> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    windowsHide: true,
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONUNBUFFERED: "1" },
  })

  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n|\r/)
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const text = line.trim()
        if (text) onStatus(text)
      }
    }
    if (buffer.trim()) onStatus(buffer.trim())
  }

  await Promise.all([pump(proc.stdout), pump(proc.stderr)])
  return await proc.exited
}

/** True when this interpreter can `import airllm` and `import torch`. */
function canImport(python: string): boolean {
  const result = spawnSync(python, ["-c", "import airllm, torch"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 120_000,
  })
  return (result.status ?? 1) === 0
}

/**
 * Makes the deep engine runnable.
 *
 * Safe to call repeatedly: an interpreter that already imports airllm is left
 * alone. It returns a result rather than throwing, so a failed download is a
 * message and not a broken install.
 */
export async function ensureAirllmEngine(
  options: AirllmInstallOptions = {},
): Promise<AirllmInstallResult> {
  const status = options.onStatus ?? (() => {})
  const existing = airllmVenvPython()

  if (existing && !options.force && canImport(existing)) {
    status("the deep engine is already installed")
    return { installed: true, python: existing }
  }

  const base = systemPython(options.python)
  if (!base) {
    return {
      installed: false,
      reason: "Python 3 is not on PATH. Install it from python.org, then run `imurun setup --deep`.",
    }
  }

  try {
    await mkdir(airllmEngineDir(), { recursive: true })
  } catch (error) {
    return { installed: false, reason: `could not create ${airllmEngineDir()}: ${String(error)}` }
  }

  if (!existing || options.force) {
    status("creating the deep engine's virtualenv")
    const code = await run(base.command, [...base.prefix, "-m", "venv", airllmVenvDir()], status)
    if (code !== 0) {
      return { installed: false, reason: "could not create the virtualenv (is the venv module installed?)" }
    }
  }

  const python = airllmVenvPython()
  if (!python) {
    return { installed: false, reason: "the virtualenv was created but has no interpreter" }
  }

  status("updating pip")
  await run(python, ["-m", "pip", "install", "--progress-bar", "off", "--upgrade", "pip", "wheel"], status)

  // AirLLM pulls torch and transformers. `--extra-index-url` is deliberately
  // absent: the CPU build from PyPI works everywhere, and a CUDA build that
  // does not match the driver is worse than a slower one that does.
  status("installing airllm and torch (this is the big download, about 2.5 GB)")
  const code = await run(
    python,
    ["-m", "pip", "install", "--progress-bar", "off", "--upgrade", "airllm"],
    status,
  )
  if (code !== 0) {
    return {
      installed: false,
      reason:
        "pip could not install airllm. The output above says why; a Python that is too new for " +
        "PyTorch is the usual cause. Try a Python 3.11-3.13 interpreter via runtime.airllm.python.",
    }
  }

  if (!canImport(python)) {
    return {
      installed: false,
      reason: "airllm was installed but does not import - see the pip output above.",
    }
  }

  log.info(`deep engine installed at ${python}`)
  status("the deep engine is ready")
  return { installed: true, python }
}

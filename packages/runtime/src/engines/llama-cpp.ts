/**
 * llama.cpp engine — supervises a llama-server process.
 *
 * The binary is installed by the model manager (M5) into
 * ~/.imurun/engines/llama.cpp/<platform>/; this engine locates it, spawns it
 * with the tuned flags for fast local inference (flash attention, tuned
 * batches, KV reuse), and manages its lifecycle.
 */
import { existsSync, closeSync, openSync } from "node:fs"
import { cpus } from "node:os"
import { dirname, join } from "node:path"
import type { Engine, EngineHandle, EngineHealth, EngineStartOptions } from "./base"
import { isProcessAlive, killProcess, waitForHTTP } from "./base"
import { ensureDir, imurunDir, logger } from "@imurun/util"

const log = logger.child("llama-cpp")

export interface LlamaCppPaths {
  /** Directory containing the llama-server binary. */
  binaryDir: string
  /** Full path to the binary. */
  binary: string
}

/** Where llama.cpp builds live once installed. */
export function llamaCppInstallDir(): string {
  return imurunDir("engines", "llama.cpp")
}

const BINARY_NAME = process.platform === "win32" ? "llama-server.exe" : "llama-server"

/**
 * Largest context to load when the user has not asked for a specific size.
 * Models advertise windows far beyond what a laptop can hold in KV cache, so
 * "auto" uses the model's own window up to this cap — and anything past the
 * model's trained window is reached with YaRN (see buildLlamaServerArgs).
 */
export const AUTO_CONTEXT_CAP = 32_768

export interface LlamaContextPlan {
  /** Value for --ctx-size, or 0 when llama.cpp should decide. */
  contextSize: number
  /** RoPE method to pass, or undefined for "leave it alone" (no flag). */
  ropeScaling?: "linear" | "yarn"
  /** Context-extension factor to pass as --rope-scale. */
  ropeScale?: number
  /** Trained window passed as --yarn-orig-ctx. */
  yarnOrigContext?: number
}

/**
 * Chooses the context window and the RoPE scaling needed to reach it.
 *
 * YaRN is what makes a 32k-trained model usable at 64k or 128k: llama.cpp
 * interpolates the rotary frequencies instead of running off the end of the
 * trained range. It is only ever switched on when it is actually needed —
 * asking for more context than the model was trained on — because extended
 * context costs KV memory and a little quality.
 */
export function planLlamaContext(options: {
  contextSize?: number
  nativeContextSize?: number
  ropeScaling?: "auto" | "none" | "linear" | "yarn"
  ropeScale?: number
}): LlamaContextPlan {
  const native = options.nativeContextSize && options.nativeContextSize > 0 ? options.nativeContextSize : 0
  const requested = options.contextSize && options.contextSize > 0 ? options.contextSize : 0

  // Explicit size wins; otherwise use the model's own window, capped. When the
  // trained window is unknown the cap is passed anyway: llama.cpp's own default
  // is 4096, which truncates ordinary conversations, and a size being requested
  // is always better than silently using a four-thousand-token window.
  const contextSize = requested || (native > 0 ? Math.min(native, AUTO_CONTEXT_CAP) : AUTO_CONTEXT_CAP)

  const mode = options.ropeScaling ?? "auto"
  if (mode === "none") return { contextSize }

  // An explicit factor means "extend, however big that turns out to be".
  let scale = options.ropeScale && options.ropeScale > 0 ? options.ropeScale : 0
  if (!scale && native > 0 && contextSize > native) scale = contextSize / native

  if (mode === "auto") {
    if (!(scale > 1)) return { contextSize }
  } else if (!(scale > 1)) {
    // force the requested method even without a derivable factor
    scale = native > 0 && contextSize > native ? contextSize / native : 1
  }

  const method = mode === "auto" ? "yarn" : mode
  return {
    contextSize,
    ropeScaling: method,
    ropeScale: scale > 1 ? scale : undefined,
    yarnOrigContext: method === "yarn" && native > 0 ? native : undefined,
  }
}

/**
 * One-line human summary of a context plan, e.g.
 *   "65,536 tokens · yarn ×2.0 from 32,768"
 * Returns undefined when the size is left to llama.cpp.
 */
export function describeContextPlan(plan: LlamaContextPlan): string | undefined {
  if (!plan.contextSize) return undefined
  const tokens = plan.contextSize.toLocaleString("en-US")
  if (!plan.ropeScaling) return `${tokens} tokens`
  const factor = plan.ropeScale ? ` \u00d7${plan.ropeScale.toFixed(1)}` : ""
  const origin = plan.yarnOrigContext ? ` from ${plan.yarnOrigContext.toLocaleString("en-US")}` : ""
  return `${tokens} tokens \u00b7 ${plan.ropeScaling}${factor}${origin}`
}

/** Builds the llama-server command line for a start request. */export function buildLlamaServerArgs(options: EngineStartOptions, defaults: { threads: number }): string[] {
  if (!options.modelPath) throw new Error("llama.cpp engine requires a modelPath (GGUF file).")
  const gpuLayers = options.gpuLayers ?? -1
  const plan = planLlamaContext(options)

  const args: string[] = [
    "--model",
    options.modelPath,
    "--port",
    String(options.port),
    "--host",
    "127.0.0.1",
    "--batch-size",
    "2048",
    "--ubatch-size",
    "512",
    "--threads",
    String(options.threads && options.threads > 0 ? options.threads : defaults.threads),
    "--no-webui",
    "--metrics",
    "--cache-reuse",
    "256",
    "--jinja",
  ]

  if (plan.contextSize > 0) {
    args.push("--ctx-size", String(plan.contextSize))
  }
  // Note: never leave --ctx-size unset. llama.cpp defaults to 4096, which makes
  // even a short conversation fail with "exceeds the available context size".

  if (plan.ropeScaling) {
    args.push("--rope-scaling", plan.ropeScaling)
    if (plan.ropeScale) args.push("--rope-scale", plan.ropeScale.toFixed(3))
    if (plan.yarnOrigContext) args.push("--yarn-orig-ctx", String(plan.yarnOrigContext))
  }

  if (options.flashAttention !== false) {
    // Recent llama.cpp builds require an explicit value here; without one the
    // parser swallows the following flag (e.g. --alias) and exits.
    args.push("--flash-attn", "auto")
  }
  // Keep the log file readable — no ANSI colors when writing to disk.
  args.push("--log-colors", "off")
  if (options.mmprojPath) {
    args.push("--mmproj", options.mmprojPath)
  }
  if (options.modelName) {
    // makes /v1/models report the catalog id the agent asks for
    args.push("--alias", options.modelName)
  }

  if (gpuLayers === 0) {
    args.push("--device", "none", "--n-gpu-layers", "0")
  } else if (gpuLayers > 0) {
    args.push("--n-gpu-layers", String(gpuLayers))
  }
  // gpuLayers === -1 (auto): leave --n-gpu-layers unset so llama.cpp fits the
  // model to the GPU's free memory itself. It offloads everything on a large
  // GPU and only as many layers as fit on a small one, instead of aborting
  // with "ErrorOutOfDeviceMemory" when the model is bigger than VRAM.

  return args
}

export function findLlamaCppBinary(overrideDir?: string): LlamaCppPaths | undefined {
  const dirs = [overrideDir, llamaCppInstallDir()].filter((d): d is string => Boolean(d))
  for (const dir of dirs) {
    const binary = join(dir, BINARY_NAME)
    if (existsSync(binary)) return { binaryDir: dir, binary }
    // also check versioned subdirectories, e.g. engines/llama.cpp/b6449/
    try {
      const glob = new Bun.Glob(`**/${BINARY_NAME}`)
      for (const found of glob.scanSync({ cwd: dir, onlyFiles: true })) {
        return { binaryDir: dir, binary: join(dir, found) }
      }
    } catch {
      // dir missing
    }
  }
  return undefined
}

export class LlamaCppEngine implements Engine {
  readonly id = "llama-cpp"
  readonly displayName = "llama.cpp (bundled)"

  constructor(private readonly binaryDirOverride?: string) {}

  async isAvailable(): Promise<{ available: boolean; detail?: string }> {
    const found = findLlamaCppBinary(this.binaryDirOverride)
    if (!found) {
      return {
        available: false,
        detail: "llama-server binary not installed yet. It is downloaded automatically with the first model install (M5).",
      }
    }
    return { available: true, detail: found.binary }
  }

  async start(options: EngineStartOptions): Promise<EngineHandle> {
    const found = findLlamaCppBinary(this.binaryDirOverride)
    if (!found) {
      throw new Error("llama-server binary not found. Install a model first (imurun models install <id>).")
    }
    if (!options.modelPath) {
      throw new Error("llama.cpp engine requires a modelPath (GGUF file).")
    }

    const defaultThreads = Math.max(Math.floor(cpus().length / 2), 2)
    const args = buildLlamaServerArgs(options, { threads: defaultThreads })

    const plan = planLlamaContext(options)
    log.info(
      `starting llama-server on port ${options.port} (context ${plan.contextSize || "model default"}` +
        `${plan.ropeScaling ? `, ${plan.ropeScaling} ×${plan.ropeScale?.toFixed(2) ?? "?"}` : ""})`,
    )
    log.debug(`binary: ${found.binary}`)

    // Capture the server's stderr straight into the runtime log. This is an
    // OS-level redirect (a file descriptor, not a pipe back into this process),
    // so it never pins this client's event loop open after the turn ends — and
    // unlike llama.cpp's own --log-file it reliably records crash output.
    let logHandle: number | undefined
    if (options.logFile) {
      await ensureDir(dirname(options.logFile))
      try {
        logHandle = openSync(options.logFile, "w")
      } catch {
        logHandle = undefined
      }
    }

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([found.binary, ...args], {
        stdout: "ignore",
        stderr: logHandle ?? "ignore",
        stdin: "ignore",
        windowsHide: true,
        env: { ...process.env },
      })
    } finally {
      if (logHandle !== undefined) {
        try {
          closeSync(logHandle)
        } catch {
          // the child owns the handle now
        }
      }
    }
    // Detach so the engine is owned by the supervisor, not by this client.
    try {
      proc.unref()
    } catch {
      // older runtimes: best effort
    }

    const healthy = await waitForHTTP(`http://127.0.0.1:${options.port}/health`, 120_000)
    if (!healthy || !isProcessAlive(proc.pid)) {
      await killProcess(proc.pid)
      throw new Error(
        "llama-server failed to start (see logs at ~/.imurun/logs/runtime.log). The model may be too large for this machine.",
      )
    }

    log.info(`llama-server ready (pid ${proc.pid})`)
    return { pid: proc.pid, port: options.port, detail: found.binary }
  }

  async stop(handle: Pick<EngineHandle, "pid" | "port">): Promise<void> {
    if (handle.pid) await killProcess(handle.pid)
  }

  /** The window the server actually loaded (it is the authority, not our plan). */
  async contextSize(port: number): Promise<number | undefined> {
    return probeLlamaContext(port)
  }

  async health(port: number): Promise<EngineHealth> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (!response.ok) return { healthy: false, detail: `HTTP ${response.status}` }
      const body = (await response.json()) as { status?: string }
      return { healthy: body.status === "ok" || response.ok }
    } catch (error) {
      return { healthy: false, detail: (error as Error).message }
    }
  }
}

/**
 * Asks llama-server for its real context window (`/props` →
 * `default_generation_settings.n_ctx`).
 *
 * The engine can and does adjust what it was asked for, so the number we
 * planned is only a request; this is the answer, and it is what the agent's
 * request budget has to be sized against.
 */
export async function probeLlamaContext(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      default_generation_settings?: { n_ctx?: number }
      n_ctx?: number
    }
    const size = body.default_generation_settings?.n_ctx ?? body.n_ctx
    return typeof size === "number" && size > 0 ? size : undefined
  } catch {
    return undefined
  }
}

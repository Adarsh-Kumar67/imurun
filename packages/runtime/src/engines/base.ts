/**
 * Engine interface — a local inference backend the supervisor can manage.
 */
import type { RuntimeState } from "../state"

export interface EngineStartOptions {
  /** Absolute path to the GGUF model file (llama.cpp). */
  modelPath?: string
  /** Model name as the engine knows it (ollama) or the API alias (llama.cpp). */
  modelName?: string
  /** Vision projector (mmproj) file to load alongside the model. */
  mmprojPath?: string
  port: number
  /** 0 = auto. */
  threads?: number
  /** -1 = all layers on GPU, 0 = CPU only. */
  gpuLayers?: number
  /** 0 = use the model's trained window. */
  contextSize?: number
  /** RoPE scaling method for extending context beyond the trained window. */
  ropeScaling?: "auto" | "none" | "linear" | "yarn"
  /** Context-extension factor (e.g. 4 = 4×). 0 = derive from the context sizes. */
  ropeScale?: number
  /** The model's trained context window, used as the YaRN origin. */
  nativeContextSize?: number
  flashAttention?: boolean
  logFile?: string
}

export interface EngineHandle {
  pid: number
  port: number
  /** Model name as the engine knows it, when applicable (ollama). */
  model?: string
  /** Line to show in `runtime status`. */
  detail?: string
}

export interface EngineHealth {
  healthy: boolean
  detail?: string
  /** Loaded model name as reported by the engine. */
  loadedModel?: string
}

export interface Engine {
  readonly id: string
  /** Human name for status output. */
  readonly displayName: string
  /** True when the engine can run on this machine right now. */
  isAvailable(): Promise<{ available: boolean; detail?: string }>
  /** Starts the inference server. Resolves once it is listening. */
  start(options: EngineStartOptions): Promise<EngineHandle>
  /**
   * Stops the engine. With unloadOnly, memory is released but a shared
   * service the user may own (e.g. an existing ollama process) stays up.
   */
  stop(handle: Pick<EngineHandle, "pid" | "port" | "model">, options?: { unloadOnly?: boolean }): Promise<void>
  /** Checks a running server's health. */
  health(port: number): Promise<EngineHealth>
  /**
   * The window the server actually loaded, when it can be asked. This is the
   * authority for request budgeting: what we ask for is only a request.
   */
  contextSize?(port: number): Promise<number | undefined>
}

/** Checks if a process with this pid is alive. */
export function isProcessAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Best-effort kill of a process tree; never throws. */
export async function killProcess(pid: number): Promise<void> {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    } else {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        process.kill(pid, "SIGTERM")
      }
    }
  } catch {
    // already dead
  }

  // wait up to 5s for the process to exit, then force-kill
  for (let i = 0; i < 25; i++) {
    if (!isProcessAlive(pid)) return
    await Bun.sleep(200)
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // gone
  }
}

/** Waits for an HTTP endpoint to respond, up to timeoutMs. */
export async function waitForHTTP(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.status < 500) return true
    } catch {
      // not up yet
    }
    await Bun.sleep(400)
  }
  return false
}

export type { RuntimeState }

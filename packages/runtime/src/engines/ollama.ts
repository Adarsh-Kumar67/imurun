/**
 * Ollama engine — uses a system-installed Ollama for local inference.
 *
 * Ollama handles model downloads and loading itself; this engine starts the
 * background service if needed, verifies the model is present, preloads it
 * into memory, and unloads it on stop (keep_alive: 0) so RAM is released
 * without killing a service the user may be using elsewhere.
 */
import type { Engine, EngineHandle, EngineHealth, EngineStartOptions } from "./base"
import { isProcessAlive, killProcess, waitForHTTP } from "./base"
import { logger } from "@imurun/util"

const log = logger.child("ollama")

const OLLAMA_BASE = "http://127.0.0.1:11434"

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>
}

function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`
}

async function ollamaVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return undefined
    const body = (await response.json()) as { version?: string }
    return body.version ?? "unknown"
  } catch {
    return undefined
  }
}

function cliInstalled(): boolean {
  try {
    const proc = Bun.spawnSync(["ollama", "--version"], { stdout: "ignore", stderr: "ignore" })
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export class OllamaEngine implements Engine {
  readonly id = "ollama"
  readonly displayName = "Ollama (system install)"

  async isAvailable(): Promise<{ available: boolean; detail?: string }> {
    const version = await ollamaVersion()
    if (version) return { available: true, detail: `service running (v${version})` }
    if (cliInstalled()) return { available: true, detail: "CLI installed; service will be started on demand" }
    return {
      available: false,
      detail: "Ollama is not installed. Get it from https://ollama.com or use the bundled llama.cpp engine instead.",
    }
  }

  /** Starts `ollama serve` if the service is not already listening. */
  private async ensureServe(): Promise<number | undefined> {
    if (await ollamaVersion()) return undefined

    if (!cliInstalled()) {
      throw new Error("Ollama is not installed. Install it from https://ollama.com or use the bundled llama.cpp engine.")
    }

    log.info("starting ollama serve")
    const proc = Bun.spawn(["ollama", "serve"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      windowsHide: true,
    })

    const up = await waitForHTTP(`${OLLAMA_BASE}/api/version`, 30_000)
    if (!up || !isProcessAlive(proc.pid)) {
      await killProcess(proc.pid)
      throw new Error("ollama serve did not become ready within 30s")
    }
    return proc.pid
  }

  private async hasModel(name: string): Promise<boolean> {
    try {
      const response = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return false
      const body = (await response.json()) as OllamaTagsResponse
      const wanted = normalizeModelName(name)
      return (body.models ?? []).some((m) => normalizeModelName(m.name ?? m.model ?? "") === wanted)
    } catch {
      return false
    }
  }

  /** Preloads a model into memory so the first request is fast. */
  private async preload(name: string): Promise<void> {
    try {
      await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // keep_alive: -1 pins the model in memory; the supervisor unloads it explicitly
        body: JSON.stringify({ model: name, prompt: "", keep_alive: -1 }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (error) {
      log.warn(`preload failed: ${(error as Error).message}`)
    }
  }

  async start(options: EngineStartOptions): Promise<EngineHandle> {
    if (!options.modelName) {
      throw new Error("Ollama engine requires a model name (e.g. qwen2.5-coder:7b).")
    }

    const servePid = await this.ensureServe()

    if (!(await this.hasModel(options.modelName))) {
      throw new Error(
        `Model "${options.modelName}" is not present in Ollama. Pull it first: ollama pull ${options.modelName}`,
      )
    }

    log.info(`preloading ${options.modelName}`)
    await this.preload(options.modelName)

    return {
      pid: servePid ?? 0, // 0 = we do not own the service process
      port: 11434,
      model: options.modelName,
      detail: servePid ? `started ollama serve (pid ${servePid})` : "using existing ollama service",
    }
  }

  async stop(handle: Pick<EngineHandle, "pid" | "port" | "model">, options: { unloadOnly?: boolean } = {}): Promise<void> {
    if (handle.pid && !options.unloadOnly) {
      // we started the service — shut it down entirely
      await killProcess(handle.pid)
      return
    }
    // service is user-owned: just unload the model from memory
    if (handle.model) {
      try {
        await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: handle.model, keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000),
        })
        log.info(`unloaded ${handle.model} from memory`)
      } catch (error) {
        log.warn(`unload failed: ${(error as Error).message}`)
      }
    }
  }

  async health(): Promise<EngineHealth> {
    const version = await ollamaVersion()
    return version ? { healthy: true, detail: `v${version}` } : { healthy: false, detail: "service not reachable" }
  }
}

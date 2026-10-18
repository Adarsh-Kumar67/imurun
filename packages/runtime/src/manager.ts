/**
 * RuntimeManager — the public API for the local inference runtime.
 *
 * Responsibilities:
 *   - status / start / stop / restart of the engine
 *   - background supervision (detached supervisor process)
 *   - foreground supervision (in-process, used by `imurun runtime start`)
 *   - session heartbeats so the model is stopped when terminals close
 *   - activity timestamps so idle models unload
 */
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ImurunConfig } from "@imurun/schema"
import { imurunDir, logger, sleep } from "@imurun/util"
import type { Engine, EngineHealth, EngineHandle, EngineStartOptions } from "./engines/base"
import { isProcessAlive, killProcess } from "./engines/base"
import { LlamaCppEngine, planLlamaContext } from "./engines/llama-cpp"
import { OllamaEngine } from "./engines/ollama"
import { Supervisor, type SupervisorStopReason } from "./supervisor"
import {
  clearHeartbeats,
  clearState,
  clearSupervisorPid,
  readState,
  readSupervisorPid,
  removeHeartbeat,
  touchActivity,
  touchHeartbeat,
  writeState,
  type RuntimeState,
} from "./state"

export interface EngineAvailability {
  id: string
  displayName: string
  available: boolean
  detail?: string
}

export interface RuntimeStatus {
  running: boolean
  state?: RuntimeState
  health?: EngineHealth
  supervisorPid?: number
  engines: EngineAvailability[]
}

export interface StartRuntimeOptions {
  /** Absolute path to a GGUF file (llama.cpp). */
  modelPath?: string
  /** Model name (ollama) or API alias (llama.cpp). */
  modelName?: string
  /** Vision projector file for VL models. */
  mmprojPath?: string
  /** Port override. */
  port?: number
  /** Engine override; defaults to config.runtime.engine. */
  engineId?: string
  /** The model's trained context window — the origin for YaRN context extension. */
  nativeContextSize?: number
}

const HEARTBEAT_INTERVAL_MS = 5_000

export class RuntimeManager {
  constructor(
    private readonly config: ImurunConfig,
    /** Engine overrides for tests and embedding. */
    private readonly enginesOverride?: Engine[],
  ) {}

  /** Engine instances, in availability-check order. */
  private allEngines(): Engine[] {
    return this.enginesOverride ?? [new LlamaCppEngine(), new OllamaEngine()]
  }

  engine(id: string): Engine {
    for (const engine of this.allEngines()) {
      if (engine.id === id) return engine
    }
    throw new Error(`Unknown engine: ${id}`)
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async status(): Promise<RuntimeStatus> {
    const engines: EngineAvailability[] = []
    for (const engine of this.allEngines()) {
      const availability = await engine.isAvailable()
      engines.push({
        id: engine.id,
        displayName: engine.displayName,
        available: availability.available,
        detail: availability.detail,
      })
    }

    const state = await readState()
    if (!state) return { running: false, engines }

    let health: EngineHealth | undefined
    try {
      health = await this.engine(state.engine).health(state.port)
    } catch (error) {
      health = { healthy: false, detail: (error as Error).message }
    }

    const supervisorPid = await readSupervisorPid()
    return {
      running: health.healthy,
      state,
      health,
      supervisorPid,
      engines,
    }
  }

  /** True when the recorded runtime is actually serving requests. */
  async healthy(): Promise<boolean> {
    const state = await readState()
    if (!state) return false
    try {
      const health = await this.engine(state.engine).health(state.port)
      return health.healthy
    } catch {
      return false
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Starts the runtime if not already running; returns the live state. */
  async start(options: StartRuntimeOptions = {}): Promise<RuntimeState> {
    const existing = await readState()
    if (existing) {
      const health = await this.engine(existing.engine).health(existing.port).catch(() => ({ healthy: false }))
      if (health.healthy) {
        // Refresh the recorded window. A server started before we tracked it (or
        // by another client) can report a different size than the state claims,
        // and the agent budgets its requests against this number.
        let probed: number | undefined
        try {
          probed = await this.engine(existing.engine).contextSize?.(existing.port)
        } catch {
          probed = undefined
        }
        if (probed && probed !== existing.contextSize) {
          const updated: RuntimeState = { ...existing, contextSize: probed, lastUsedAt: Date.now() }
          await writeState(updated)
          return updated
        }
        return existing
      }
      logger.info("found stale runtime state — cleaning up before start")
      await this.cleanup(existing)
    }

    const engineId = options.engineId ?? this.config.runtime.engine
    const engine = this.engine(engineId)

    const availability = await engine.isAvailable()
    if (!availability.available) {
      throw new Error(availability.detail ?? `Engine "${engineId}" is not available on this machine.`)
    }

    if (engine.id === "llama-cpp" && !options.modelPath) {
      throw new Error(
        "No model selected for the local engine. Install one with `imurun models install <id>` (or run with --model-path). " +
          "Using Ollama instead? Set runtime.engine to \"ollama\" in imurun.json.",
      )
    }

    const port = options.port ?? this.config.runtime.port
    const engineOptions: EngineStartOptions = {
      modelPath: options.modelPath,
      modelName: options.modelName,
      mmprojPath: options.mmprojPath,
      port,
      threads: this.config.runtime.threads || undefined,
      gpuLayers: this.config.runtime.gpuLayers,
      contextSize: this.config.runtime.contextSize || undefined,
      ropeScaling: this.config.runtime.ropeScaling,
      ropeScale: this.config.runtime.ropeScale || undefined,
      nativeContextSize: options.nativeContextSize,
      flashAttention: this.config.runtime.flashAttention,
      logFile: join(imurunDir("logs"), "runtime.log"),
    }
    const handle = await engine.start(engineOptions)

    // Record the window that was actually requested so `runtime status` can
    // show it without re-deriving anything.
    const plan = planLlamaContext(engineOptions)

    // The engine is the authority on what it really loaded — it may cap the
    // request to fit memory. Ask it, and budget the agent against that number.
    let loadedContext: number | undefined
    try {
      loadedContext = await engine.contextSize?.(handle.port)
    } catch {
      loadedContext = undefined
    }
    if (loadedContext && plan.contextSize && loadedContext !== plan.contextSize) {
      logger.warn(`engine loaded a ${loadedContext}-token window (asked for ${plan.contextSize})`)
    }
    const contextSize = loadedContext ?? plan.contextSize

    const state: RuntimeState = {
      engine: engine.id,
      port: handle.port,
      pid: handle.pid,
      model: options.modelName ?? (options.modelPath ? basename(options.modelPath).replace(/\.gguf$/i, "") : undefined),
      contextSize: contextSize || undefined,
      ropeScaling: plan.ropeScaling,
      ropeScale: plan.ropeScale,
      nativeContextSize: options.nativeContextSize,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    }
    await writeState(state)
    logger.info(`runtime started: ${engine.id} on port ${handle.port}`)
    return state
  }

  /** Stops the engine (and any detached supervisor) and frees memory. */
  async stop(): Promise<void> {
    const state = await readState()
    const supervisorPid = await readSupervisorPid()

    if (supervisorPid && supervisorPid !== process.pid) {
      await killProcess(supervisorPid)
    }

    if (state) {
      try {
        await this.engine(state.engine).stop({ pid: state.pid ?? 0, port: state.port, model: state.model })
      } catch (error) {
        logger.warn(`engine stop failed: ${(error as Error).message}`)
      }
      await this.cleanup(state)
    } else {
      await clearSupervisorPid()
      await clearHeartbeats()
    }
    logger.info("runtime stopped")
  }

  async restart(options: StartRuntimeOptions = {}): Promise<RuntimeState> {
    await this.stop()
    await sleep(300)
    return this.start(options)
  }

  private async cleanup(state: RuntimeState): Promise<void> {
    // last resort: kill a recorded pid that no longer serves requests
    if (state.pid && isProcessAlive(state.pid)) {
      await killProcess(state.pid)
    }
    await clearState()
    await clearSupervisorPid()
    await clearHeartbeats()
  }

  // ── Supervision ───────────────────────────────────────────────────────────

  /** Runs the supervisor in this process (foreground `runtime start`). */
  async supervise(state: RuntimeState, signal?: AbortSignal): Promise<SupervisorStopReason> {
    const engine = this.engine(state.engine)
    const handle: EngineHandle = {
      pid: state.pid ?? 0,
      port: state.port,
      model: state.model,
      detail: "foreground supervisor",
    }
    const supervisor = new Supervisor({
      engine,
      handle,
      startedAt: state.startedAt,
      staleMs: 15_000,
      graceMs: this.config.runtime.shutdownGraceSeconds * 1000,
      idleUnloadMs: this.config.runtime.idleUnloadMinutes * 60_000,
      // foreground `runtime start` comes up before any session connects
      requireFirstClient: true,
    })
    return supervisor.run(signal)
  }

  /** Spawns a detached supervisor process that outlives this client. */
  async spawnSupervisor(): Promise<number> {
    const existing = await readSupervisorPid()
    if (existing && isProcessAlive(existing)) return existing

    const entry = fileURLToPath(new URL("./supervisor-entry.ts", import.meta.url))
    const proc = Bun.spawn([process.execPath, entry], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        IMURUN_SUPERVISOR_GRACE_MS: String(this.config.runtime.shutdownGraceSeconds * 1000),
        IMURUN_SUPERVISOR_IDLE_MS: String(this.config.runtime.idleUnloadMinutes * 60_000),
      },
    })
    proc.unref()
    logger.debug(`supervisor spawned (pid ${proc.pid})`)
    return proc.pid
  }

  // ── Client heartbeats ─────────────────────────────────────────────────────

  /**
   * Registers this client and keeps its heartbeat fresh. Call the returned
   * function when the client exits — the runtime then stops after the grace
   * period and RAM is released.
   *
   * The interval is referenced (not unref'd) on purpose: an unref'd timer can
   * stop firing once a long-lived client goes quiet, which made the supervisor
   * think the terminal had closed and unload the model mid-conversation.
   * One-shot callers that must not keep the event loop alive pass `unref`.
   */
  async attach(sessionId: string, options: { unref?: boolean } = {}): Promise<() => Promise<void>> {
    await touchHeartbeat(sessionId)
    const timer = setInterval(() => {
      void touchHeartbeat(sessionId).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    if (options.unref && typeof timer.unref === "function") timer.unref()

    return async () => {
      clearInterval(timer)
      await removeHeartbeat(sessionId).catch(() => {})
    }
  }

  /** Records that a request was sent — resets the idle-unload timer. */
  async activity(sessionId: string): Promise<void> {
    await touchActivity(sessionId)
  }
}

export { Supervisor, type SupervisorStopReason } from "./supervisor"

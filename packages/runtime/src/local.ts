/**
 * Local-model session helpers — connect a session to the local runtime.
 *
 * Given a model reference (or nothing at all), these helpers decide which
 * installed model to use, start the runtime with it when needed, and keep the
 * client heartbeat alive while a session runs so the supervisor frees RAM as
 * soon as the client is gone.
 */
import { basename } from "node:path"
import type { ImurunConfig, InstalledModel } from "@imurun/schema"
import { ensureLlamaCppEngine, listInstalled, updateInstalled } from "@imurun/modelmgr"
import { logger } from "@imurun/util"
import { RuntimeManager } from "./manager"

export interface LocalTarget {
  /** Name handed to llama-server as --alias and used in the API ref. */
  modelName: string
  /** GGUF path. */
  path: string
  mmprojPath?: string
  /** Registry id (model-quant) when this target came from the store. */
  installedId?: string
  /** The model's trained context window — the origin for YaRN extension. */
  contextLength?: number
}

export interface LocalResolution {
  /** Set when the request should go through the local runtime. */
  target?: LocalTarget
  /** Model reference for the provider registry ("local/<name>" or the original). */
  modelRef?: string
  /** Set when an explicit local request cannot be fulfilled. */
  error?: string
}

/** Most recently used installed model, else the newest install. */
export function pickDefaultInstalled(installed: InstalledModel[]): InstalledModel | undefined {
  if (installed.length === 0) return undefined
  const used = installed.filter((m) => m.lastUsedAt !== undefined)
  if (used.length > 0) {
    return [...used].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
  }
  return [...installed].sort((a, b) => b.installedAt - a.installedAt)[0]
}

export function findInstalled(installed: InstalledModel[], ref: string): InstalledModel | undefined {
  const lower = ref.toLowerCase()
  return (
    installed.find((m) => m.id.toLowerCase() === lower) ??
    installed.find((m) => m.modelId.toLowerCase() === lower) ??
    installed.find((m) => `${m.modelId}-${m.quant}`.toLowerCase() === lower) ??
    installed.find((m) => m.modelId.toLowerCase().includes(lower))
  )
}

function installedHint(installed: InstalledModel[]): string {
  if (installed.length === 0) return "No local models are installed yet — run `imurun models install qwen2.5-coder-7b`."
  return `Installed models: ${installed.map((m) => m.id).join(", ")}`
}

/**
 * Interprets a model reference for local execution.
 *
 *   undefined                    → the default installed model (if any)
 *   "qwen2.5-coder-7b"           → that installed model
 *   "qwen2.5-coder-7b-Q4_K_M"    → exact registry id
 *   "local/qwen2.5-coder-7b"     → explicit local
 *   "C:\\models\\x.gguf"          → raw file outside the store
 *   "openrouter/qwen/qwen3-32b"  → not local; passed through untouched
 */
export function resolveLocalTarget(ref: string | undefined, installed: InstalledModel[]): LocalResolution {
  if (!ref) {
    const entry = pickDefaultInstalled(installed)
    if (!entry) return {}
    return { target: targetOf(entry), modelRef: `local/${entry.modelId}` }
  }

  if (ref.toLowerCase().endsWith(".gguf")) {
    const modelName = basename(ref).replace(/\.gguf$/i, "")
    return { target: { modelName, path: ref }, modelRef: `local/${modelName}` }
  }

  if (ref.startsWith("local/")) {
    const name = ref.slice("local/".length)
    const entry = findInstalled(installed, name)
    if (!entry) {
      return { error: `No installed model matches "${name}". ${installedHint(installed)}` }
    }
    return { target: targetOf(entry), modelRef: `local/${entry.modelId}` }
  }

  // a bare name that matches an installed model is treated as local
  const entry = findInstalled(installed, ref)
  if (entry) return { target: targetOf(entry), modelRef: `local/${entry.modelId}` }

  return { modelRef: ref }
}

function targetOf(entry: InstalledModel): LocalTarget {
  return {
    modelName: entry.modelId,
    path: entry.path,
    mmprojPath: entry.mmprojPath,
    installedId: entry.id,
    contextLength: entry.contextLength,
  }
}

export interface LocalSession {
  manager: RuntimeManager
  /** True when this call started (or restarted) the engine itself. */
  started: boolean
  /** Call in a finally block — lets the supervisor stop the engine. */
  detach: () => Promise<void>
}

/**
 * Ensures the runtime is serving `target`, then registers a heartbeat for the
 * session. Restarts the runtime when it is serving a different model.
 */
export async function ensureLocalRuntime(
  config: ImurunConfig,
  target: LocalTarget,
  sessionId: string,
  options: { unrefHeartbeat?: boolean } = {},
): Promise<LocalSession> {
  const manager = new RuntimeManager(config)

  // Register the client heartbeat before anything else. If we spawned the
  // supervisor first, it could tick before our heartbeat existed and — for a
  // fast-failing start — conclude no client ever needed the model.
  const detach = await manager.attach(sessionId, { unref: options.unrefHeartbeat })

  try {
    const status = await manager.status()
    let started = true
    if (status.running && status.state) {
      const serving = status.state.model
      if (serving !== target.modelName && serving !== target.installedId) {
        logger.info(`runtime is serving "${serving}", switching to ${target.modelName}`)
        await manager.stop()
      } else {
        // already up and serving this model — don't take ownership of it
        started = false
      }
    }

    try {
      await manager.start({
        modelPath: target.path,
        modelName: target.modelName,
        mmprojPath: target.mmprojPath,
        nativeContextSize: target.contextLength,
      })
    } catch (error) {
      // A prebuilt GPU build can fail to load on an unknown machine (missing
      // driver, unsupported runtime). Re-install the portable CPU build once and
      // retry — the user never has to choose an engine by hand.
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`llama.cpp failed to start (${message}) — reinstalling a portable CPU build and retrying`)
      await manager.stop().catch(() => {})
      const engine = await ensureLlamaCppEngine({ force: true, preferVariant: "cpu", onStatus: (m) => logger.info(m) })
      logger.info(`reinstalled ${engine.version ?? "llama.cpp"} (${engine.variant ?? "cpu"}) at ${engine.binaryPath}`)
      await manager.start({
        modelPath: target.path,
        modelName: target.modelName,
        mmprojPath: target.mmprojPath,
        nativeContextSize: target.contextLength,
      })
    }

    await manager.spawnSupervisor()
    await manager.activity(sessionId)

    // record usage so this becomes the default model next time
    if (target.installedId) {
      try {
        const installed = await listInstalled()
        if (installed.some((m) => m.id === target.installedId)) {
          await updateInstalled(target.modelName, { lastUsedAt: Date.now() })
        }
      } catch {
        // non-fatal
      }
    }

    return { manager, started, detach }
  } catch (error) {
    await detach().catch(() => {})
    throw error
  }
}

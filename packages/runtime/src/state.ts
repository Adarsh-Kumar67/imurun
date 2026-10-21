/**
 * Runtime state — persisted daemon/supervisor state in ~/.imurun/runtime/.
 *
 *   runtime/
 *     state.json             current engine, port, pid, model
 *     supervisor.pid         supervisor process id (if running)
 *     sessions/<id>.hb       heartbeat files touched by active clients
 */
import { readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureDir, imurunDir, readJson, readText, writeJsonAtomic } from "@imurun/util"

export interface RuntimeState {
  engine: "llama-cpp" | "ollama" | string
  port: number
  pid?: number
  model?: string
  /** Original weights for the deep engine (Hugging Face repo or directory). */
  modelRepo?: string
  /** Context window the engine was started with, in tokens. */
  contextSize?: number
  /** RoPE method applied to reach it (\"yarn\" / \"linear\"), when scaling is on. */
  ropeScaling?: string
  /** Context-extension factor relative to the model's trained window. */
  ropeScale?: number
  /** The model's trained window, when known. */
  nativeContextSize?: number
  startedAt: number
  lastUsedAt: number
  supervisorPid?: number
}

/**
 * Human-readable summary of the context window an engine was started with.
 *
 * Returns undefined for installs that predate context tracking, so callers can
 * simply skip the line rather than print a misleading zero.
 */
export function describeContext(state: RuntimeState): { window: string; detail?: string } | undefined {
  if (!state.contextSize || state.contextSize <= 0) return undefined
  const detail: string[] = []
  if (state.nativeContextSize && state.nativeContextSize !== state.contextSize) {
    detail.push(`trained ${state.nativeContextSize.toLocaleString()}`)
  }
  if (state.ropeScaling && state.ropeScaling !== "none") {
    detail.push(state.ropeScale ? `${state.ropeScaling} \u00d7${state.ropeScale}` : state.ropeScaling)
  }
  return {
    window: `${state.contextSize.toLocaleString()} tokens`,
    detail: detail.length > 0 ? detail.join("  \u00b7  ") : undefined,
  }
}

export function runtimeDir(): string {
  return imurunDir("runtime")
}

export function statePath(): string {
  return join(runtimeDir(), "state.json")
}

export function supervisorPidPath(): string {
  return join(runtimeDir(), "supervisor.pid")
}

export function sessionsDir(): string {
  return join(runtimeDir(), "sessions")
}

export async function readState(): Promise<RuntimeState | undefined> {
  return readJson<RuntimeState>(statePath())
}

export async function writeState(state: RuntimeState): Promise<void> {
  await writeJsonAtomic(statePath(), state)
}

export async function clearState(): Promise<void> {
  await rm(statePath(), { force: true })
}

// ── Heartbeats & activity ───────────────────────────────────────────────────

async function heartbeatFile(sessionId: string): Promise<string> {
  await ensureDir(sessionsDir())
  return join(sessionsDir(), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.hb`)
}

async function activityFile(sessionId: string): Promise<string> {
  await ensureDir(sessionsDir())
  return join(sessionsDir(), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.act`)
}

/** Registers or refreshes this client's heartbeat (liveness, every ~5s). */
export async function touchHeartbeat(sessionId: string): Promise<void> {
  const file = await heartbeatFile(sessionId)
  const now = new Date()
  try {
    await utimes(file, now, now)
  } catch {
    await writeFile(file, String(process.pid))
  }
}

/** Marks actual usage (a request was sent) — drives idle-unload decisions. */
export async function touchActivity(sessionId: string): Promise<void> {
  const file = await activityFile(sessionId)
  const now = new Date()
  try {
    await utimes(file, now, now)
  } catch {
    await writeFile(file, String(process.pid))
  }
}

export async function removeHeartbeat(sessionId: string): Promise<void> {
  await rm(await heartbeatFile(sessionId), { force: true })
  await rm(await activityFile(sessionId), { force: true })
}

/** Heartbeats not refreshed within staleMs are considered dead. */
export async function activeHeartbeats(staleMs: number): Promise<string[]> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const now = Date.now()
  const active: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".hb")) continue
    try {
      const info = await stat(join(dir, entry))
      if (now - info.mtimeMs <= staleMs) active.push(entry.replace(/\.hb$/, ""))
    } catch {
      // remove raced
    }
  }
  return active
}

/** Removes heartbeat files older than staleMs. Returns removed ids. */
export async function sweepStaleHeartbeats(staleMs: number): Promise<string[]> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const now = Date.now()
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".hb")) continue
    const full = join(dir, entry)
    try {
      const info = await stat(full)
      if (now - info.mtimeMs > staleMs) {
        const id = entry.replace(/\.hb$/, "")
        await rm(full, { force: true })
        await rm(join(dir, `${id}.act`), { force: true })
        removed.push(id)
      }
    } catch {
      // already gone
    }
  }
  return removed
}

/** Most recent activity timestamp across all clients, or undefined when none. */
export async function newestActivityAt(): Promise<number | undefined> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  let newest: number | undefined
  for (const entry of entries) {
    if (!entry.endsWith(".act")) continue
    try {
      const info = await stat(join(dir, entry))
      if (newest === undefined || info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      // raced
    }
  }
  return newest
}

export async function clearHeartbeats(): Promise<void> {
  await rm(sessionsDir(), { recursive: true, force: true })
}

// ── Supervisor pid ──────────────────────────────────────────────────────────

export async function writeSupervisorPid(pid: number): Promise<void> {
  await ensureDir(runtimeDir())
  await writeFile(supervisorPidPath(), String(pid))
}

export async function readSupervisorPid(): Promise<number | undefined> {
  try {
    const raw = await readText(supervisorPidPath())
    const pid = Number(raw.trim())
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

export async function clearSupervisorPid(): Promise<void> {
  await rm(supervisorPidPath(), { force: true })
}

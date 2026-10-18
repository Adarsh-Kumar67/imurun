/**
 * Supervisor — keeps a local model running while clients need it, then frees
 * every byte of RAM when they are gone.
 *
 * Rules (checked every few seconds):
 *   1. Clients-gone  — once at least one client has connected, if no fresh
 *      heartbeat exists for graceMs, the engine is stopped and the supervisor
 *      exits. This is what makes closing the terminal release RAM.
 *   2. Idle-unload   — with no request activity for idleUnloadMs (default
 *      10 min), the model is unloaded even if a client is still open.
 *   3. Unhealthy     — if the engine process died, clean up state and exit.
 *
 * Runs in-process for `imurun runtime start` (foreground) or inside the
 * detached supervisor process for background sessions.
 */
import { logger, sleep, type Logger } from "@imurun/util"
import type { Engine, EngineHandle } from "./engines/base"
import {
  activeHeartbeats,
  clearHeartbeats,
  clearState,
  clearSupervisorPid,
  newestActivityAt,
  sweepStaleHeartbeats,
  writeSupervisorPid,
} from "./state"

export interface SupervisorOptions {
  engine: Engine
  handle: EngineHandle
  /** When the engine was started — idle baseline before any activity exists. */
  startedAt: number
  /** Heartbeat freshness window. Default 15s (clients beat every 5s). */
  staleMs?: number
  /** Extra time after the last client leaves before shutting down. Default 30s. */
  graceMs?: number
  /** Unload after this much request inactivity. 0 disables. Default 10 min. */
  idleUnloadMs?: number
  /** Poll interval. Default 3s. */
  tickMs?: number
  /**
   * When true the supervisor waits for a first client before it is allowed to
   * shut down on "clients-gone" (used by foreground `runtime start`, which is
   * started before any session connects). Background supervisors leave this
   * false so a client that never attaches cannot leak the model.
   */
  requireFirstClient?: boolean
  log?: Logger
}

export type SupervisorStopReason = "clients-gone" | "idle-unload" | "unhealthy" | "aborted"

export class Supervisor {
  private readonly log: Logger
  private readonly staleMs: number
  private readonly graceMs: number
  private readonly idleUnloadMs: number
  private readonly tickMs: number
  private readonly requireFirstClient: boolean

  constructor(private readonly options: SupervisorOptions) {
    this.log = options.log ?? logger.child("supervisor")
    this.staleMs = options.staleMs ?? 15_000
    this.graceMs = options.graceMs ?? 30_000
    this.idleUnloadMs = options.idleUnloadMs ?? 10 * 60_000
    this.tickMs = options.tickMs ?? 3_000
    this.requireFirstClient = options.requireFirstClient ?? false
  }

  async run(externalSignal?: AbortSignal): Promise<SupervisorStopReason> {
    const { engine, handle, startedAt } = this.options

    await writeSupervisorPid(process.pid)
    this.log.info(
      `supervising ${engine.id} on port ${handle.port} ` +
        `(stale ${this.staleMs}ms, grace ${this.graceMs}ms, idle ${this.idleUnloadMs}ms)`,
    )

    const controller = new AbortController()
    const abort = () => controller.abort()
    externalSignal?.addEventListener("abort", abort, { once: true })
    process.on("SIGINT", abort)
    process.on("SIGTERM", abort)

    let lastAliveAt = Date.now()
    let hasSeenClient = false
    let reason: SupervisorStopReason = "aborted"
    let tick = 0

    try {
      while (!controller.signal.aborted) {
        await sleep(this.tickMs)
        if (controller.signal.aborted) break
        tick++
        const now = Date.now()

        const swept = await sweepStaleHeartbeats(this.staleMs)
        if (swept.length > 0) this.log.debug(`swept ${swept.length} stale client(s): ${swept.join(", ")}`)

        // rule 1: clients-gone. The clock starts when the supervisor starts, so
        // a client that dies before it is ever observed still frees the model.
        const active = await activeHeartbeats(this.staleMs)
        if (active.length > 0) {
          if (!hasSeenClient) this.log.debug(`client connected: ${active.join(", ")}`)
          hasSeenClient = true
          lastAliveAt = now
        } else if ((hasSeenClient || !this.requireFirstClient) && now - lastAliveAt > this.graceMs) {
          reason = "clients-gone"
          this.log.info("no active clients — shutting down to free memory")
          break
        }

        // rule 2: idle-unload
        if (this.idleUnloadMs > 0) {
          const newestActivity = await newestActivityAt()
          const baseline = newestActivity ?? startedAt
          if (now - baseline > this.idleUnloadMs) {
            reason = "idle-unload"
            this.log.info(`idle for ${Math.round(this.idleUnloadMs / 60_000)} min — unloading model`)
            break
          }
        }

        // rule 3: engine health (every ~15s)
        if (tick % 5 === 0) {
          const health = await engine.health(handle.port)
          if (!health.healthy) {
            reason = "unhealthy"
            this.log.warn(`engine unhealthy: ${health.detail ?? "no detail"} — cleaning up`)
            break
          }
        }
      }
      if (controller.signal.aborted) reason = "aborted"
    } finally {
      process.off("SIGINT", abort)
      process.off("SIGTERM", abort)
      externalSignal?.removeEventListener("abort", abort)

      this.log.info(`stopping engine (${reason})`)
      try {
        await engine.stop(handle)
      } catch (error) {
        this.log.warn(`engine stop failed: ${(error as Error).message}`)
      }
      await clearState()
      await clearSupervisorPid()
      await clearHeartbeats()
    }

    return reason
  }
}

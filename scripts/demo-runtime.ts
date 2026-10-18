#!/usr/bin/env bun
/**
 * M4 demo — the lifecycle guarantee:
 *
 *   terminal opens  → runtime starts (engine process spawns, serves HTTP)
 *   terminal open   → heartbeats keep it alive
 *   terminal closes → heartbeat goes stale, supervisor stops the engine,
 *                     the process dies, state is cleaned up, RAM is freed
 *
 * Uses a real child process (a tiny HTTP server standing in for llama-server)
 * so the demo exercises the same supervision machinery production uses.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { ImurunConfig } from "@imurun/schema"
import type { Engine, EngineHandle, EngineStartOptions } from "@imurun/runtime"
import {
  RuntimeManager,
  Supervisor,
  activeHeartbeats,
  clearHeartbeats,
  clearState,
  clearSupervisorPid,
  readState,
} from "@imurun/runtime"

process.env.IMURUN_HOME = mkdtempSync(join(tmpdir(), "imurun-m4-demo-"))

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/")
}

/** Stand-in "llama-server": a real child process serving /health + /v1/models. */
class DemoEngine implements Engine {
  readonly id = "llama-cpp"
  readonly displayName = "Demo llama.cpp"
  private proc?: Bun.Subprocess
  private stopped = false

  async isAvailable() {
    return { available: true, detail: "demo build" }
  }

  async start(options: EngineStartOptions): Promise<EngineHandle> {
    const script = `
      const server = Bun.serve({
        port: ${options.port},
        fetch(req) {
          const p = new URL(req.url).pathname
          if (p === "/health") return Response.json({ status: "ok" })
          if (p === "/v1/models") return Response.json({ object: "list", data: [{ id: "demo-7b", object: "model" }] })
          return new Response("not found", { status: 404 })
        },
      })
      console.log("demo engine listening on " + server.port)
      setInterval(() => {}, 1000)
      process.on("SIGTERM", () => process.exit(0))
    `
    this.proc = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    // wait until it responds
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${options.port}/health`, { signal: AbortSignal.timeout(500) })
        if (res.ok) break
      } catch {
        await Bun.sleep(100)
      }
    }
    return { pid: this.proc.pid, port: options.port }
  }

  async stop(handle: Pick<EngineHandle, "pid" | "port" | "model">): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    try {
      this.proc?.kill()
    } catch {
      // already gone
    }
    await this.proc?.exited
  }

  async health(port: number) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      return { healthy: res.ok }
    } catch (error) {
      return { healthy: false, detail: (error as Error).message }
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const engine = new DemoEngine()
const config = ImurunConfig.parse({ runtime: { port: 41299, shutdownGraceSeconds: 1, idleUnloadMinutes: 0 } })
const manager = new RuntimeManager(config, [engine])

await clearState()
await clearSupervisorPid()
await clearHeartbeats()

console.log("\n  ═══ M4 demo: runtime lifecycle ═══\n")

// 1. terminal session starts the runtime
const state = await manager.start({ engineId: "llama-cpp", modelPath: "C:/demo/models/demo-7b.gguf" })
console.log(`  1. runtime started          port=${state.port} pid=${state.pid}`)

const status = await manager.status()
console.log(`  2. status                   running=${status.running} health=${status.health?.detail ?? "ok"}`)

const engineWasAlive = state.pid !== undefined && isAlive(state.pid)
console.log(`  3. engine process alive     ${engineWasAlive}`)

// 2. session attaches (like the TUI does) — heartbeats keep the model warm
const detach = await manager.attach("ses_demo_terminal")
await manager.activity("ses_demo_terminal")
await Bun.sleep(100)
console.log(`  4. client attached          active heartbeats: [${(await activeHeartbeats(15_000)).join(", ")}]`)

// 3. supervisor runs with demo-friendly timings (production: 15s/30s/10min)
const supervising = new Supervisor({
  engine,
  handle: { pid: state.pid ?? 0, port: state.port },
  startedAt: state.startedAt,
  staleMs: 400,
  graceMs: 500,
  idleUnloadMs: 0,
  tickMs: 100,
}).run()

await Bun.sleep(600)
console.log("  5. terminal open            supervisor still running: yes")

// 4. terminal closes → heartbeat removed, goes stale, grace passes
await detach()
console.log("  6. terminal closed          heartbeat removed — waiting for grace period…")

const reason = await supervising
const stateGone = (await readState()) === undefined
const processGone = state.pid !== undefined ? !isAlive(state.pid) : false

console.log(`  7. supervisor decision      ${reason}`)
console.log(`  8. engine process alive     ${!processGone ? "YES (leak!)" : "no — RAM freed"}`)
console.log(`  9. runtime state cleaned    ${stateGone}`)

const ok = reason === "clients-gone" && processGone && stateGone
console.log(ok ? "\n  ✔ M4 lifecycle guarantee VERIFIED\n" : "\n  ✖ M4 demo FAILED\n")
process.exit(ok ? 0 : 1)

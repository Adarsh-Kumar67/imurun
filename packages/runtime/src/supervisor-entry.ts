#!/usr/bin/env bun
/**
 * Detached supervisor process — spawned by RuntimeManager.start() when the
 * runtime is used in background mode. Watches client heartbeats and request
 * activity, stops the engine when they are gone, then exits.
 *
 * Pure process: no imports from the CLI. Reads state from disk.
 */
import type { Engine } from "./engines/base"
import { LlamaCppEngine } from "./engines/llama-cpp"
import { OllamaEngine } from "./engines/ollama"
import { readState } from "./state"
import { Supervisor } from "./supervisor"

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const state = await readState()
if (!state) {
  console.error("supervisor: no runtime state found — nothing to supervise")
  process.exit(1)
}

const engine: Engine = state.engine === "ollama" ? new OllamaEngine() : new LlamaCppEngine()

const supervisor = new Supervisor({
  engine,
  handle: { pid: state.pid ?? 0, port: state.port, model: state.model, detail: "detached supervisor" },
  startedAt: state.startedAt,
  staleMs: num(process.env.IMURUN_SUPERVISOR_STALE_MS, 15_000),
  graceMs: num(process.env.IMURUN_SUPERVISOR_GRACE_MS, 30_000),
  idleUnloadMs: num(process.env.IMURUN_SUPERVISOR_IDLE_MS, 10 * 60_000),
})

await supervisor.run()
process.exit(0)

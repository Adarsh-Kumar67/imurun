import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImurunConfig } from "@imurun/schema"
import type { Engine, EngineHandle, EngineStartOptions } from "../src/engines/base"
import {
  RuntimeManager,
  Supervisor,
  activeHeartbeats,
  clearHeartbeats,
  clearState,
  clearSupervisorPid,
  newestActivityAt,
  readState,
  readSupervisorPid,
  removeHeartbeat,
  sweepStaleHeartbeats,
  touchActivity,
  touchHeartbeat,
  writeState,
  describeContext,
} from "../src"

/** A pid that is certainly not alive — never kill the test runner. */
const DEAD_PID = 999_999

class FakeEngine implements Engine {
  readonly id = "fake"
  readonly displayName = "Fake Engine"
  startCalls: EngineStartOptions[] = []
  stopCalls: Array<{ handle: unknown; options: unknown }> = []
  healthy = true

  async isAvailable() {
    return { available: true, detail: "always" }
  }

  async start(options: EngineStartOptions): Promise<EngineHandle> {
    this.startCalls.push(options)
    return { pid: DEAD_PID, port: options.port, model: options.modelName, detail: "fake engine" }
  }

  async stop(handle: unknown, options?: unknown): Promise<void> {
    this.stopCalls.push({ handle, options })
  }

  async health() {
    return { healthy: this.healthy }
  }
}

function testConfig(): ImurunConfig {
  return ImurunConfig.parse({ runtime: { port: 41234 } })
}

beforeEach(async () => {
  process.env.IMURUN_HOME = mkdtempSync(join(tmpdir(), "imurun-rt-"))
  await clearState()
  await clearSupervisorPid()
  await clearHeartbeats()
})

describe("runtime state", () => {
  test("state round-trips through disk", async () => {
    const state = { engine: "fake", port: 1234, pid: DEAD_PID, startedAt: 1, lastUsedAt: 2 }
    await writeState(state)
    const loaded = await readState()
    expect(loaded).toEqual(state)
  })

  test("heartbeats are fresh, sweepable, and removable", async () => {
    await touchHeartbeat("ses_a")
    await touchHeartbeat("ses_b")
    expect((await activeHeartbeats(10_000)).sort()).toEqual(["ses_a", "ses_b"])

    // simulate a crashed client: age the heartbeat far into the past
    const stale = join(process.env.IMURUN_HOME!, "runtime", "sessions", "ses_a.hb")
    const past = new Date(Date.now() - 60_000)
    const { utimes } = await import("node:fs/promises")
    await utimes(stale, past, past)

    const swept = await sweepStaleHeartbeats(10_000)
    expect(swept).toEqual(["ses_a"])
    expect(await activeHeartbeats(10_000)).toEqual(["ses_b"])

    await removeHeartbeat("ses_b")
    expect(await activeHeartbeats(10_000)).toEqual([])
  })

  test("activity timestamps track the newest request", async () => {
    expect(await newestActivityAt()).toBeUndefined()
    await touchActivity("ses_a")
    const first = await newestActivityAt()
    expect(first).toBeGreaterThan(0)
    await touchActivity("ses_b")
    const second = await newestActivityAt()
    expect(second).toBeGreaterThanOrEqual(first!)
  })

  test("sweeping stale heartbeats also removes their activity files", async () => {
    await touchHeartbeat("ses_x")
    await touchActivity("ses_x")
    const { utimes } = await import("node:fs/promises")
    const dir = join(process.env.IMURUN_HOME!, "runtime", "sessions")
    const past = new Date(Date.now() - 60_000)
    await utimes(join(dir, "ses_x.hb"), past, past)
    await utimes(join(dir, "ses_x.act"), past, past)
    await sweepStaleHeartbeats(10_000)
    expect(await newestActivityAt()).toBeUndefined()
  })

  test("supervisor pid file round-trips", async () => {
    const { writeSupervisorPid } = await import("../src/state")
    await writeSupervisorPid(4242)
    expect(await readSupervisorPid()).toBe(4242)
    await clearSupervisorPid()
    expect(await readSupervisorPid()).toBeUndefined()
  })
})

describe("supervisor", () => {
  test("stops the engine once all clients disconnect (terminal closed)", async () => {
    const engine = new FakeEngine()
    const supervisor = new Supervisor({
      engine,
      handle: { pid: DEAD_PID, port: 1234 },
      startedAt: Date.now(),
      staleMs: 250,
      graceMs: 250,
      idleUnloadMs: 0, // disabled for this test
      tickMs: 60,
    })

    const running = supervisor.run()
    // a client connects...
    await touchHeartbeat("ses_client")
    await Bun.sleep(350) // heartbeat goes stale, grace period passes

    const reason = await running
    expect(reason).toBe("clients-gone")
    expect(engine.stopCalls).toHaveLength(1)
    expect(await readState()).toBeUndefined()
    expect(await readSupervisorPid()).toBeUndefined()
  })

  test("stays alive while a client keeps heartbeating, then stops after disconnect", async () => {
    const engine = new FakeEngine()
    const supervisor = new Supervisor({
      engine,
      handle: { pid: DEAD_PID, port: 1234 },
      startedAt: Date.now(),
      staleMs: 250,
      graceMs: 250,
      idleUnloadMs: 0,
      tickMs: 60,
    })

    const running = supervisor.run()
    const beat = setInterval(() => void touchHeartbeat("ses_alive"), 80)
    await Bun.sleep(700)

    // still alive after 700ms of heartbeats — engine not stopped
    expect(engine.stopCalls).toHaveLength(0)

    clearInterval(beat)
    const reason = await running
    expect(reason).toBe("clients-gone")
    expect(engine.stopCalls).toHaveLength(1)
  })

  test("unloads idle models even when clients are connected", async () => {
    const engine = new FakeEngine()
    const supervisor = new Supervisor({
      engine,
      handle: { pid: DEAD_PID, port: 1234 },
      startedAt: Date.now(),
      staleMs: 60_000, // heartbeats never go stale here
      graceMs: 60_000,
      idleUnloadMs: 400,
      tickMs: 60,
    })

    const beat = setInterval(() => void touchHeartbeat("ses_idle"), 80)
    const reason = await supervisor.run()
    clearInterval(beat)

    expect(reason).toBe("idle-unload")
    expect(engine.stopCalls).toHaveLength(1)
  })

  test("activity resets the idle timer", async () => {
    const engine = new FakeEngine()
    const supervisor = new Supervisor({
      engine,
      handle: { pid: DEAD_PID, port: 1234 },
      startedAt: Date.now(),
      staleMs: 60_000,
      graceMs: 60_000,
      idleUnloadMs: 800,
      tickMs: 60,
    })

    const controller = new AbortController()
    const running = supervisor.run(controller.signal)

    const beat = setInterval(() => void touchHeartbeat("ses_active"), 80)
    const act = setInterval(() => void touchActivity("ses_active"), 120)

    // keep activity flowing well past the idle window
    await Bun.sleep(1_500)
    expect(engine.stopCalls).toHaveLength(0) // still alive because of fresh activity

    clearInterval(beat)
    clearInterval(act)
    controller.abort()

    const reason = await running
    expect(reason).toBe("aborted")
    expect(engine.stopCalls).toHaveLength(1)
  }, 8_000)

  test("abort signal stops the engine immediately", async () => {
    const engine = new FakeEngine()
    const supervisor = new Supervisor({
      engine,
      handle: { pid: DEAD_PID, port: 1234 },
      startedAt: Date.now(),
      idleUnloadMs: 0,
      tickMs: 60,
    })

    const controller = new AbortController()
    const running = supervisor.run(controller.signal)
    await Bun.sleep(150)
    controller.abort()

    const reason = await running
    expect(reason).toBe("aborted")
    expect(engine.stopCalls).toHaveLength(1)
    expect(await readState()).toBeUndefined()
  })

  test("unhealthy engine triggers cleanup", async () => {
    const engine = new FakeEngine()
    engine.healthy = false
    const supervisor = new Supervisor({
      engine,
      handle: { pid: DEAD_PID, port: 1234 },
      startedAt: Date.now(),
      staleMs: 60_000,
      graceMs: 60_000,
      idleUnloadMs: 0,
      tickMs: 60,
    })

    const reason = await supervisor.run()
    expect(reason).toBe("unhealthy")
    expect(engine.stopCalls).toHaveLength(1)
  })
})

describe("runtime manager", () => {
  test("start writes state, status reports running, stop cleans up", async () => {
    const engine = new FakeEngine()
    const manager = new RuntimeManager(testConfig(), [engine])

    const state = await manager.start({ engineId: "fake", modelName: "test-model" })
    expect(state.engine).toBe("fake")
    expect(state.port).toBe(41234)
    expect(state.model).toBe("test-model")

    const status = await manager.status()
    expect(status.running).toBe(true)
    expect(status.state?.engine).toBe("fake")
    expect(status.engines[0]!.id).toBe("fake")

    await manager.stop()
    expect(engine.stopCalls).toHaveLength(1)
    expect(await readState()).toBeUndefined()
    expect((await manager.status()).running).toBe(false)
  })

  test("start is idempotent while the engine is healthy", async () => {
    const engine = new FakeEngine()
    const manager = new RuntimeManager(testConfig(), [engine])

    await manager.start({ engineId: "fake", modelName: "m1" })
    await manager.start({ engineId: "fake", modelName: "m1" })
    expect(engine.startCalls).toHaveLength(1)
    await manager.stop()
  })

  test("stale state is cleaned before a fresh start", async () => {
    const engine = new FakeEngine()
    const manager = new RuntimeManager(testConfig(), [engine])
    await writeState({ engine: "fake", port: 1, pid: DEAD_PID, startedAt: 0, lastUsedAt: 0 })
    engine.healthy = false // the recorded runtime is dead
    const state = await manager.start({ engineId: "fake", modelName: "m2" })
    expect(state.model).toBe("m2")
    expect(engine.startCalls).toHaveLength(1)
    await manager.stop()
  })

  test("llama-cpp start without a model path explains what to do", async () => {
    // use the real engine mapping but with a config whose engine is llama-cpp
    const manager = new RuntimeManager(testConfig(), [
      {
        id: "llama-cpp",
        displayName: "test llama",
        isAvailable: async () => ({ available: true }),
        start: async () => ({ pid: DEAD_PID, port: 1 }),
        stop: async () => {},
        health: async () => ({ healthy: false }),
      },
    ])
    await expect(manager.start({ engineId: "llama-cpp" })).rejects.toThrow(/models install/)
  })

  test("attach keeps a heartbeat alive and removes it on detach", async () => {
    const manager = new RuntimeManager(testConfig(), [new FakeEngine()])
    const detach = await manager.attach("ses_tui")
    expect(await activeHeartbeats(10_000)).toContain("ses_tui")

    await manager.activity("ses_tui")
    expect(await newestActivityAt()).toBeGreaterThan(0)

    await detach()
    expect(await activeHeartbeats(10_000)).not.toContain("ses_tui")
  })
})

describe("describeContext", () => {
  test("is undefined for installs without context tracking", () => {
    expect(describeContext({ engine: "llama-cpp", port: 1, startedAt: 0, lastUsedAt: 0 })).toBeUndefined()
    expect(
      describeContext({ engine: "llama-cpp", port: 1, contextSize: 0, startedAt: 0, lastUsedAt: 0 }),
    ).toBeUndefined()
  })

  test("reports the window, and YaRN only when it extends the trained one", () => {
    const plain = describeContext({
      engine: "llama-cpp",
      port: 1,
      contextSize: 32768,
      nativeContextSize: 32768,
      startedAt: 0,
      lastUsedAt: 0,
    })
    expect(plain?.window).toBe("32,768 tokens")
    expect(plain?.detail).toBeUndefined()

    const yarn = describeContext({
      engine: "llama-cpp",
      port: 1,
      contextSize: 65536,
      nativeContextSize: 32768,
      ropeScaling: "yarn",
      ropeScale: 2,
      startedAt: 0,
      lastUsedAt: 0,
    })
    expect(yarn?.window).toBe("65,536 tokens")
    expect(yarn?.detail).toContain("trained 32,768")
    expect(yarn?.detail).toContain("yarn \u00d72")
  })

  test("ignores an explicit 'none' scaling", () => {
    const scaled = describeContext({
      engine: "llama-cpp",
      port: 1,
      contextSize: 8192,
      nativeContextSize: 8192,
      ropeScaling: "none",
      startedAt: 0,
      lastUsedAt: 0,
    })
    expect(scaled?.detail).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import {
  ImurunConfig,
  HardwareProfile,
  MemoryEntry,
  ModelInfo,
  Session,
  computeTier,
  scoreHardware,
} from "@imurun/schema"

describe("config schema", () => {
  test("empty config gets all defaults", () => {
    const config = ImurunConfig.parse({})
    expect(config.runtime.engine).toBe("llama-cpp")
    expect(config.runtime.port).toBe(42425)
    expect(config.rag.enabled).toBe(true)
    expect(config.memory.learnStyle).toBe(true)
    expect(config.permissions).toEqual([])
  })

  test("partial config merges over defaults", () => {
    const config = ImurunConfig.parse({
      model: "qwen2.5-coder-7b",
      runtime: { port: 50000 },
      rag: { watch: false },
    })
    expect(config.model).toBe("qwen2.5-coder-7b")
    expect(config.runtime.port).toBe(50000)
    expect(config.runtime.engine).toBe("llama-cpp")
    expect(config.rag.watch).toBe(false)
    expect(config.rag.autoInject).toBe(true)
  })

  test("rejects invalid port", () => {
    expect(() => ImurunConfig.parse({ runtime: { port: 99 } })).toThrow()
  })
})

describe("model schema", () => {
  test("parses a full model descriptor", () => {
    const model = ModelInfo.parse({
      id: "qwen2.5-coder-7b",
      displayName: "Qwen2.5 Coder 7B",
      family: "qwen",
      paramsB: 7,
      description: "Strong coding model that runs on mid-range hardware.",
      quantizations: [
        { type: "Q4_K_M", sizeGB: 4.7, huggingface: { repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF", file: "qwen2.5-coder-7b-instruct-q4_k_m.gguf" } },
      ],
      capabilities: { contextLength: 32768, toolCalling: true, vision: false, coding: 82, reasoning: 74, speed: 40 },
      minHardware: { tier: "low", ramMB: 8192, vramMB: 6144 },
      tags: ["coding", "recommended"],
      license: "apache-2.0",
    })
    expect(model.capabilities.toolCalling).toBe(true)
    expect(model.tags).toContain("coding")
  })

  test("requires at least one quantization", () => {
    expect(() =>
      ModelInfo.parse({
        id: "x",
        displayName: "X",
        family: "x",
        paramsB: 1,
        quantizations: [],
        capabilities: { contextLength: 4096, toolCalling: false, vision: false, coding: 1, reasoning: 1, speed: 1 },
        minHardware: { tier: "minimal", ramMB: 1 },
        license: "mit",
      }),
    ).toThrow()
  })
})

describe("hardware scoring", () => {
  test("strong machine lands in high/extreme tier", () => {
    const score = scoreHardware({
      ram: { totalMB: 65_536 },
      cpu: { cores: 16 },
      gpu: [{ vramMB: 24_576, unified: false, usable: true }],
    })
    expect(score).toBeGreaterThanOrEqual(65)
  })

  test("modest laptop lands in low/mid tier", () => {
    const score = scoreHardware({
      ram: { totalMB: 16_384 },
      cpu: { cores: 8 },
      gpu: [],
    })
    expect(score).toBeGreaterThanOrEqual(20)
    expect(score).toBeLessThan(65)
  })

  test("computeTier thresholds", () => {
    expect(computeTier(10)).toBe("minimal")
    expect(computeTier(25)).toBe("low")
    expect(computeTier(50)).toBe("mid")
    expect(computeTier(70)).toBe("high")
    expect(computeTier(95)).toBe("extreme")
  })

  test("hardware profile round-trips", () => {
    const profile = HardwareProfile.parse({
      os: "windows",
      arch: "x64",
      cpu: { name: "Test CPU", cores: 8, threads: 16 },
      ram: { totalMB: 32_768, availableMB: 16_384 },
      gpu: [],
      disk: { freeGB: 256, path: "C:\\" },
      tier: "mid",
      score: 55,
      detectedAt: Date.now(),
    })
    expect(profile.gpu).toEqual([])
    expect(profile.cpu.threads).toBe(16)
  })
})

describe("memory and session schemas", () => {
  test("memory entry defaults", () => {
    const entry = MemoryEntry.parse({
      id: "mem_1",
      kind: "credential",
      key: "github_token",
      value: "encrypted-blob",
      encrypted: true,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(entry.scope).toBe("global")
    expect(entry.confidence).toBe(1)
  })

  test("session defaults", () => {
    const session = Session.parse({
      id: "ses_1",
      title: "Fix login bug",
      createdAt: 0,
      updatedAt: 0,
      workingDir: "C:\\project",
    })
    expect(session.topics).toEqual([])
    expect(session.messageCount).toBe(0)
  })
})

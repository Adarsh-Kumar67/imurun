import { describe, expect, test } from "bun:test"
import { AUTO_CONTEXT_CAP, buildLlamaServerArgs, planLlamaContext } from "../src/engines/llama-cpp"
import type { EngineStartOptions } from "../src/engines/base"

function args(options: Partial<EngineStartOptions> = {}): string[] {
  return buildLlamaServerArgs(
    { modelPath: "C:/models/qwen.gguf", port: 42425, ...options },
    { threads: 8 },
  )
}

function valueAfter(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag)
  return index === -1 ? undefined : command[index + 1]
}

describe("planLlamaContext", () => {
  test("falls back to the cap rather than llama.cpp's 4096 default", () => {
    // With nothing known, llama.cpp would load a 4096-token window and refuse
    // ordinary requests. Pass the cap explicitly instead.
    const plan = planLlamaContext({})
    expect(plan.contextSize).toBe(AUTO_CONTEXT_CAP)
    expect(plan.ropeScaling).toBeUndefined()
  })

  test("uses the model's own window, capped", () => {
    expect(planLlamaContext({ nativeContextSize: 32768 }).contextSize).toBe(32768)
    expect(planLlamaContext({ nativeContextSize: 131072 }).contextSize).toBe(AUTO_CONTEXT_CAP)
    expect(planLlamaContext({ nativeContextSize: 4096 }).ropeScaling).toBeUndefined()
  })

  test("an explicit size always wins", () => {
    expect(planLlamaContext({ contextSize: 2048, nativeContextSize: 32768 }).contextSize).toBe(2048)
    expect(planLlamaContext({ contextSize: 2048, nativeContextSize: 32768 }).ropeScaling).toBeUndefined()
  })

  test("switches on YaRN only when the request exceeds the trained window", () => {
    // within the trained window → no scaling
    expect(planLlamaContext({ contextSize: 32768, nativeContextSize: 32768 }).ropeScaling).toBeUndefined()

    // 2× the trained window → YaRN at factor 2
    const plan = planLlamaContext({ contextSize: 65536, nativeContextSize: 32768 })
    expect(plan.ropeScaling).toBe("yarn")
    expect(plan.ropeScale).toBe(2)
    expect(plan.yarnOrigContext).toBe(32768)

    // 4× → factor 4
    expect(planLlamaContext({ contextSize: 131072, nativeContextSize: 32768 }).ropeScale).toBe(4)
  })

  test("respects ropeScaling: none", () => {
    const plan = planLlamaContext({ contextSize: 65536, nativeContextSize: 32768, ropeScaling: "none" })
    expect(plan.contextSize).toBe(65536)
    expect(plan.ropeScaling).toBeUndefined()
  })

  test("honours an explicit factor", () => {
    const plan = planLlamaContext({ contextSize: 65536, nativeContextSize: 32768, ropeScale: 8 })
    expect(plan.ropeScale).toBe(8)
  })

  test("linear scaling omits the YaRN origin", () => {
    const plan = planLlamaContext({ contextSize: 65536, nativeContextSize: 32768, ropeScaling: "linear" })
    expect(plan.ropeScaling).toBe("linear")
    expect(plan.yarnOrigContext).toBeUndefined()
  })
})

describe("buildLlamaServerArgs", () => {
  test("passes the tuned baseline flags", () => {
    const command = args()
    expect(valueAfter(command, "--model")).toBe("C:/models/qwen.gguf")
    expect(valueAfter(command, "--port")).toBe("42425")
    expect(valueAfter(command, "--host")).toBe("127.0.0.1")
    expect(valueAfter(command, "--threads")).toBe("8")
    expect(valueAfter(command, "--flash-attn")).toBe("auto")
    expect(valueAfter(command, "--log-colors")).toBe("off")
    expect(command).toContain("--jinja")
  })

  test("always passes an explicit --ctx-size, even when the window is unknown", () => {
    // Never leave it to llama.cpp: its default is 4096, which truncates a
    // normal conversation and surfaces as a hard "context exceeded" error.
    expect(valueAfter(args(), "--ctx-size")).toBe(String(AUTO_CONTEXT_CAP))
  })

  test("never shrinks the window below the model's own", () => {
    expect(valueAfter(args({ nativeContextSize: 32768 }), "--ctx-size")).toBe("32768")
  })

  test("emits the YaRN flags when extending the window", () => {
    const command = args({ contextSize: 65536, nativeContextSize: 32768 })
    expect(valueAfter(command, "--ctx-size")).toBe("65536")
    expect(valueAfter(command, "--rope-scaling")).toBe("yarn")
    expect(valueAfter(command, "--rope-scale")).toBe("2.000")
    expect(valueAfter(command, "--yarn-orig-ctx")).toBe("32768")
  })

  test("does not emit rope flags when they are not needed", () => {
    const command = args({ nativeContextSize: 8192 })
    expect(command).not.toContain("--rope-scaling")
    expect(command).not.toContain("--yarn-orig-ctx")
  })

  test("applies the alias, mmproj and GPU layer flags", () => {
    const command = args({ modelName: "qwen2.5-coder-7b", mmprojPath: "C:/models/mmproj.gguf", gpuLayers: 20 })
    expect(valueAfter(command, "--alias")).toBe("qwen2.5-coder-7b")
    expect(valueAfter(command, "--mmproj")).toBe("C:/models/mmproj.gguf")
    expect(valueAfter(command, "--n-gpu-layers")).toBe("20")
  })

  test("CPU-only mode disables the device", () => {
    const command = args({ gpuLayers: 0 })
    expect(valueAfter(command, "--device")).toBe("none")
    expect(valueAfter(command, "--n-gpu-layers")).toBe("0")
  })

  test("auto GPU mode leaves the layer count to llama.cpp", () => {
    expect(args({ gpuLayers: -1 })).not.toContain("--n-gpu-layers")
  })

  test("requires a model path", () => {
    expect(() => buildLlamaServerArgs({ port: 1 }, { threads: 4 })).toThrow(/modelPath/)
  })
})

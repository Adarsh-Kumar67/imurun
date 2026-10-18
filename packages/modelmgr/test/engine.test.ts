import { describe, expect, test } from "bun:test"
import type { GpuInfo, HardwareProfile } from "@imurun/schema"
import { preferredEngineVariants } from "../src"

function profile(os: HardwareProfile["os"], gpu: GpuInfo[]): HardwareProfile {
  return {
    os,
    arch: "x64",
    cpu: { name: "test cpu", cores: 8, threads: 16, flags: [] },
    ram: { totalMB: 16384, availableMB: 8192 },
    gpu,
    disk: { freeGB: 100, path: "/tmp" },
    tier: "mid",
    score: 50,
    detectedAt: 0,
  }
}

const nvidia: GpuInfo = { vendor: "nvidia", name: "RTX", vramMB: 8192, unified: false, usable: true }
const amd: GpuInfo = { vendor: "amd", name: "RX", vramMB: 8192, unified: false, usable: true }
const intel: GpuInfo = { vendor: "intel", name: "iGPU", vramMB: 0, unified: true, usable: true }
const unusable: GpuInfo = { vendor: "unknown", name: "?", vramMB: 0, unified: false, usable: false }

describe("engine variant preference", () => {
  test("windows + nvidia leads with vulkan (small download), cuda second, cpu last", () => {
    expect(preferredEngineVariants(profile("windows", [nvidia]))).toEqual(["vulkan", "cuda", "cpu"])
  })

  test("windows + amd/intel use vulkan with a cpu fallback", () => {
    expect(preferredEngineVariants(profile("windows", [amd]))).toEqual(["vulkan", "cpu"])
    expect(preferredEngineVariants(profile("windows", [intel]))).toEqual(["vulkan", "cpu"])
  })

  test("cpu-only windows stays on cpu", () => {
    expect(preferredEngineVariants(profile("windows", []))).toEqual(["cpu"])
    expect(preferredEngineVariants(profile("windows", [unusable]))).toEqual(["cpu"])
  })

  test("linux + nvidia leads with cuda, then vulkan, cpu last", () => {
    expect(preferredEngineVariants(profile("linux", [nvidia]))).toEqual(["cuda", "vulkan", "cpu"])
  })

  test("linux + amd leads with rocm", () => {
    expect(preferredEngineVariants(profile("linux", [amd]))).toEqual(["rocm", "vulkan", "cpu"])
  })

  test("macos uses metal", () => {
    expect(preferredEngineVariants({ ...profile("macos", []), arch: "arm64" })).toEqual(["metal"])
  })

  test("an explicit variant is tried first, with the rest kept as fallback", () => {
    expect(preferredEngineVariants(profile("windows", [nvidia]), "cpu")).toEqual(["cpu", "vulkan", "cuda"])
    expect(preferredEngineVariants(profile("windows", [nvidia]), "cuda")).toEqual(["cuda", "vulkan", "cpu"])
    expect(preferredEngineVariants(profile("windows", [nvidia]), "auto")).toEqual(["vulkan", "cuda", "cpu"])
  })

  test("IMURUN_LLAMA_VARIANT pins the first choice when preferVariant is unset", () => {
    process.env.IMURUN_LLAMA_VARIANT = "cpu"
    try {
      expect(preferredEngineVariants(profile("linux", [nvidia]))[0]).toBe("cpu")
    } finally {
      delete process.env.IMURUN_LLAMA_VARIANT
    }
  })
})

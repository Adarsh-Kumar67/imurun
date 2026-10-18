import { describe, expect, test } from "bun:test"
import type { GpuInfo, HardwareProfile } from "@imurun/schema"
import { computeTier, scoreHardware } from "@imurun/schema"
import {
  CATALOG,
  estimateSpeed,
  fittingModels,
  pickQuant,
  quantSizeMB,
  recommendModels,
  searchCatalog,
} from "../src"

function profile(input: {
  ramMB: number
  cores?: number
  gpu?: Array<Partial<GpuInfo>>
}): HardwareProfile {
  const cores = input.cores ?? 8
  const gpu: GpuInfo[] = (input.gpu ?? []).map((g) => ({
    vendor: g.vendor ?? "nvidia",
    name: g.name ?? "Test GPU",
    vramMB: g.vramMB ?? 0,
    unified: g.unified ?? false,
    computeCap: g.computeCap,
    usable: g.usable ?? true,
  }))
  const ram = { totalMB: input.ramMB, availableMB: Math.round(input.ramMB * 0.7) }
  const cpu = { name: "Test CPU", cores, threads: cores * 2, flags: [] }
  const score = scoreHardware({ ram, cpu, gpu })
  return {
    os: "linux",
    arch: "x64",
    cpu,
    ram,
    gpu,
    disk: { freeGB: 100, path: "/tmp" },
    tier: computeTier(score),
    score,
    detectedAt: Date.now(),
  }
}

const RTX_4090 = { vendor: "nvidia" as const, name: "NVIDIA GeForce RTX 4090", vramMB: 24_564 }

describe("catalog integrity", () => {
  test("every entry is complete and consistently sized", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(12)
    const ids = new Set<string>()
    for (const model of CATALOG) {
      expect(ids.has(model.id)).toBe(false)
      ids.add(model.id)
      expect(model.quantizations.length).toBeGreaterThan(0)
      expect(model.displayName.length).toBeGreaterThan(0)
      expect(model.license.length).toBeGreaterThan(0)
      for (const quant of model.quantizations) {
        expect(quant.sizeGB).toBeGreaterThan(0)
        expect(quant.huggingface.repo).toContain("/")
        expect(quant.huggingface.file.endsWith(".gguf")).toBe(true)
      }
    }
  })

  test("vision models ship an mmproj file", () => {
    const vision = CATALOG.filter((m) => m.capabilities.vision)
    expect(vision.length).toBeGreaterThan(0)
    for (const model of vision) {
      for (const quant of model.quantizations) {
        expect(quant.mmproj?.file.endsWith(".gguf")).toBe(true)
      }
    }
  })

  test("search finds models by tag and name", () => {
    expect(searchCatalog("vision").some((m) => m.id === "qwen2.5-vl-7b")).toBe(true)
    expect(searchCatalog("coder").length).toBeGreaterThan(3)
    expect(searchCatalog("qwen3").length).toBeGreaterThan(2)
    expect(searchCatalog("nonsense-query-xyz")).toHaveLength(0)
  })
})

describe("recommendation engine", () => {
  test("24 GB GPU + 32 GB RAM fully offloads the 32B coder at Q4", () => {
    const p = profile({ ramMB: 32_768, cores: 16, gpu: [RTX_4090] })
    const model = CATALOG.find((m) => m.id === "qwen2.5-coder-32b")!
    const pick = pickQuant(model, p)
    expect(pick.fits).toBe(true)
    expect(pick.recommendedQuant).toBe("Q4_K_M")
    expect(pick.reason).toContain("fits fully")
    expect(pick.reason).toContain("RTX 4090")
  })

  test("16 GB CPU-only machine gets the 14B at Q4 but not the 32B", () => {
    const p = profile({ ramMB: 16_384, cores: 8 })
    const fourteen = pickQuant(CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!, p)
    expect(fourteen.fits).toBe(true)
    expect(fourteen.recommendedQuant).toBe("Q4_K_M")
    expect(fourteen.reason).toContain("CPU")

    const thirtyTwo = pickQuant(CATALOG.find((m) => m.id === "qwen2.5-coder-32b")!, p)
    expect(thirtyTwo.fits).toBe(false)
    expect(thirtyTwo.reason).toContain("needs")
  })

  test("8 GB machine falls back to a smaller quant instead of failing", () => {
    const p = profile({ ramMB: 8_192, cores: 6 })
    const seven = pickQuant(CATALOG.find((m) => m.id === "qwen2.5-coder-7b")!, p)
    expect(seven.fits).toBe(true)
    // Q4 does not fit in the conservative model; Q3 must be selected
    expect(seven.recommendedQuant).toBe("Q3_K_M")
    expect(quantSizeMB(CATALOG.find((m) => m.id === "qwen2.5-coder-7b")!, seven.recommendedQuant)).toBeLessThan(8192)
  })

  test("4 GB minimal machine still fits the 1.5B", () => {
    const p = profile({ ramMB: 4_096, cores: 4 })
    const small = pickQuant(CATALOG.find((m) => m.id === "qwen2.5-coder-1.5b")!, p)
    expect(small.fits).toBe(true)
  })

  test("fitting list is ranked with sensible leaders per machine class", () => {
    const big = fittingModels(profile({ ramMB: 65_536, cores: 16, gpu: [RTX_4090] }))
    expect(big.length).toBeGreaterThan(3)
    expect(Math.max(...big.slice(0, 3).map((r) => r.model.paramsB))).toBeGreaterThanOrEqual(14)

    const mid = fittingModels(profile({ ramMB: 16_384, cores: 8 }))
    expect(mid[0]!.fits).toBe(true)
    expect(mid[0]!.model.capabilities.coding).toBeGreaterThanOrEqual(55)

    const tiny = fittingModels(profile({ ramMB: 4_096, cores: 4 }))
    expect(tiny.length).toBeGreaterThan(0)
    expect(Math.max(...tiny.map((r) => r.model.paramsB))).toBeLessThanOrEqual(4)
  })

  test("recommendations keep too-large models but mark them unfitting", () => {
    const result = recommendModels(profile({ ramMB: 8_192, cores: 4 }))
    expect(result.recommendations.some((r) => !r.fits)).toBe(true)
    const fitting = result.recommendations.filter((r) => r.fits)
    const notFitting = result.recommendations.filter((r) => !r.fits)
    // fitting entries always come first
    const firstUnfit = result.recommendations.findIndex((r) => !r.fits)
    expect(firstUnfit).toBe(fitting.length)
    expect(notFitting.length).toBeGreaterThan(0)
  })

  test("GPU offload scores higher than CPU-only on identical hardware", () => {
    const cpu = profile({ ramMB: 65_536, cores: 16 })
    const gpu = profile({ ramMB: 65_536, cores: 16, gpu: [RTX_4090] })
    const model = CATALOG.find((m) => m.id === "qwen2.5-coder-14b")!
    expect(estimateSpeed(model, "Q4_K_M", gpu)).toBeGreaterThan(estimateSpeed(model, "Q4_K_M", cpu))
  })
})

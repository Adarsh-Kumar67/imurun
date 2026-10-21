/**
 * Recommendation engine — decides which catalog models fit a machine and how
 * they would perform, with no network access required.
 *
 * Fit model (conservative, so "fits" stays a promise):
 *   - Usable RAM = total × 0.80 (the OS and other apps need the rest).
 *   - Weights must fit in usable RAM with ~2 GB left for the KV-cache.
 *   - A GPU with enough VRAM for weights + KV-cache means full offload.
 *   - A GPU with 60%+ of the needed VRAM means partial offload (faster).
 */
import type { HardwareProfile, ModelInfo, ModelRecommendation, QuantType } from "@imurun/schema"
import { QUANT_ORDER } from "@imurun/schema"
import { CATALOG } from "./catalog"

const KV_CACHE_MB = 2048
const RAM_UTILIZATION = 0.8

export interface GradientOptions {
  /** Override usable-RAM fraction (tests). */
  ramUtilization?: number
  /** Extra headroom requirement in MB (tests). */
  kvCacheMB?: number
}

export interface QuantFit {
  quant: QuantType
  sizeMB: number
  fits: boolean
  /** "gpu-full" | "gpu-partial" | "cpu" */
  mode: "gpu-full" | "gpu-partial" | "cpu"
  /** Estimated tokens/sec on this machine for this quant. */
  estimatedTokensPerSec: number
  reason: string
}

function bestUsableGpu(profile: HardwareProfile): { name: string; vramMB: number; unified: boolean } | undefined {
  const usable = profile.gpu.filter((g) => g.usable)
  if (usable.length === 0) return undefined
  const sorted = [...usable].sort((a, b) => b.vramMB - a.vramMB)
  const best = sorted[0]!
  // Apple Silicon reports unified memory with vramMB = 0; cap reservation at
  // 75% of total RAM, which is what macOS allows a process to wire down.
  if (best.unified) {
    return { name: best.name, vramMB: Math.round(profile.ram.totalMB * 0.75), unified: true }
  }
  return { name: best.name, vramMB: best.vramMB, unified: false }
}

export function usableRamMB(profile: HardwareProfile, options: GradientOptions = {}): number {
  return Math.round(profile.ram.totalMB * (options.ramUtilization ?? RAM_UTILIZATION))
}

const TIER_SPEED_FACTOR: Record<HardwareProfile["tier"], number> = {
  minimal: 0.45,
  low: 0.65,
  mid: 1.0,
  high: 1.45,
  extreme: 2.0,
}

const QUANT_SPEED_FACTOR: Partial<Record<QuantType, number>> = {
  Q3_K_M: 1.15,
  Q4_0: 1.08,
  IQ4_XS: 1.1,
  Q4_K_M: 1.0,
  Q5_K_M: 0.88,
  Q6_K: 0.78,
  Q8_0: 0.6,
  F16: 0.32,
}

/** Estimates tokens/sec for a model+quant on this machine. */
export function estimateSpeed(model: ModelInfo, quant: QuantType, profile: HardwareProfile): number {
  const base = model.capabilities.speed
  const quantFactor = QUANT_SPEED_FACTOR[quant] ?? 1
  const hardwareFactor = TIER_SPEED_FACTOR[profile.tier]
  const gpu = bestUsableGpu(profile)

  let gpuBoost = 1
  if (gpu) {
    const sizeMB = quantSizeMB(model, quant)
    if (gpu.vramMB >= sizeMB + KV_CACHE_MB) gpuBoost = 3.2 // full offload — dramatically faster
    else if (gpu.vramMB >= sizeMB * 0.6) gpuBoost = 1.55 // most layers on GPU
    else gpuBoost = 1.1
  }

  return Number(Math.max(0.5, base * quantFactor * hardwareFactor * gpuBoost).toFixed(1))
}

export function quantSizeMB(model: ModelInfo, quant: QuantType): number {
  const variant = model.quantizations.find((q) => q.type === quant)
  if (!variant) throw new Error(`Model ${model.id} has no ${quant} quantization`)
  return Math.round(variant.sizeGB * 1024)
}

/** Evaluates every quantization of a model against the machine. */
export function evaluateQuantFits(
  model: ModelInfo,
  profile: HardwareProfile,
  options: GradientOptions = {},
): QuantFit[] {
  const usable = usableRamMB(profile, options)
  const kv = options.kvCacheMB ?? KV_CACHE_MB
  const gpu = bestUsableGpu(profile)

  const fits = [...model.quantizations]
    .sort((a, b) => QUANT_ORDER.indexOf(b.type) - QUANT_ORDER.indexOf(a.type))
    .map((variant): QuantFit => {
      const sizeMB = Math.round(variant.sizeGB * 1024)
      const fits = sizeMB + kv <= usable
      const tokensPerSec = estimateSpeed(model, variant.type, profile)

      let mode: QuantFit["mode"] = "cpu"
      if (gpu && gpu.vramMB >= sizeMB + kv) mode = "gpu-full"
      else if (gpu && gpu.vramMB >= sizeMB * 0.6) mode = "gpu-partial"

      let reason: string
      if (!fits) {
        const deficit = sizeMB + kv - usable
        reason = `needs ~${(sizeMB / 1024).toFixed(1)} GB — about ${(deficit / 1024).toFixed(1)} GB more than this machine can spare`
      } else if (mode === "gpu-full") {
        reason = `fits fully on ${gpu!.name} — ~${tokensPerSec} t/s`
      } else if (mode === "gpu-partial") {
        reason = `fits in RAM; ${gpu!.name} accelerates it partially — ~${tokensPerSec} t/s`
      } else {
        reason = `fits in RAM; runs on CPU — ~${tokensPerSec} t/s`
      }
      return { quant: variant.type, sizeMB, fits, mode, estimatedTokensPerSec: tokensPerSec, reason }
    })

  return fits
}

/** Picks the best quantization that fits, or reports the smallest available. */
export function pickQuant(
  model: ModelInfo,
  profile: HardwareProfile,
  options: GradientOptions = {},
): ModelRecommendation {
  const fits = evaluateQuantFits(model, profile, options)
  const fitting = fits.filter((f) => f.fits)

  if (fitting.length > 0) {
    // highest quality among those that fit
    const choice = fitting[0]!
    return {
      model,
      recommendedQuant: choice.quant,
      fits: true,
      reason: choice.reason,
    }
  }

  // nothing fits — recommend the smallest so the user knows the floor
  const smallest = fits[fits.length - 1]!
  const usableGB = (usableRamMB(profile, options) / 1024).toFixed(1)
  return {
    model,
    recommendedQuant: smallest.quant,
    fits: false,
    reason: `${smallest.reason} (usable RAM: ${usableGB} GB)`,
  }
}

export interface RecommendResult {
  recommendations: ModelRecommendation[]
  profile: HardwareProfile
}

/**
 * Recommends models for a machine, best first: fitting models sorted by
 * coding quality per GB (so a 14B on a 16 GB box ranks above a 7B only when it
 * still feels fast), then too-large models for awareness.
 */
export function recommendModels(
  profile: HardwareProfile,
  catalog: readonly ModelInfo[] = CATALOG,
  options: GradientOptions = {},
): RecommendResult {
  const recommendations = catalog.map((m) => pickQuant(m, profile, options))

  const fitting = recommendations
    .filter((r) => r.fits)
    .sort((a, b) => {
      const speedA = estimateSpeed(a.model, a.recommendedQuant, profile)
      const speedB = estimateSpeed(b.model, b.recommendedQuant, profile)
      // quality-dominant, speed as the tiebreak multiplier
      const score = (r: ModelRecommendation, speed: number) => r.model.capabilities.coding * Math.min(speed / 20, 1.5)
      return score(b, speedB) - score(a, speedA)
    })

  const tooBig = recommendations
    .filter((r) => !r.fits)
    .sort((a, b) => a.model.paramsB - b.model.paramsB)

  return { recommendations: [...fitting, ...tooBig], profile }
}

/** Models that fit, best first — the list `imurun models recommend` shows. */
export function fittingModels(profile: HardwareProfile, catalog?: readonly ModelInfo[]): ModelRecommendation[] {
  return recommendModels(profile, catalog).recommendations.filter((r) => r.fits)
}

/** The largest download an automatic first run will start, in gigabytes. */
export const QUICK_START_GB = 2.5

/**
 * The model to install when nobody has chosen one.
 *
 * The best-fitting model is not always the right *first* model: on a 16 GB
 * machine that is a 7B at 5.7 GB, which is half an hour of downloading
 * before the first answer, on a connection that may be slower than that. A
 * first run should reach a working answer quickly, so this prefers the best
 * model that downloads inside a small budget, and only falls back to the best
 * fit when nothing smaller fits at all.
 *
 * `/model` is where the larger ones live, once the machine is working.
 */
export function quickStartModels(
  profile: HardwareProfile,
  catalog?: readonly ModelInfo[],
  options: GradientOptions & { maxDownloadGB?: number } = {},
): ModelRecommendation[] {
  const fitting = fittingModels(profile, catalog)
  const budget = options.maxDownloadGB ?? QUICK_START_GB
  const small = fitting.filter((recommendation) => {
    const variant = recommendation.model.quantizations.find(
      (quantization) => quantization.type === recommendation.recommendedQuant,
    )
    return variant !== undefined && variant.sizeGB <= budget
  })
  // A machine where even the smallest fit is larger still gets a model.
  return small.length > 0 ? small : fitting
}

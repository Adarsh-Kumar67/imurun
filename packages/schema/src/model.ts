/**
 * Model schemas — descriptors for local models IMURUN can install and run,
 * plus registry entries for what is already installed.
 */
import { z } from "zod"

export const QuantType = z.enum([
  "Q3_K_M",
  "Q4_0",
  "Q4_K_M",
  "IQ4_XS",
  "Q5_K_M",
  "Q6_K",
  "Q8_0",
  "F16",
])
export type QuantType = z.infer<typeof QuantType>

/** Rough quality/size ordering used when recommending quants. Higher index = higher quality & size. */
export const QUANT_ORDER: readonly QuantType[] = [
  "Q3_K_M",
  "Q4_0",
  "IQ4_XS",
  "Q4_K_M",
  "Q5_K_M",
  "Q6_K",
  "Q8_0",
  "F16",
] as const

/** Approximate bytes-per-parameter for each quant, used for size estimates. */
export const QUANT_BYTES_PER_PARAM: Record<QuantType, number> = {
  Q3_K_M: 0.43,
  Q4_0: 0.56,
  Q4_K_M: 0.58,
  IQ4_XS: 0.5,
  Q5_K_M: 0.71,
  Q6_K: 0.82,
  Q8_0: 1.06,
  F16: 2.0,
}

export const QuantVariant = z.object({
  type: QuantType,
  sizeGB: z.number().positive(),
  huggingface: z.object({
    repo: z.string(),
    file: z.string(),
  }),
  /** Vision projector file that must ship alongside the model (VL models). */
  mmproj: z
    .object({
      repo: z.string(),
      file: z.string(),
    })
    .optional(),
})
export type QuantVariant = z.infer<typeof QuantVariant>

export const ModelCapabilities = z.object({
  /** Max context window in tokens. */
  contextLength: z.number().int().positive(),
  toolCalling: z.boolean(),
  vision: z.boolean(),
  /** Coding benchmark score 0-100. */
  coding: z.number().min(0).max(100),
  /** General reasoning score 0-100. */
  reasoning: z.number().min(0).max(100),
  /** Baseline generation speed on a reference machine, tokens/sec. */
  speed: z.number().positive(),
})
export type ModelCapabilities = z.infer<typeof ModelCapabilities>

export const ModelInfo = z.object({
  id: z.string(),
  displayName: z.string(),
  family: z.string(),
  /** Parameters in billions. */
  paramsB: z.number().positive(),
  /**
   * The original (non-GGUF) Hugging Face repo, when there is one.
   *
   * The quantizations below point at GGUF conversions; the deep engine
   * (AirLLM) needs the original weights, so it needs this.
   */
  hfRepo: z.string().optional(),
  /** One-line description shown in the catalog. */
  description: z.string().default(""),
  quantizations: z.array(QuantVariant).min(1),
  capabilities: ModelCapabilities,
  minHardware: z.object({
    tier: z.enum(["minimal", "low", "mid", "high", "extreme"]),
    ramMB: z.number().int().nonnegative(),
    vramMB: z.number().int().nonnegative().optional(),
  }),
  tags: z.array(z.string()).default([]),
  license: z.string(),
  /** ISO date the catalog was last reviewed for this model. */
  updatedAt: z.string().optional(),
})
export type ModelInfo = z.infer<typeof ModelInfo>

export const InstalledModel = z.object({
  id: z.string(),
  modelId: z.string(),
  quant: QuantType,
  /** Absolute path to the GGUF file. */
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  /** Absolute path to the vision projector (mmproj) file for VL models. */
  mmprojPath: z.string().optional(),
  /** The model's trained context window, captured at install time. */
  contextLength: z.number().int().positive().optional(),
  hugginfaceRepo: z.string().optional(),
  installedAt: z.number(),
  lastUsedAt: z.number().optional(),
  /** Approximate tokens/sec measured on this machine, filled after first run. */
  measuredSpeed: z.number().optional(),
})
export type InstalledModel = z.infer<typeof InstalledModel>

/** A model plus the quant selected for the current hardware. */
export const ModelRecommendation = z.object({
  model: ModelInfo,
  recommendedQuant: QuantType,
  reason: z.string(),
  fits: z.boolean(),
})
export type ModelRecommendation = z.infer<typeof ModelRecommendation>

/**
 * Hardware schemas — the system profile IMURUN detects to decide which local
 * models can run comfortably on this machine.
 */
import { z } from "zod"

export const HardwareTier = z.enum(["minimal", "low", "mid", "high", "extreme"])
export type HardwareTier = z.infer<typeof HardwareTier>

export const GpuVendor = z.enum(["nvidia", "amd", "apple", "intel", "unknown"])
export type GpuVendor = z.infer<typeof GpuVendor>

export const GpuInfo = z.object({
  vendor: GpuVendor,
  name: z.string(),
  /** Dedicated VRAM in megabytes. For unified memory GPUs (Apple Silicon, APUs) this is 0. */
  vramMB: z.number().int().nonnegative(),
  /** True when the GPU shares system RAM (Apple Silicon, integrated APUs). */
  unified: z.boolean(),
  /** CUDA compute capability, e.g. "8.6". */
  computeCap: z.string().optional(),
  /** Whether the GPU can be used for inference on this platform. */
  usable: z.boolean().default(true),
})
export type GpuInfo = z.infer<typeof GpuInfo>

export const CpuInfo = z.object({
  name: z.string(),
  cores: z.number().int().positive(),
  threads: z.number().int().positive(),
  flags: z.array(z.string()).default([]),
})
export type CpuInfo = z.infer<typeof CpuInfo>

export const RamInfo = z.object({
  totalMB: z.number().int().nonnegative(),
  availableMB: z.number().int().nonnegative(),
})
export type RamInfo = z.infer<typeof RamInfo>

export const DiskInfo = z.object({
  freeGB: z.number().nonnegative(),
  /** Path the free-space measurement applies to (model store location). */
  path: z.string(),
})
export type DiskInfo = z.infer<typeof DiskInfo>

export const HardwareProfile = z.object({
  os: z.enum(["windows", "macos", "linux"]),
  arch: z.string(),
  cpu: CpuInfo,
  ram: RamInfo,
  gpu: z.array(GpuInfo).default([]),
  disk: DiskInfo,
  tier: HardwareTier,
  /** Numeric score 0-100 backing the tier. */
  score: z.number().min(0).max(100),
  detectedAt: z.number(),
})
export type HardwareProfile = z.infer<typeof HardwareProfile>

/** Conservative tier thresholds — they gate model recommendations. */
export function computeTier(score: number): HardwareTier {
  if (score >= 90) return "extreme"
  if (score >= 65) return "high"
  if (score >= 40) return "mid"
  if (score >= 20) return "low"
  return "minimal"
}

export interface HardwareScoreInput {
  ram: { totalMB: number }
  cpu: { cores: number }
  gpu: Array<{ vramMB: number; unified: boolean; usable: boolean }>
}

/**
 * Scores a machine from 0-100 for local inference potential.
 * Weighting: RAM up to 40 points, best GPU up to 40 points, CPU up to 20 points.
 * Uses a square-root curve so mid-range machines score fairly:
 *   16GB RAM ≈ 20p, 32GB ≈ 28p, 64GB+ = 40p
 *   8GB VRAM ≈ 23p, 16GB ≈ 33p, 24GB+ = 40p
 */
export function scoreHardware(input: HardwareScoreInput): number {
  const ramPoints = Math.min(Math.sqrt(input.ram.totalMB / 65_536), 1) * 40
  const bestGpu = Math.max(
    0,
    ...input.gpu.filter((g) => g.usable).map((g) => (g.unified ? g.vramMB || input.ram.totalMB : g.vramMB)),
  )
  const gpuPoints = Math.min(Math.sqrt(bestGpu / 24_576), 1) * 40
  const cpuPoints = Math.min(input.cpu.cores / 16, 1) * 20
  return Math.round(ramPoints + gpuPoints + cpuPoints)
}

/**
 * Bundled model catalog — a curated set of coding-capable models that run well
 * locally, with ready-to-download quantizations from Hugging Face.
 *
 * The catalog is static data so `imurun models recommend` works fully offline;
 * it is only touched by the network when a model is actually installed.
 *
 * Size estimates use the shared bytes-per-parameter table plus GGUF container
 * overhead (15%), which lands within ~5% of published file sizes.
 */
import {
  ModelInfo,
  QUANT_BYTES_PER_PARAM,
  type ModelCapabilities,
  type ModelInfo as ModelInfoType,
  type QuantType,
  type QuantVariant,
} from "@imurun/schema"

const CONTAINER_OVERHEAD = 1.15

function sizeOf(paramsB: number, quant: QuantType): number {
  return Number((paramsB * QUANT_BYTES_PER_PARAM[quant] * CONTAINER_OVERHEAD).toFixed(2))
}

interface QuantInput {
  type: QuantType
  repo: string
  file: string
  mmproj?: { repo: string; file: string }
}

interface CatalogInput {
  id: string
  displayName: string
  family: string
  paramsB: number
  description: string
  quants: QuantInput[]
  capabilities: ModelCapabilities
  minTier: "minimal" | "low" | "mid" | "high" | "extreme"
  /** RAM the smallest practical quant needs, including OS headroom. */
  minRamMB: number
  minVramMB?: number
  tags: string[]
  license: string
}

function model(input: CatalogInput): ModelInfoType {
  return ModelInfo.parse({
    id: input.id,
    displayName: input.displayName,
    family: input.family,
    paramsB: input.paramsB,
    description: input.description,
    quantizations: input.quants.map(
      (q): QuantVariant => ({
        type: q.type,
        sizeGB: sizeOf(input.paramsB, q.type),
        huggingface: { repo: q.repo, file: q.file },
        mmproj: q.mmproj,
      }),
    ),
    capabilities: input.capabilities,
    minHardware: { tier: input.minTier, ramMB: input.minRamMB, vramMB: input.minVramMB },
    tags: input.tags,
    license: input.license,
    updatedAt: "2026-10-01",
  })
}

/** Standard quant set used by most entries (repo prefix + model file prefix). */
function standardQuants(repo: string, filePrefix: string): QuantInput[] {
  return [
    { type: "Q4_K_M", repo, file: `${filePrefix}-Q4_K_M.gguf` },
    { type: "Q5_K_M", repo, file: `${filePrefix}-Q5_K_M.gguf` },
    { type: "Q3_K_M", repo, file: `${filePrefix}-Q3_K_M.gguf` },
  ]
}

export const CATALOG: readonly ModelInfoType[] = [
  model({
    id: "qwen2.5-coder-1.5b",
    displayName: "Qwen2.5 Coder 1.5B",
    family: "Qwen",
    paramsB: 1.5,
    description: "Tiny and quick. Great for autocomplete, simple edits, and low-RAM machines.",
    quants: standardQuants("bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF", "Qwen2.5-Coder-1.5B-Instruct"),
    capabilities: { contextLength: 32768, toolCalling: true, vision: false, coding: 45, reasoning: 32, speed: 95 },
    minTier: "minimal",
    minRamMB: 3072,
    tags: ["small", "fast", "autocomplete", "low-ram"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen2.5-coder-7b",
    displayName: "Qwen2.5 Coder 7B",
    family: "Qwen",
    paramsB: 7,
    description: "The sweet spot for local coding: strong tool use, fast on CPU + GPU, fits most machines.",
    quants: standardQuants("bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", "Qwen2.5-Coder-7B-Instruct"),
    capabilities: { contextLength: 32768, toolCalling: true, vision: false, coding: 68, reasoning: 55, speed: 38 },
    minTier: "low",
    minRamMB: 8192,
    minVramMB: 6000,
    tags: ["recommended", "coding", "tool-use"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen2.5-coder-14b",
    displayName: "Qwen2.5 Coder 14B",
    family: "Qwen",
    paramsB: 14,
    description: "Noticeably smarter than 7B while still comfortable on 16 GB machines.",
    quants: standardQuants("bartowski/Qwen2.5-Coder-14B-Instruct-GGUF", "Qwen2.5-Coder-14B-Instruct"),
    capabilities: { contextLength: 32768, toolCalling: true, vision: false, coding: 78, reasoning: 66, speed: 22 },
    minTier: "mid",
    minRamMB: 14336,
    minVramMB: 11000,
    tags: ["coding", "tool-use"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen2.5-coder-32b",
    displayName: "Qwen2.5 Coder 32B",
    family: "Qwen",
    paramsB: 32,
    description: "Near-frontier local coding quality. Wants 24 GB VRAM or 48 GB+ RAM.",
    quants: standardQuants("bartowski/Qwen2.5-Coder-32B-Instruct-GGUF", "Qwen2.5-Coder-32B-Instruct"),
    capabilities: { contextLength: 32768, toolCalling: true, vision: false, coding: 88, reasoning: 78, speed: 9.5 },
    minTier: "high",
    minRamMB: 28672,
    minVramMB: 24000,
    tags: ["coding", "frontier", "tool-use"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen3-4b",
    displayName: "Qwen3 4B",
    family: "Qwen",
    paramsB: 4,
    description: "Modern reasoning-capable small model with thinking mode; very fast on modest hardware.",
    quants: [
      { type: "Q4_K_M", repo: "unsloth/Qwen3-4B-GGUF", file: "Qwen3-4B-Q4_K_M.gguf" },
      { type: "Q5_K_M", repo: "unsloth/Qwen3-4B-GGUF", file: "Qwen3-4B-Q5_K_M.gguf" },
      { type: "Q8_0", repo: "unsloth/Qwen3-4B-GGUF", file: "Qwen3-4B-Q8_0.gguf" },
    ],
    capabilities: { contextLength: 40960, toolCalling: true, vision: false, coding: 55, reasoning: 58, speed: 60 },
    minTier: "low",
    minRamMB: 6144,
    tags: ["reasoning", "small", "fast"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen3-8b",
    displayName: "Qwen3 8B",
    family: "Qwen",
    paramsB: 8,
    description: "Strong all-rounder with switchable thinking mode and solid tool calling.",
    quants: [
      { type: "Q4_K_M", repo: "unsloth/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf" },
      { type: "Q5_K_M", repo: "unsloth/Qwen3-8B-GGUF", file: "Qwen3-8B-Q5_K_M.gguf" },
      { type: "Q6_K", repo: "unsloth/Qwen3-8B-GGUF", file: "Qwen3-8B-Q6_K.gguf" },
    ],
    capabilities: { contextLength: 40960, toolCalling: true, vision: false, coding: 66, reasoning: 70, speed: 35 },
    minTier: "low",
    minRamMB: 9216,
    minVramMB: 7000,
    tags: ["reasoning", "tool-use"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen3-14b",
    displayName: "Qwen3 14B",
    family: "Qwen",
    paramsB: 14,
    description: "High-quality reasoning on a single 12–16 GB GPU or a 32 GB CPU machine.",
    quants: [
      { type: "Q4_K_M", repo: "unsloth/Qwen3-14B-GGUF", file: "Qwen3-14B-Q4_K_M.gguf" },
      { type: "Q5_K_M", repo: "unsloth/Qwen3-14B-GGUF", file: "Qwen3-14B-Q5_K_M.gguf" },
      { type: "Q3_K_M", repo: "unsloth/Qwen3-14B-GGUF", file: "Qwen3-14B-Q3_K_M.gguf" },
    ],
    capabilities: { contextLength: 40960, toolCalling: true, vision: false, coding: 76, reasoning: 79, speed: 22 },
    minTier: "mid",
    minRamMB: 14336,
    minVramMB: 12000,
    tags: ["reasoning", "tool-use"],
    license: "apache-2.0",
  }),
  model({
    id: "qwen3-32b",
    displayName: "Qwen3 32B",
    family: "Qwen",
    paramsB: 32,
    description: "Frontier-class local reasoning. Needs serious hardware (24 GB VRAM or 64 GB RAM).",
    quants: [
      { type: "Q4_K_M", repo: "unsloth/Qwen3-32B-GGUF", file: "Qwen3-32B-Q4_K_M.gguf" },
      { type: "Q3_K_M", repo: "unsloth/Qwen3-32B-GGUF", file: "Qwen3-32B-Q3_K_M.gguf" },
    ],
    capabilities: { contextLength: 40960, toolCalling: true, vision: false, coding: 85, reasoning: 88, speed: 9 },
    minTier: "high",
    minRamMB: 28672,
    minVramMB: 24000,
    tags: ["reasoning", "frontier", "tool-use"],
    license: "apache-2.0",
  }),
  model({
    id: "deepseek-coder-v2-lite-16b",
    displayName: "DeepSeek Coder V2 Lite 16B",
    family: "DeepSeek",
    paramsB: 16,
    description: "Mixture-of-experts: 16B total, 2.4B active per token — 32B-era speed at 7B cost.",
    quants: [
      { type: "Q4_K_M", repo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF", file: "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf" },
      { type: "Q5_K_M", repo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF", file: "DeepSeek-Coder-V2-Lite-Instruct-Q5_K_M.gguf" },
      { type: "Q3_K_M", repo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF", file: "DeepSeek-Coder-V2-Lite-Instruct-Q3_K_M.gguf" },
    ],
    capabilities: { contextLength: 128000, toolCalling: false, vision: false, coding: 66, reasoning: 52, speed: 45 },
    minTier: "low",
    minRamMB: 12288,
    tags: ["moe", "fast", "coding", "long-context"],
    license: "deepseek-license",
  }),
  model({
    id: "codestral-22b",
    displayName: "Codestral 22B",
    family: "Mistral",
    paramsB: 22,
    description: "Mistral's dedicated coding model with a huge context window. Non-production license.",
    quants: [
      { type: "Q4_K_M", repo: "bartowski/Codestral-22B-v0.1-GGUF", file: "Codestral-22B-v0.1-Q4_K_M.gguf" },
      { type: "Q5_K_M", repo: "bartowski/Codestral-22B-v0.1-GGUF", file: "Codestral-22B-v0.1-Q5_K_M.gguf" },
    ],
    capabilities: { contextLength: 32768, toolCalling: false, vision: false, coding: 74, reasoning: 60, speed: 15 },
    minTier: "mid",
    minRamMB: 18432,
    tags: ["coding", "fill-in-the-middle"],
    license: "mistral-ai-non-production",
  }),
  model({
    id: "yi-coder-9b",
    displayName: "Yi-Coder 9B Chat",
    family: "Yi",
    paramsB: 9,
    description: "Long-context coding model supporting 50+ programming languages.",
    quants: standardQuants("bartowski/Yi-Coder-9B-Chat-GGUF", "Yi-Coder-9B-Chat"),
    capabilities: { contextLength: 128000, toolCalling: false, vision: false, coding: 60, reasoning: 48, speed: 32 },
    minTier: "low",
    minRamMB: 9216,
    tags: ["coding", "long-context"],
    license: "apache-2.0",
  }),
  model({
    id: "granite-3.1-8b",
    displayName: "Granite 3.1 8B Instruct",
    family: "IBM",
    paramsB: 8,
    description: "IBM's enterprise-friendly instruct model with strong tool calling and a clean license.",
    quants: standardQuants("bartowski/granite-3.1-8b-instruct-GGUF", "granite-3.1-8b-instruct"),
    capabilities: { contextLength: 128000, toolCalling: true, vision: false, coding: 52, reasoning: 55, speed: 35 },
    minTier: "low",
    minRamMB: 9216,
    tags: ["tool-use", "enterprise", "long-context"],
    license: "apache-2.0",
  }),
  model({
    id: "phi-4-mini-3.8b",
    displayName: "Phi-4 Mini 3.8B",
    family: "Microsoft",
    paramsB: 3.8,
    description: "Excellent reasoning-per-byte with full tool-calling support. MIT licensed.",
    quants: standardQuants("bartowski/Phi-4-mini-instruct-GGUF", "Phi-4-mini-instruct"),
    capabilities: { contextLength: 128000, toolCalling: true, vision: false, coding: 58, reasoning: 62, speed: 62 },
    minTier: "minimal",
    minRamMB: 5120,
    tags: ["small", "reasoning", "tool-use"],
    license: "mit",
  }),
  model({
    id: "llama-3.2-3b",
    displayName: "Llama 3.2 3B Instruct",
    family: "Meta",
    paramsB: 3,
    description: "Meta's compact assistant — good general chat, modest coding ability.",
    quants: standardQuants("bartowski/Llama-3.2-3B-Instruct-GGUF", "Llama-3.2-3B-Instruct"),
    capabilities: { contextLength: 128000, toolCalling: true, vision: false, coding: 42, reasoning: 48, speed: 70 },
    minTier: "minimal",
    minRamMB: 4096,
    tags: ["small", "general"],
    license: "llama3.2",
  }),
  model({
    id: "gemma-3-12b",
    displayName: "Gemma 3 12B IT (QAT)",
    family: "Google",
    paramsB: 12,
    description: "Google's Gemma 3 with official quantization-aware training — quality that punches above its size.",
    quants: [
      {
        type: "Q4_0",
        repo: "google/gemma-3-12b-it-qat-q4_0-gguf",
        file: "gemma-3-12b-it-qat-Q4_0.gguf",
      },
    ],
    capabilities: { contextLength: 32768, toolCalling: true, vision: false, coding: 63, reasoning: 68, speed: 26 },
    minTier: "mid",
    minRamMB: 12288,
    tags: ["qat", "general", "multilingual"],
    license: "gemma",
  }),
  model({
    id: "qwen2.5-vl-7b",
    displayName: "Qwen2.5 VL 7B",
    family: "Qwen",
    paramsB: 7,
    description: "Sight for IMURUN: reads screenshots, diagrams, and UI mockups. Ships with its vision projector.",
    quants: [
      {
        type: "Q4_K_M",
        repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        file: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
        mmproj: { repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", file: "mmproj-model-f16.gguf" },
      },
      {
        type: "Q5_K_M",
        repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
        file: "Qwen2.5-VL-7B-Instruct-Q5_K_M.gguf",
        mmproj: { repo: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF", file: "mmproj-model-f16.gguf" },
      },
    ],
    capabilities: { contextLength: 32768, toolCalling: true, vision: true, coding: 55, reasoning: 60, speed: 34 },
    minTier: "mid",
    minRamMB: 10240,
    minVramMB: 7000,
    tags: ["vision", "screenshots", "coding"],
    license: "apache-2.0",
  }),
]

export function getCatalogModel(id: string): ModelInfoType | undefined {
  return CATALOG.find((m) => m.id === id)
}

/** Filters the catalog by tag, family, or id substring (used by the CLI). */
export function searchCatalog(query: string): ModelInfoType[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...CATALOG]
  return CATALOG.filter(
    (m) =>
      m.id.includes(q) ||
      m.family.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      m.tags.some((t) => t.includes(q)),
  )
}

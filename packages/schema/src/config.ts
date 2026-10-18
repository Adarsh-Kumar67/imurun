/**
 * Config schemas — the complete shape of imurun.json(c) files.
 *
 * Global config:  ~/.imurun/imurun.json
 * Project config: ./imurun.json or ./.imurun/imurun.json (merged over global)
 */
import { z } from "zod"
import { PermissionRule } from "./permission"
import { ProviderConfig } from "./provider"
import { ProviderType } from "./provider"

export const RuntimeConfig = z.object({
  engine: z.enum(["llama-cpp", "ollama"]).default("llama-cpp"),
  /**
   * Which llama.cpp build to install: "auto" picks the best fit for the
   * detected hardware (with automatic fallback when a build will not run).
   */
  engineVariant: z.enum(["auto", "vulkan", "cuda", "rocm", "metal", "cpu"]).default("auto"),
  /** Local OpenAI-compatible port the daemon listens on. */
  port: z.number().int().min(1024).max(65535).default(42425),
  /** Unload the model from RAM after this many idle minutes. 0 = never. */
  idleUnloadMinutes: z.number().int().nonnegative().default(10),
  /** Keep the server process alive after the last session ends (grace) in seconds. */
  shutdownGraceSeconds: z.number().int().nonnegative().default(30),
  /** CPU threads for inference; 0 = auto. */
  threads: z.number().int().nonnegative().default(0),
  /** GPU layers to offload; -1 = all, 0 = CPU only. */
  gpuLayers: z.number().int().default(-1),
  /** Context window override; 0 = use the model's trained window. */
  contextSize: z.number().int().nonnegative().default(0),
  /**
   * RoPE scaling used to reach past the model's trained window.
   * "auto" applies YaRN whenever the requested context is larger than the
   * model's window; "none" disables scaling entirely.
   */
  ropeScaling: z.enum(["auto", "none", "linear", "yarn"]).default("auto"),
  /** Explicit context-extension factor (e.g. 4 = 4× the trained window). 0 = derive it. */
  ropeScale: z.number().nonnegative().default(0),
  flashAttention: z.boolean().default(true),
  /** Opt into speculative decoding when a matching draft model is available. */
  speculativeDecoding: z.boolean().default(false),
})
export type RuntimeConfig = z.infer<typeof RuntimeConfig>

export const MemoryConfig = z.object({
  enabled: z.boolean().default(true),
  /** Learn coding style from edits and generations. */
  learnStyle: z.boolean().default(true),
  /** Recall relevant summaries from past sessions. */
  crossSession: z.boolean().default(true),
  /** Automatically summarize sessions on close. */
  autoSummarize: z.boolean().default(true),
  maxRecallEntries: z.number().int().positive().default(5),
})
export type MemoryConfig = z.infer<typeof MemoryConfig>

export const RagConfig = z.object({
  enabled: z.boolean().default(true),
  /** Watch project files and re-index incrementally. */
  watch: z.boolean().default(true),
  /** Automatically inject retrieved context into prompts. */
  autoInject: z.boolean().default(true),
  maxInjectChunks: z.number().int().positive().default(6),
  chunkSize: z.number().int().positive().default(800),
  chunkOverlap: z.number().int().nonnegative().default(120),
  /** Skip files larger than this. */
  maxFileSizeKB: z.number().int().positive().default(1024),
  excludeGlobs: z.array(z.string()).default([
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "out/**",
    "*.min.*",
    "*.lock",
  ]),
  /** Embedding model used for indexing and queries. */
  embeddingModel: z.string().default("all-MiniLM-L6-v2"),
})
export type RagConfig = z.infer<typeof RagConfig>

export const TuiConfig = z.object({
  theme: z.string().default("imurun-dark"),
  /** Show RAG source indicators on messages. */
  showRagSources: z.boolean().default(true),
  /** Show memory usage indicators on messages. */
  showMemoryUsage: z.boolean().default(true),
})
export type TuiConfig = z.infer<typeof TuiConfig>

export const WebConfig = z.object({
  /** Search backend: "duckduckgo" needs no key. */
  searchBackend: z.enum(["duckduckgo", "brave", "searxng"]).default("duckduckgo"),
  searxngURL: z.string().optional(),
  /** Cache fetched pages into the RAG index for later reuse. */
  cacheFetches: z.boolean().default(true),
  maxPageKB: z.number().int().positive().default(2048),
})
export type WebConfig = z.infer<typeof WebConfig>

export const DefaultProviderPriority: readonly z.infer<typeof ProviderType>[] = ["llama-cpp", "ollama"] as const

export const ImurunConfig = z.object({
  $schema: z.string().optional(),
  /** Default model ID, e.g. "qwen2.5-coder-7b". */
  model: z.string().optional(),
  /** Small fast model for titles/summaries, e.g. "qwen2.5-coder-1.5b". */
  smallModel: z.string().optional(),
  /** Provider definitions, keyed by provider id. */
  providers: z.record(z.string(), ProviderConfig).default({}),
  runtime: RuntimeConfig.prefault({}),
  memory: MemoryConfig.prefault({}),
  rag: RagConfig.prefault({}),
  tui: TuiConfig.prefault({}),
  web: WebConfig.prefault({}),
  permissions: z.array(PermissionRule).default([]),
  /** Tool names disabled entirely for this project. */
  disabledTools: z.array(z.string()).default([]),
  /** Extra instructions appended to the system prompt. */
  instructions: z.array(z.string()).default([]),
})
export type ImurunConfig = z.infer<typeof ImurunConfig>

/** Deep-partial input shape accepted from config files. */
export type ImurunConfigInput = z.input<typeof ImurunConfig>
export type RuntimeConfigInput = z.input<typeof RuntimeConfig>
export type RagConfigInput = z.input<typeof RagConfig>
export type MemoryConfigInput = z.input<typeof MemoryConfig>

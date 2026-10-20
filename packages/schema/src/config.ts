/**
 * Config schemas — the complete shape of imurun.json(c) files.
 *
 * Global config:  ~/.imurun/imurun.json
 * Project config: ./imurun.json or ./.imurun/imurun.json (merged over global)
 */
import { z } from "zod"
import { PermissionsConfig } from "./permission"
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
  /**
   * The card vault — the second brain. Typed markdown cards that age with
   * disuse and strengthen with use. Off leaves only the flat notes.
   */
  vault: z.boolean().default(true),
  /** Where the vault lives. Default: `~/.imurun/vault`. */
  vaultPath: z.string().optional(),
})
export type MemoryConfig = z.infer<typeof MemoryConfig>

export const RagConfig = z.object({
  enabled: z.boolean().default(true),
  /** Re-check the project for changes before a search, so results stay current. */
  watch: z.boolean().default(true),
  /** Put the most relevant project material into the prompt automatically. */
  autoInject: z.boolean().default(true),
  /** Most chunks that may be injected into one turn's prompt. */
  maxInjectChunks: z.number().int().positive().default(6),
  /** Skip files larger than this. */
  maxFileSizeKB: z.number().int().positive().default(400),
  /** Hard ceilings, so a huge or hostile tree cannot exhaust memory. */
  maxFiles: z.number().int().positive().default(3000),
  maxChunks: z.number().int().positive().default(6000),
  /** Chunk shape: lines per chunk, lines shared with the next, characters per cap. */
  chunkLines: z.number().int().positive().default(60),
  chunkOverlapLines: z.number().int().nonnegative().default(8),
  chunkChars: z.number().int().positive().default(1600),
  /** Project-relative globs that are never indexed. */
  excludeGlobs: z.array(z.string()).default([
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "out/**",
    "target/**",
    "**/*.min.*",
    "**/*.lock",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
  ]),
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
  /** Which engine web_search asks: DuckDuckGo needs no key at all. */
  searchBackend: z.enum(["duckduckgo", "brave", "searxng"]).default("duckduckgo"),
  /** Base URL of the SearXNG instance used when searchBackend is "searxng". */
  searxngURL: z.string().optional(),
  /** Brave Search API key, for searchBackend "brave" (`BRAVE_API_KEY` also works). */
  braveApiKey: z.string().optional(),
  /**
   * Write fetched pages into the project (`.imurun/web-cache`) so the project
   * index can find them again offline. Off by default: it puts files in your
   * project, and that should be a choice.
   */
  cacheFetches: z.boolean().default(false),
  /** Most of a page web_fetch downloads before it is cut off. */
  maxPageKB: z.number().int().positive().default(2048),
  /**
   * Automatic research before answering: `auto` uses the learned need
   * classifier, `always` searches every turn, `off` never searches on its own.
   * The `web_search` tool remains available in every mode.
   */
  research: z.enum(["auto", "always", "off"]).default("auto"),
  /** How many distinct search queries one research pass may make. */
  researchMaxQueries: z.number().int().min(1).max(8).default(3),
  /** How many result pages one research pass may read. */
  researchMaxPages: z.number().int().min(1).max(8).default(3),
  /**
   * After the draft, check its factual claims against the gathered evidence and
   * run one bounded follow-up search when something is unsupported.
   */
  researchVerify: z.boolean().default(true),
  /** Where the need classifier keeps its learned weights. */
  researchModel: z.string().optional(),
})
export type WebConfig = z.infer<typeof WebConfig>

export const DefaultProviderPriority: readonly z.infer<typeof ProviderType>[] = ["llama-cpp", "ollama"] as const

/**
 * How hard a model is asked to think before it answers. `max` is deliberately
 * the same knob as `high` on most APIs; it means "do not hold back" rather than
 * a separately-defined level, so sending it is safe everywhere `high` works.
 */
export const ReasoningEffort = z.enum(["low", "medium", "high", "max"])
export type ReasoningEffort = z.infer<typeof ReasoningEffort>

export const ImurunConfig = z.object({
  $schema: z.string().optional(),
  /** Default model ID, e.g. "qwen2.5-coder-7b". */
  model: z.string().optional(),
  /** Small fast model for titles/summaries, e.g. "qwen2.5-coder-1.5b". */
  smallModel: z.string().optional(),
  /** Thinking budget sent to providers that take a `reasoning_effort`. */
  reasoningEffort: ReasoningEffort.optional(),
  /**
   * Override the context window (tokens) used for budgeting and shown in the
   * panel. Set this when a model's real window is not advertised by its
   * endpoint, so IMURUN neither under- nor over-fills it.
   */
  contextWindow: z.number().int().positive().optional(),
  /**
   * Whether the active model can see images. Unset means "work it out from the
   * model id"; set it for an endpoint serving a vision model IMURUN does not
   * recognise (`true`) or a text-only model with a misleading name (`false`).
   */
  vision: z.boolean().optional(),
  /** Extra model-id fragments to treat as vision-capable, alongside the built-ins. */
  visionModels: z.array(z.string()).default([]),
  /** Provider definitions, keyed by provider id. */
  providers: z.record(z.string(), ProviderConfig).default({}),
  runtime: RuntimeConfig.prefault({}),
  memory: MemoryConfig.prefault({}),
  rag: RagConfig.prefault({}),
  tui: TuiConfig.prefault({}),
  web: WebConfig.prefault({}),
  permissions: PermissionsConfig.prefault({}),
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

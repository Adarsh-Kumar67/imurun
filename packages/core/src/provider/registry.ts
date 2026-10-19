/**
 * Provider layer — one registry for local inference engines and cloud APIs.
 *
 * Local engines (llama.cpp daemon, LM Studio, Ollama) and most cloud APIs
 * speak the OpenAI-compatible protocol; Anthropic and Google get their
 * dedicated SDK providers. Everything is normalized to an AI SDK
 * LanguageModel so the agent loop has a single code path.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { LanguageModel } from "ai"
import type { ImurunConfig, ProviderConfig, ProviderInfo } from "@imurun/schema"
import { resolveEnvRef } from "@imurun/schema"
import { logger, withRetry } from "@imurun/util"
import { mergeModelIds } from "./presets"

export interface ResolvedModel {
  provider: ProviderConfig
  modelId: string
  model: LanguageModel
}

const DEFAULT_BASE_URLS: Partial<Record<ProviderConfig["type"], string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
}

/** The implicit local provider backed by the IMURUN runtime daemon. */
export function localProviderConfig(config: ImurunConfig): ProviderConfig {
  return {
    id: "local",
    kind: "local",
    type: "llama-cpp",
    baseURL: `http://127.0.0.1:${config.runtime.port}/v1`,
    models: [],
    enabled: true,
  }
}

function requireKey(provider: ProviderConfig): string {
  const key = resolveEnvRef(provider.apiKey)
  if (!key) {
    throw new Error(
      `Provider "${provider.id}" requires an API key. Set the apiKey field or the referenced environment variable.`,
    )
  }
  return key
}

/** Builds an AI SDK LanguageModel for a provider + model id. */
export function createLanguageModel(provider: ProviderConfig, modelId: string, config: ImurunConfig): LanguageModel {
  switch (provider.type) {
    case "llama-cpp":
    case "lmstudio":
    case "ollama":
    case "openai":
    case "openrouter":
    case "groq":
    case "custom": {
      const baseURL =
        resolveEnvRef(provider.baseURL) ??
        (provider.type === "llama-cpp" ? `http://127.0.0.1:${config.runtime.port}/v1` : DEFAULT_BASE_URLS[provider.type])
      if (!baseURL) {
        throw new Error(`Provider "${provider.id}" of type "${provider.type}" requires a baseURL.`)
      }
      const needsKey = provider.kind === "api" && provider.type !== "custom"
      const apiKey = needsKey ? requireKey(provider) : (resolveEnvRef(provider.apiKey) ?? "imurun-local")
      const client = createOpenAICompatible({
        name: provider.id,
        baseURL,
        apiKey,
        headers: provider.headers,
        // ask the server to report token usage in streamed responses
        includeUsage: true,
      })
      return client.chatModel(modelId)
    }
    case "anthropic": {
      const client = createAnthropic({ apiKey: requireKey(provider), headers: provider.headers })
      return client.languageModel(modelId)
    }
    case "google": {
      const client = createGoogleGenerativeAI({ apiKey: requireKey(provider), headers: provider.headers })
      return client.languageModel(modelId)
    }
    default: {
      const exhaustive: never = provider.type
      throw new Error(`Unsupported provider type: ${String(exhaustive)}`)
    }
  }
}

/**
 * True when a provider accepts a `reasoning_effort` on the request. Local
 * engines take their thinking behaviour from the chat template, and the
 * dedicated SDK providers need their own knobs, so only the OpenAI-compatible
 * APIs count here — which is also what `/effort` reports.
 */
export function supportsReasoningEffort(provider: ProviderConfig): boolean {
  if (provider.kind !== "api") return false
  return provider.type !== "anthropic" && provider.type !== "google"
}

/**
 * Reads a context-window figure out of one `/models` entry. Different
 * OpenAI-compatible servers name the field differently; a value we cannot
 * recognise is simply left out, so the caller falls back rather than guessing.
 */
export function readModelContext(entry: Record<string, unknown>): number | undefined {
  const keys = ["context_length", "context_window", "max_context_length", "max_model_len", "max_input_tokens"]
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/** Checks whether a local/provider endpoint is reachable. */
export async function probeProvider(provider: ProviderConfig, config: ImurunConfig): Promise<ProviderInfo> {
  if (!provider.enabled) {
    return { config: provider, status: "disabled", models: provider.models }
  }

  const isLocal = provider.kind === "local"
  const baseURL =
    resolveEnvRef(provider.baseURL) ??
    (provider.type === "llama-cpp" ? `http://127.0.0.1:${config.runtime.port}/v1` : DEFAULT_BASE_URLS[provider.type])

  if (!baseURL) {
    return { config: provider, status: "error", detail: "Missing baseURL", models: provider.models }
  }

  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) {
      return { config: provider, status: "error", detail: `HTTP ${response.status}`, models: provider.models }
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const entries = (body.data ?? []) as Array<Record<string, unknown>>
    const discovered = entries
      .map((m) => (typeof m.id === "string" ? m.id : undefined))
      .filter((id): id is string => Boolean(id))
    const modelContext: Record<string, number> = {}
    for (const entry of entries) {
      if (typeof entry.id !== "string") continue
      const size = readModelContext(entry)
      if (size) modelContext[entry.id] = size
    }
    return {
      config: provider,
      status: "ready",
      // The live list is the truth; configured ids are appended so a saved
      // alias is not lost. `/models` and the picker then offer everything the
      // endpoint actually serves, not just what was written into the config.
      models: mergeModelIds(discovered, provider.models),
      ...(Object.keys(modelContext).length > 0 ? { modelContext } : {}),
    }
  } catch (error) {
    return {
      config: provider,
      status: isLocal ? "unreachable" : "error",
      detail: (error as Error).message,
      models: provider.models,
    }
  }
}

export class ProviderRegistry {
  private readonly providers: ProviderConfig[]

  constructor(readonly config: ImurunConfig) {
    const configured = Object.values(config.providers)
    const hasLocal = configured.some((p) => p.type === "llama-cpp")
    this.providers = hasLocal ? configured : [localProviderConfig(config), ...configured]
  }

  list(): ProviderConfig[] {
    return [...this.providers]
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.find((p) => p.id === id)
  }

  /**
   * Resolves a model reference to a concrete model.
   * Accepted forms:
   *   "qwen2.5-coder-7b"            → default provider (config.model's provider or "local")
   *   "local/qwen2.5-coder-7b"      → explicit provider by id
   *   "openrouter/qwen/qwen3-32b"   → explicit provider, rest is the model id
   */
  resolve(modelRef?: string): ResolvedModel {
    const ref = modelRef ?? this.config.model
    if (!ref) {
      throw new Error(
        "No model selected. Install one with `imurun models install <id>`, then set it with `imurun config set model <id>` or pass --model.",
      )
    }

    const enabled = this.providers.filter((p) => p.enabled)

    if (ref.includes("/")) {
      const [maybeProvider, ...rest] = ref.split("/")
      const provider = enabled.find((p) => p.id === maybeProvider)
      if (provider) {
        const modelId = rest.join("/")
        logger.debug(`resolved model: ${ref} → provider "${provider.id}"`)
        return { provider, modelId, model: createLanguageModel(provider, modelId, this.config) }
      }
    }

    // priority: the provider that explicitly lists this model, else the first local, else first enabled
    const listing = enabled.find((p) => p.models.includes(ref))
    const firstLocal = enabled.find((p) => p.kind === "local")
    const provider = listing ?? firstLocal ?? enabled[0]
    if (!provider) {
      throw new Error("No providers are enabled. Configure one in imurun.json or install a local model.")
    }

    logger.debug(`resolved model: ${ref} → provider "${provider.id}"`)
    return { provider, modelId: ref, model: createLanguageModel(provider, ref, this.config) }
  }

  /** Probes every provider; used by `imurun providers list`. */
  async statuses(): Promise<ProviderInfo[]> {
    return withRetry(async () => Promise.all(this.providers.map((p) => probeProvider(p, this.config))), {
      attempts: 1,
    })
  }
}

/**
 * Provider presets — the services IMURUN can talk to, with the endpoint and the
 * environment variable each one conventionally uses.
 *
 * A preset is only a starting point: every one of these speaks the
 * OpenAI-compatible protocol (or has a dedicated SDK provider), so configuring a
 * provider is just picking one from this list and pasting a key. The `models`
 * list is a hint shown while a key is being added — once the provider answers,
 * its own `/models` endpoint is the source of truth, not this file.
 */
import type { ProviderType } from "@imurun/schema"

export interface ProviderPreset {
  /** Provider id written into the config. */
  id: string
  label: string
  type: ProviderType
  /** Endpoint, for OpenAI-compatible services. */
  baseURL?: string
  /** Conventional environment variable, offered as a hint only. */
  keyEnv?: string
  /** Where the user gets a key. Absent for key-less endpoints. */
  console?: string
  /** A handful of model ids to offer before the endpoint is probed. */
  models: string[]
  /** True when the user must also supply the endpoint URL. */
  needsBaseURL?: boolean
  /** One line describing the trade-off. */
  note: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    type: "openai",
    baseURL: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    console: "https://platform.openai.com/api-keys",
    models: ["gpt-5.2", "gpt-5.1-codex", "gpt-5.1", "gpt-5-mini", "gpt-4.1"],
    note: "OpenAI's own models",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    type: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    console: "https://console.anthropic.com/settings/keys",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
    note: "Claude models",
  },
  {
    id: "google",
    label: "Google Gemini",
    type: "google",
    keyEnv: "GEMINI_API_KEY",
    console: "https://aistudio.google.com/apikey",
    models: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-3.1-pro-preview"],
    note: "Gemini models, generous free tier",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    type: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    console: "https://openrouter.ai/keys",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.1",
      "google/gemini-3-pro-preview",
      "qwen/qwen3-coder",
      "deepseek/deepseek-v3.2",
      "z-ai/glm-4.7",
    ],
    note: "one key, most models from most vendors",
  },
  {
    id: "groq",
    label: "Groq",
    type: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    console: "https://console.groq.com/keys",
    models: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "qwen/qwen3.8-27b",
    ],
    note: "very fast inference, free tier",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    type: "custom",
    baseURL: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    console: "https://build.nvidia.com/settings/api-keys",
    models: [
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3-coder-next",
      "zai-org/glm-5.2",
      "meta/llama-3.3-70b-instruct",
    ],
    note: "hosted open models, free credits",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "custom",
    baseURL: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
    console: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "strong reasoning at low cost",
  },
  {
    id: "mistral",
    label: "Mistral",
    type: "custom",
    baseURL: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    console: "https://console.mistral.ai/api-keys",
    models: ["codestral-latest", "devstral-medium-latest", "mistral-large-latest"],
    note: "European models, code specialist",
  },
  {
    id: "xai",
    label: "xAI",
    type: "custom",
    baseURL: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    console: "https://console.x.ai",
    models: ["grok-4.1-fast", "grok-4-fast", "grok-code-fast-1"],
    note: "Grok models",
  },
  {
    id: "together",
    label: "Together AI",
    type: "custom",
    baseURL: "https://api.together.xyz/v1",
    keyEnv: "TOGETHER_API_KEY",
    console: "https://api.together.ai/settings/api-keys",
    // The catalogue turns over quickly; the endpoint is the source of truth.
    models: [],
    note: "large catalogue of open models",
  },
  {
    id: "custom",
    label: "Other (OpenAI-compatible)",
    type: "custom",
    needsBaseURL: true,
    models: [],
    note: "any endpoint that speaks the OpenAI API — a self-hosted server, a gateway, a proxy",
  },
]

/** Looks a preset up by id, case-insensitively. */
export function getProviderPreset(id: string): ProviderPreset | undefined {
  const wanted = id.trim().toLowerCase()
  return PROVIDER_PRESETS.find((preset) => preset.id === wanted)
}

/** True when the preset needs a key before it can be used. */
export function presetNeedsKey(preset: ProviderPreset): boolean {
  return preset.id !== "custom"
}

/**
 * Which model ids to offer while adding a provider: whatever the endpoint is
 * actually serving, falling back to the curated hints above when it cannot be
 * reached. The live list always wins — it is the only thing that cannot go
 * stale.
 */
export function providerModelOptions(
  preset: ProviderPreset,
  probed?: { status: string; models: string[] },
): string[] {
  if (probed && probed.status === "ready" && probed.models.length > 0) {
    return [...new Set(probed.models)].sort()
  }
  return preset.models
}

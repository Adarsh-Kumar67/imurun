/**
 * Provider schemas — local inference engines and cloud APIs share one shape.
 */
import { z } from "zod"

export const ProviderKind = z.enum(["local", "api"])
export type ProviderKind = z.infer<typeof ProviderKind>

export const ProviderType = z.enum([
  "llama-cpp",
  "ollama",
  "lmstudio",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "custom",
])
export type ProviderType = z.infer<typeof ProviderType>

export const ProviderConfig = z.object({
  id: z.string(),
  kind: ProviderKind,
  type: ProviderType,
  /** Base URL for OpenAI-compatible endpoints (local daemons and API providers). */
  baseURL: z.string().optional(),
  /** API key, or an env reference like "{env:OPENAI_API_KEY}". Never logged. */
  apiKey: z.string().optional(),
  /** Models to expose from this provider; empty means auto-discover. */
  models: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** Extra headers for custom endpoints. */
  headers: z.record(z.string(), z.string()).optional(),
})
export type ProviderConfig = z.infer<typeof ProviderConfig>

export const ProviderStatus = z.enum(["ready", "connecting", "unreachable", "disabled", "error"])
export type ProviderStatus = z.infer<typeof ProviderStatus>

export const ProviderInfo = z.object({
  config: ProviderConfig,
  status: ProviderStatus,
  /** Human-readable detail, e.g. loaded model or last error. */
  detail: z.string().optional(),
  models: z.array(z.string()).default([]),
})
export type ProviderInfo = z.infer<typeof ProviderInfo>

/** Parses "{env:VAR}" references in provider config fields. */
export function resolveEnvRef(value: string | undefined): string | undefined {
  if (!value) return value
  const match = /^\{env:([A-Z0-9_]+)\}$/.exec(value)
  if (!match) return value
  return process.env[match[1] ?? ""]
}

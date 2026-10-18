/**
 * Model references. A cloud model is addressed as "provider/model", and model
 * ids routinely contain a slash of their own ("groq/openai/gpt-oss-120b"), so
 * the split has to be on the provider id — not on the first slash.
 */
import { describe, expect, test } from "bun:test"
import { ImurunConfig } from "@imurun/schema"
import { ProviderRegistry } from "../src/provider/registry"

function registryWith(providers: Record<string, unknown>, model?: string): ProviderRegistry {
  const config = ImurunConfig.parse({
    ...(model ? { model } : {}),
    providers,
  })
  return new ProviderRegistry(config)
}

const groq = {
  id: "groq",
  kind: "api",
  type: "groq",
  baseURL: "https://api.groq.com/openai/v1",
  apiKey: "test-key",
  models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
}

describe("ProviderRegistry.resolve", () => {
  test("a model id containing slashes stays whole", () => {
    const resolved = registryWith({ groq }, "groq/openai/gpt-oss-120b").resolve()
    expect(resolved.provider.id).toBe("groq")
    expect(resolved.modelId).toBe("openai/gpt-oss-120b")
  })

  test("resolves the configured model when no reference is passed", () => {
    const resolved = registryWith({ groq }, "groq/llama-3.3-70b-versatile").resolve()
    expect(resolved.provider.id).toBe("groq")
    expect(resolved.modelId).toBe("llama-3.3-70b-versatile")
  })

  test("a listed model without a prefix finds the provider that lists it", () => {
    const resolved = registryWith({ groq }, "llama-3.3-70b-versatile").resolve()
    expect(resolved.provider.id).toBe("groq")
    expect(resolved.modelId).toBe("llama-3.3-70b-versatile")
  })

  test("the local engine is always available as a provider", () => {
    const registry = registryWith({ groq })
    const local = registry.list().find((provider) => provider.kind === "local")
    expect(local).toBeDefined()
    expect(local!.type).toBe("llama-cpp")
  })

  test("an unknown model falls back to the local provider", () => {
    const resolved = registryWith({ groq }, "qwen2.5-coder-7b").resolve()
    expect(resolved.provider.kind).toBe("local")
    expect(resolved.modelId).toBe("qwen2.5-coder-7b")
  })

  test("no model at all is a clear error, not a crash", () => {
    expect(() => registryWith({ groq }).resolve()).toThrow(/No model selected/)
  })

  test("a disabled provider is not selected", () => {
    const resolved = registryWith({ groq: { ...groq, enabled: false } }, "openai/gpt-oss-120b").resolve()
    expect(resolved.provider.kind).toBe("local")
  })
})

/**
 * Provider setup — the preset catalogue and the small config edits the
 * `/provider` flow makes on the user's behalf.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROVIDER_PRESETS, getProviderPreset, providerModelOptions } from "../src/provider/presets"
import { patchGlobalConfig, removeGlobalConfigEntry } from "../src/config/loader"

/** Points IMURUN_HOME at a scratch directory and returns its path. */
function setupHome(initial?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "imurun-provider-"))
  const home = join(root, ".imurun")
  mkdirSync(home, { recursive: true })
  process.env.IMURUN_HOME = home
  if (initial) writeFileSync(join(home, "imurun.json"), JSON.stringify(initial, null, 2))
  return home
}

describe("provider presets", () => {
  test("ids are unique and every preset explains itself", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.note.length).toBeGreaterThan(0)
      expect(preset.label.length).toBeGreaterThan(0)
      // A preset is usable when it has a fixed endpoint, asks the user for one,
      // or is served by a dedicated SDK (which knows its own endpoint).
      const sdkBacked = preset.type === "google" || preset.type === "anthropic"
      expect(Boolean(preset.baseURL) || preset.needsBaseURL === true || sdkBacked).toBe(true)
    }
  })

  test("only the self-hosted entry needs a URL from the user", () => {
    const needsURL = PROVIDER_PRESETS.filter((preset) => preset.needsBaseURL)
    expect(needsURL.map((preset) => preset.id)).toEqual(["custom"])
  })

  test("every named service tells the user where to get a key", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === "custom") continue
      expect(preset.console).toBeDefined()
      expect(preset.console!.startsWith("https://")).toBe(true)
    }
  })

  test("the services the wizard advertises are present", () => {
    for (const id of ["openai", "anthropic", "google", "openrouter", "groq", "nvidia"]) {
      expect(getProviderPreset(id)?.id).toBe(id)
    }
  })

  test("lookup is case-insensitive and trims", () => {
    expect(getProviderPreset("  OpenRouter ")?.label).toBe("OpenRouter")
    expect(getProviderPreset("nope")).toBeUndefined()
  })
})

describe("model options while adding a provider", () => {
  const openai = getProviderPreset("openai")!

  test("the endpoint's own list wins, de-duplicated and sorted", () => {
    const options = providerModelOptions(openai, { status: "ready", models: ["gpt-5.2", "gpt-5.1", "gpt-5.2"] })
    expect(options).toEqual(["gpt-5.1", "gpt-5.2"])
  })

  test("falls back to the curated hints when the endpoint cannot answer", () => {
    expect(providerModelOptions(openai, { status: "error", models: [] })).toEqual(openai.models)
    expect(providerModelOptions(openai)).toEqual(openai.models)
  })

  test("an empty but reachable list still falls back rather than offering nothing", () => {
    expect(providerModelOptions(openai, { status: "ready", models: [] })).toEqual(openai.models)
  })
})

describe("global config edits", () => {
  test("adding a provider leaves the rest of the file alone", async () => {
    const home = setupHome({ model: "qwen2.5-coder-7b", theme: { accent: "cyan" } })
    await patchGlobalConfig({
      providers: {
        groq: {
          id: "groq",
          kind: "api",
          type: "groq",
          baseURL: "https://api.groq.com/openai/v1",
          apiKey: "{env:GROQ_API_KEY}",
          models: ["openai/gpt-oss-120b"],
          enabled: true,
        },
      },
    })

    const written = JSON.parse(readFileSync(join(home, "imurun.json"), "utf8"))
    expect(written.model).toBe("qwen2.5-coder-7b")
    expect(written.theme).toEqual({ accent: "cyan" })
    expect(written.providers.groq.type).toBe("groq")
    expect(written.providers.groq.models).toEqual(["openai/gpt-oss-120b"])
  })

  test("a second provider does not drop the first", async () => {
    const home = setupHome()
    await patchGlobalConfig({ providers: { groq: { id: "groq", kind: "api", type: "groq" } } })
    await patchGlobalConfig({ providers: { openai: { id: "openai", kind: "api", type: "openai" } } })
    const written = JSON.parse(readFileSync(join(home, "imurun.json"), "utf8"))
    expect(Object.keys(written.providers).sort()).toEqual(["groq", "openai"])
  })

  test("remembering the model does not add anything else", async () => {
    const home = setupHome({ providers: { groq: { id: "groq", kind: "api", type: "groq" } } })
    await patchGlobalConfig({ model: "groq/openai/gpt-oss-120b" })
    const written = JSON.parse(readFileSync(join(home, "imurun.json"), "utf8"))
    expect(written.model).toBe("groq/openai/gpt-oss-120b")
    expect(written.providers.groq.id).toBe("groq")
  })

  test("removing a provider deletes just that entry", async () => {
    const home = setupHome({
      model: "qwen2.5-coder-7b",
      providers: {
        groq: { id: "groq", kind: "api", type: "groq" },
        openai: { id: "openai", kind: "api", type: "openai" },
      },
    })
    await removeGlobalConfigEntry("providers", "groq")
    const written = JSON.parse(readFileSync(join(home, "imurun.json"), "utf8"))
    expect(Object.keys(written.providers)).toEqual(["openai"])
    expect(written.model).toBe("qwen2.5-coder-7b")
  })

  test("removing something that is not there is a no-op", async () => {
    const home = setupHome({ providers: { groq: { id: "groq", kind: "api", type: "groq" } } })
    const before = readFileSync(join(home, "imurun.json"), "utf8")
    await removeGlobalConfigEntry("providers", "missing")
    expect(readFileSync(join(home, "imurun.json"), "utf8")).toBe(before)
  })

  test("reads a legacy array-shaped permissions block without losing it", async () => {
    const home = setupHome({ permissions: [{ tool: "shell", decision: "allow" }] })
    await patchGlobalConfig({ model: "qwen2.5-coder-7b" })
    const written = JSON.parse(readFileSync(join(home, "imurun.json"), "utf8"))
    expect(written.permissions.rules).toEqual([{ tool: "shell", decision: "allow" }])
    expect(written.model).toBe("qwen2.5-coder-7b")
  })

  test("creates the file when there is none", async () => {
    const home = setupHome()
    await patchGlobalConfig({ model: "qwen2.5-coder-7b" })
    expect(JSON.parse(readFileSync(join(home, "imurun.json"), "utf8")).model).toBe("qwen2.5-coder-7b")
  })
})

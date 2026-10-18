import { describe, expect, test, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, loadFromDiscovered, ConfigError } from "../src/config/loader"
import { discoverConfigs } from "../src/config/discovery"

function setupWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "imurun-config-"))
  const home = join(root, "home")
  const project = join(root, "project")
  const nested = join(project, "packages", "app")
  mkdirSync(join(home, ".imurun"), { recursive: true })
  mkdirSync(nested, { recursive: true })
  process.env.IMURUN_HOME = join(home, ".imurun")
  return { root, home, project, nested }
}

describe("config discovery", () => {
  test("finds global and ancestor project configs", async () => {
    const { project, nested } = setupWorkspace()
    writeFileSync(join(process.env.IMURUN_HOME!, "imurun.json"), JSON.stringify({ model: "global-model" }))
    writeFileSync(join(project, "imurun.json"), JSON.stringify({ model: "project-model" }))

    const found = await discoverConfigs(nested)
    expect(found.length).toBe(2)
    expect(found[0]!.scope).toBe("global")
    expect(found[1]!.scope).toBe("project")
    expect(found[1]!.path).toContain("project")
  })

  test("supports .imurun directory configs and jsonc comments", async () => {
    const { project, nested } = setupWorkspace()
    mkdirSync(join(project, ".imurun"), { recursive: true })
    writeFileSync(
      join(project, ".imurun", "imurun.jsonc"),
      `{
        // project settings
        "model": "jsonc-model",
        "rag": { "watch": false, /* disable watching */ }
      }`,
    )

    const { config, sources } = await loadConfig(nested)
    expect(config.model).toBe("jsonc-model")
    expect(config.rag.watch).toBe(false)
    expect(sources).toHaveLength(1)
  })
})

describe("config merging", () => {
  test("project config overrides global, defaults fill the rest", async () => {
    const { project, nested } = setupWorkspace()
    writeFileSync(
      join(process.env.IMURUN_HOME!, "imurun.json"),
      JSON.stringify({ model: "global-model", runtime: { port: 41000 }, rag: { watch: true } }),
    )
    writeFileSync(
      join(project, "imurun.json"),
      JSON.stringify({ model: "project-model", runtime: { idleUnloadMinutes: 3 } }),
    )

    const { config } = await loadConfig(nested)
    expect(config.model).toBe("project-model")
    expect(config.runtime.port).toBe(41000) // from global
    expect(config.runtime.idleUnloadMinutes).toBe(3) // from project
    expect(config.rag.watch).toBe(true) // from global
    expect(config.runtime.engine).toBe("llama-cpp") // built-in default
  })

  test("inline overrides win over everything", async () => {
    const { project, nested } = setupWorkspace()
    writeFileSync(join(project, "imurun.json"), JSON.stringify({ model: "project-model" }))

    const { config } = await loadConfig(nested, { model: "override-model" })
    expect(config.model).toBe("override-model")
  })

  test("invalid config throws ConfigError with path", async () => {
    const { project, nested } = setupWorkspace()
    writeFileSync(join(project, "imurun.json"), JSON.stringify({ runtime: { port: 12 } }))

    try {
      await loadConfig(nested)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).path).toContain("imurun.json")
    }
  })

  test("loadFromDiscovered works with no files at all", async () => {
    const { loaded } = await import("../src/config/loader").then((m) =>
      m.loadConfigSafe("C:\\definitely\\not\\a\\real\\dir"),
    )
    expect(loaded.config.runtime.engine).toBe("llama-cpp")
  })

  test("loadFromDiscovered merges explicit sources", async () => {
    const { home } = setupWorkspace()
    const a = join(home, "a.json")
    const b = join(home, "b.json")
    writeFileSync(a, JSON.stringify({ model: "a", rag: { autoInject: false } }))
    writeFileSync(b, JSON.stringify({ model: "b" }))

    const { config } = await loadFromDiscovered([
      { path: a, scope: "global" },
      { path: b, scope: "project" },
    ])
    expect(config.model).toBe("b")
    expect(config.rag.autoInject).toBe(false)
  })

  test("an old-style permissions array still loads as rules", async () => {
    const { home } = setupWorkspace()
    const path = join(home, "legacy.json")
    writeFileSync(path, JSON.stringify({ permissions: [{ tool: "shell", action: "deny" }] }))

    const { config } = await loadFromDiscovered([{ path, scope: "project" }])

    expect(config.permissions.rules).toHaveLength(1)
    expect(config.permissions.rules[0]!.tool).toBe("shell")
    // and the approval mode is the new default
    expect(config.permissions.mode).toBe("auto")
  })
})

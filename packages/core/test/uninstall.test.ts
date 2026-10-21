/**
 * Uninstalling without losing anything that took hours to download.
 *
 * Every command runner is injected: these tests must never run a real
 * `npm uninstall -g` on the machine that is running them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { uninstall } from "../src/uninstall"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "imurun-uninstall-"))
  process.env.IMURUN_HOME = home
})

afterEach(() => {
  delete process.env.IMURUN_HOME
  delete process.env.IMURUN_PYTHON
  rmSync(home, { recursive: true, force: true })
})

/** A record of the commands an uninstall tried to run. */
function recorder(outcome = true): { calls: string[]; run: (command: string, args: string[]) => boolean } {
  const calls: string[] = []
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args].join(" "))
      return outcome
    },
  }
}

describe("uninstall: what is removed", () => {
  test("npm takes the package away", () => {
    const { calls, run } = recorder()
    const result = uninstall({ method: "npm", run, npmCommand: "npm" })
    expect(calls[0]).toBe("npm uninstall -g imurun")
    expect(result.removed).toContain("the npm package")
    expect(result.errors).toEqual([])
  })

  test("Bun and pnpm remove through their own global list", () => {
    const bun = recorder()
    expect(uninstall({ method: "bun", run: bun.run, npmCommand: "npm" }).removed).toContain("the bun package")
    expect(bun.calls[0]).toStartWith("bun")
    expect(bun.calls[0]).toEndWith("remove -g imurun")

    const pnpm = recorder()
    expect(uninstall({ method: "pnpm", run: pnpm.run, npmCommand: "npm" }).removed).toContain("the pnpm package")
    expect(pnpm.calls[0]).toStartWith("pnpm")
    expect(pnpm.calls[0]).toEndWith("remove -g imurun")
  })

  test("pip uninstalls with the interpreter that installed it", () => {
    process.env.IMURUN_PYTHON = "/venv/bin/python"
    const { calls, run } = recorder()
    const result = uninstall({ method: "pip", run, npmCommand: "npm" })
    expect(calls[0]).toBe("/venv/bin/python -m pip uninstall -y imurun")
    expect(result.removed).toContain("the pip package")
  })

  test("a binary removes the program that is running", () => {
    const removed: string[] = []
    const result = uninstall({
      method: "binary",
      run: () => true,
      removeSelf: (target) => {
        removed.push(target)
        return { removed: true, pending: `${target}.old-1-1` }
      },
    })
    expect(removed).toEqual([process.execPath])
    expect(result.removed.some((item) => item.startsWith("the program"))).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.notes.join(" ")).toContain("after this process exits")
  })

  test("a binary that cannot be removed is an error, not a silent success", () => {
    const result = uninstall({
      method: "binary",
      run: () => true,
      removeSelf: () => ({ removed: false, error: "access denied" }),
    })
    expect(result.removed).toEqual([])
    expect(result.errors.join(" ")).toContain("access denied")
  })

  test("a source checkout is never deleted", () => {
    const { calls, run } = recorder()
    const result = uninstall({ method: "source", run, npmCommand: "npm" })
    expect(result.removed).toEqual([])
    expect(calls).toEqual([])
    expect(result.notes.join(" ")).toContain("source checkout")
  })

  test("an npx copy has nothing to remove", () => {
    const result = uninstall({ method: "ephemeral", run: () => true })
    expect(result.removed).toEqual([])
    expect(result.notes.join(" ")).toContain("npx")
  })
})

describe("uninstall: what is kept", () => {
  test("the models and memory stay unless --purge is given", () => {
    mkdirSync(join(home, "models"), { recursive: true })
    writeFileSync(join(home, "models", "qwen.gguf"), "4 GB of model")
    mkdirSync(join(home, "memory"), { recursive: true })

    const result = uninstall({ method: "npm", run: () => true, npmCommand: "npm" })
    expect(result.kept.join(" ")).toContain("models, memory, sessions and configuration")
    expect(result.kept.some((item) => item.endsWith("models"))).toBe(true)
    expect(existsSync(join(home, "models", "qwen.gguf"))).toBe(true)
  })

  test("--purge removes the data, and says so", () => {
    mkdirSync(join(home, "models"), { recursive: true })
    writeFileSync(join(home, "models", "qwen.gguf"), "4 GB of model")

    const result = uninstall({ method: "npm", purge: true, run: () => true, npmCommand: "npm" })
    expect(result.removed).toContain("models, memory, sessions and configuration")
    expect(existsSync(home)).toBe(false)
  })

  test("the cached executable the pip launcher downloaded is program, not data", () => {
    mkdirSync(join(home, "python"), { recursive: true })
    writeFileSync(join(home, "python", "imurun-linux-x64"), "the program")

    const result = uninstall({ method: "pip", run: () => true, npmCommand: "npm" })
    expect(result.removed).toContain("the downloaded executable")
    expect(existsSync(join(home, "python"))).toBe(false)
  })
})

describe("uninstall: dry run", () => {
  test("says what would go and changes nothing", () => {
    mkdirSync(join(home, "models"), { recursive: true })
    const { calls, run } = recorder()
    const result = uninstall({ method: "npm", dryRun: true, run, npmCommand: "npm" })
    expect(calls).toEqual([])
    expect(result.removed).toContain("the npm package (npm uninstall -g imurun)")
    expect(result.kept.join(" ")).toContain("models")
    expect(existsSync(join(home, "models"))).toBe(true)
  })
})

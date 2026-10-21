/**
 * Upgrading IMURUN however it was installed.
 *
 * The point of these tests is the matrix: npm, Bun, pnpm, pip, a downloaded
 * binary, a source checkout, an npx copy. Each one has to produce the right
 * plan, and the binary path has to actually replace the file without ever
 * writing something that is not a program.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cleanupStaleExecutables,
  looksExecutable,
  removeExecutable,
  replaceExecutable,
} from "../src/executable"
import {
  downloadUrl,
  detectInstallMethod,
  gitHubAsset,
  planUpdate,
  probeInstallMethod,
  runUpdate,
  sourceRoot,
} from "../src/update"

const directories: string[] = []

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "imurun-upgrade-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A payload that passes the "is this a program" check. */
function programBytes(size = 600 * 1024): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes[0] = 0x4d // M
  bytes[1] = 0x5a // Z
  return bytes
}

function elfBytes(size = 600 * 1024): Uint8Array {
  const bytes = programBytes(size)
  bytes[0] = 0x7f
  bytes[1] = 0x45 // E
  bytes[2] = 0x4c // L
  bytes[3] = 0x46 // F
  return bytes
}

const ELF = elfBytes(128)

describe("looksExecutable", () => {
  test("accepts the magic number for the platform", () => {
    expect(looksExecutable(programBytes(), "win32")).toBe(true)
    expect(looksExecutable(ELF, "linux")).toBe(true)
  })

  test("rejects an HTML error page, whatever the platform", () => {
    const page = new TextEncoder().encode(`<!doctype html><html><body>404</body></html>`.padEnd(200, " "))
    for (const platform of ["win32", "linux", "darwin"] as NodeJS.Platform[]) {
      expect(looksExecutable(page, platform)).toBe(false)
    }
  })

  test("rejects a payload that is too short to be a program", () => {
    expect(looksExecutable(new Uint8Array([0x4d, 0x5a]), "win32")).toBe(false)
  })
})

describe("replaceExecutable", () => {
  test("swaps the program and leaves the new one in place", () => {
    const directory = workspace()
    const target = join(directory, "imurun.exe")
    writeFileSync(target, "old program")

    const result = replaceExecutable(target, programBytes(), "win32")
    expect(result.replaced).toBe(true)
    expect(readFileSync(target)[0]).toBe(0x4d)
    expect(readFileSync(target)[1]).toBe(0x5a)
  })

  test("on POSIX it writes beside the target and renames it over", () => {
    const directory = workspace()
    const target = join(directory, "imurun")
    writeFileSync(target, "old program")

    replaceExecutable(target, ELF, "linux")
    expect(readFileSync(target)[0]).toBe(0x7f)
    // No half-written sibling is left over.
    expect(cleanupStaleExecutables(directory, "linux").length).toBe(0)
  })

  test("a download that is not a program is refused, and the old one survives", () => {
    const directory = workspace()
    const target = join(directory, "imurun.exe")
    writeFileSync(target, "old program")
    const page = new TextEncoder().encode("<html>nope</html>".padEnd(200, " "))

    expect(() => replaceExecutable(target, page, "win32")).toThrow(/not a program/)
    expect(readFileSync(target, "utf8")).toBe("old program")
  })
})

describe("removeExecutable", () => {
  test("removes a program that is not running", () => {
    const directory = workspace()
    const target = join(directory, "imurun")
    writeFileSync(target, ELF)
    const result = removeExecutable(target, "linux")
    expect(result.removed).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  test("on Windows the running program is renamed, then the path is free", () => {
    const directory = workspace()
    const target = join(directory, "imurun.exe")
    writeFileSync(target, programBytes())
    const result = removeExecutable(target, "win32")
    expect(result.removed).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  test("a missing program counts as removed", () => {
    expect(removeExecutable(join(workspace(), "nothing-here"), "linux").removed).toBe(true)
  })
})

describe("cleanupStaleExecutables", () => {
  test("removes the leftovers of an update and nothing else", () => {
    const directory = workspace()
    writeFileSync(join(directory, "imurun.exe"), programBytes())
    writeFileSync(join(directory, "imurun.exe.old-99-1"), "old")
    writeFileSync(join(directory, "imurun.exe.new-99-2"), "partial")
    writeFileSync(join(directory, "notes.txt"), "keep me")

    const removed = cleanupStaleExecutables(directory, "win32").map((path) => path.split(/[\\/]/).pop())
    expect(removed.sort()).toEqual(["imurun.exe.new-99-2", "imurun.exe.old-99-1"])
    expect(existsSync(join(directory, "imurun.exe"))).toBe(true)
    expect(existsSync(join(directory, "notes.txt"))).toBe(true)
  })
})

describe("detectInstallMethod", () => {
  test("an environment variable from the installer wins", () => {
    expect(detectInstallMethod({ env: { IMURUN_INSTALL: "pip" } })).toBe("pip")
    expect(detectInstallMethod({ env: { IMURUN_INSTALL: "binary" } })).toBe("binary")
    expect(detectInstallMethod({ env: { IMURUN_INSTALL: "nonsense" }, execPath: "C:/x/bun.exe" })).toBe("unknown")
  })

  test("a path in node_modules is an npm-style install", () => {
    expect(
      detectInstallMethod({
        execPath: "C:/Users/me/AppData/Roaming/npm/node_modules/bun/bin/bun.exe",
        argv1: "C:/Users/me/AppData/Roaming/npm/node_modules/imurun/bin/imurun.js",
        env: {},
      }),
    ).toBe("npm")
  })

  test("Bun and pnpm global installs are told apart from npm", () => {
    expect(
      detectInstallMethod({
        execPath: "/Users/me/.bun/bin/bun",
        argv1: "/Users/me/.bun/install/global/node_modules/imurun/bin/imurun.js",
        env: {},
      }),
    ).toBe("bun")
    expect(
      detectInstallMethod({
        execPath: "/usr/bin/node",
        argv1: "/Users/me/Library/pnpm/global/5/node_modules/imurun/bin/imurun.js",
        env: {},
      }),
    ).toBe("pnpm")
  })

  test("an npx copy is ephemeral, not an installation", () => {
    expect(
      detectInstallMethod({
        execPath: "/usr/bin/node",
        argv1: "/Users/me/.npm/_npx/1234/node_modules/imurun/bin/imurun.js",
        env: {},
      }),
    ).toBe("ephemeral")
  })

  test("a source checkout is recognised by its shape", () => {
    expect(
      detectInstallMethod({
        execPath: "C:/Users/imu/AppData/Roaming/npm/node_modules/bun/bin/bun.exe",
        argv1: "C:/work/imurun/packages/cli/src/index.ts",
        env: {},
      }),
    ).toBe("source")
  })

  test("a compiled program is any executable that is not a JavaScript runtime", () => {
    expect(
      detectInstallMethod({
        execPath: "C:/Tools/imurun-windows-x64.exe",
        argv1: "",
        env: {},
        compiled: true,
      }),
    ).toBe("binary")
  })

  test("running under Bun is never mistaken for a compiled program", () => {
    expect(
      detectInstallMethod({ execPath: "/usr/local/bin/bun", argv1: "/tmp/thing.js", env: {}, compiled: true }),
    ).toBe("unknown")
  })

  test("a virtualenv around an installed copy means pip", () => {
    expect(detectInstallMethod({ execPath: "/usr/bin/python3", argv1: "/opt/tool", env: { VIRTUAL_ENV: "/venv" } })).toBe(
      "pip",
    )
  })
})

describe("probeInstallMethod", () => {
  test("asks npm first, then Bun and pnpm, then pip", () => {
    const asked: string[] = []
    const method = probeInstallMethod({
      platform: "linux",
      run: (command, args) => {
        asked.push([command, ...args].join(" "))
        return command === "pnpm" ? 0 : 1
      },
    })
    expect(method).toBe("pnpm")
    expect(asked[0]).toStartWith("npm ls -g")
  })

  test("pip answers when no JavaScript package manager owns it", () => {
    const method = probeInstallMethod({
      platform: "linux",
      env: { IMURUN_PYTHON: "/venv/bin/python" },
      run: (command, args) => (command === "/venv/bin/python" && args[0] === "-m" ? 0 : 1),
    })
    expect(method).toBe("pip")
  })

  test("nothing owning it is unknown, not a guess", () => {
    expect(probeInstallMethod({ platform: "linux", run: () => 1 })).toBe("unknown")
  })
})

describe("release asset names", () => {
  test("match the names the release publishes", () => {
    expect(gitHubAsset("win32", "x64")).toBe("imurun-windows-x64.exe")
    expect(gitHubAsset("linux", "x64")).toBe("imurun-linux-x64")
    expect(gitHubAsset("darwin", "arm64")).toBe("imurun-darwin-arm64")
    // A 32-bit machine gets the x64 build; there is no 32-bit one.
    expect(gitHubAsset("linux", "ia32")).toBe("imurun-linux-x64")
  })

  test("the download URL is pinned to the version when there is one", () => {
    expect(downloadUrl("0.2.0", "imurun-linux-x64")).toBe(
      "https://github.com/shubham001312/imurun/releases/download/v0.2.0/imurun-linux-x64",
    )
    expect(downloadUrl(undefined, "imurun-linux-x64")).toEndWith("/releases/latest/download/imurun-linux-x64")
  })
})

describe("sourceRoot", () => {
  test("is the checkout a CLI entry point belongs to", () => {
    expect(sourceRoot("C:/work/imurun/packages/cli/src/index.ts")).toBe("C:/work/imurun")
    expect(sourceRoot("/home/me/imurun/packages/cli/src/index.ts")).toBe("/home/me/imurun")
    expect(sourceRoot("bun")).toBeUndefined()
  })
})

describe("planUpdate", () => {
  test("npm gets the registry install, with the release tarball as a fallback", () => {
    const plan = planUpdate("0.1.0", { method: "npm", latest: "0.2.0", platform: "linux" })
    expect(plan.kind).toBe("npm")
    expect(plan.command).toEqual({ command: "npm", args: ["install", "-g", "imurun@latest"] })
    expect(plan.fallback?.args.join(" ")).toContain("imurun-npm.tgz")
  })

  test("Bun and pnpm use their own global add", () => {
    expect(planUpdate("0.1.0", { method: "bun", platform: "linux" }).command).toEqual({
      command: "bun",
      args: ["add", "-g", "imurun@latest"],
    })
    expect(planUpdate("0.1.0", { method: "pnpm", platform: "linux" }).command).toEqual({
      command: "pnpm",
      args: ["add", "-g", "imurun@latest"],
    })
  })

  test("pip uses the interpreter that installed it, never the program itself", () => {
    const plan = planUpdate("0.1.0", {
      method: "pip",
      latest: "0.2.0",
      platform: "linux",
      env: { IMURUN_PYTHON: "/venv/bin/python" },
    })
    expect(plan.kind).toBe("pip")
    expect(plan.command).toEqual({
      command: "/venv/bin/python",
      args: ["-m", "pip", "install", "--upgrade", "imurun"],
    })
    expect(plan.fallback?.args).toContain("--user")
  })

  test("a binary is replaced from the release, not from a package manager", () => {
    const plan = planUpdate("0.1.0", {
      method: "binary",
      latest: "0.2.0",
      platform: "win32",
      arch: "x64",
      execPath: "C:/Tools/imurun.exe",
    })
    expect(plan.kind).toBe("binary")
    expect(plan.download?.url).toBe(
      "https://github.com/shubham001312/imurun/releases/download/v0.2.0/imurun-windows-x64.exe",
    )
    expect(plan.download?.target).toBe("C:/Tools/imurun.exe")
  })

  test("a source checkout is updated with git and bun", () => {
    const plan = planUpdate("0.1.0", {
      method: "source",
      argv1: "C:/work/imurun/packages/cli/src/index.ts",
    })
    expect(plan.kind).toBe("source")
    expect(plan.sourceRoot).toBe("C:/work/imurun")
    expect(plan.command).toEqual({ command: "git", args: ["-C", "C:/work/imurun", "pull", "--ff-only"] })
    expect(plan.fallback).toEqual({ command: "bun", args: ["install"], cwd: "C:/work/imurun" })
  })

  test("an npx copy is told what to do instead of being overwritten", () => {
    const plan = planUpdate("0.1.0", { method: "ephemeral" })
    expect(plan.kind).toBe("manual")
    expect(plan.manual).toContain("npx imurun@latest")
  })

  test("an unknown install is honest about it", () => {
    const plan = planUpdate("0.1.0", { method: "unknown" })
    expect(plan.kind).toBe("manual")
    expect(plan.manual).toContain("releases/latest")
  })
})

describe("runUpdate", () => {
  test("a dry run decides and does nothing", async () => {
    const ran: string[] = []
    const result = await runUpdate("0.1.0", {
      method: "npm",
      latest: "0.2.0",
      dryRun: true,
      platform: "linux",
      run: (spec) => {
        ran.push(spec.command)
        return true
      },
    })
    expect(result.performed).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.message).toContain("dry run")
    expect(ran).toEqual([])
  })

  test("npm installs, and says which command did it", async () => {
    const ran: string[] = []
    const result = await runUpdate("0.1.0", {
      method: "npm",
      latest: "0.2.0",
      platform: "linux",
      run: (spec) => {
        ran.push([spec.command, ...spec.args].join(" "))
        return true
      },
    })
    expect(result.ok).toBe(true)
    expect(result.to).toBe("0.2.0")
    expect(result.command).toBe("npm install -g imurun@latest")
    expect(ran).toHaveLength(1)
  })

  test("when the registry fails, the GitHub tarball is tried", async () => {
    const ran: string[] = []
    const result = await runUpdate("0.1.0", {
      method: "npm",
      latest: "0.2.0",
      platform: "linux",
      run: (spec) => {
        const line = [spec.command, ...spec.args].join(" ")
        ran.push(line)
        return line.includes("imurun-npm.tgz")
      },
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain("GitHub release")
    expect(ran).toHaveLength(2)
  })

  test("when both fail it explains the by-hand command", async () => {
    const result = await runUpdate("0.1.0", {
      method: "npm",
      latest: "0.2.0",
      platform: "linux",
      run: () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("npm install -g imurun@latest")
  })

  test("pip upgrades the launcher and says the program arrives next start", async () => {
    const result = await runUpdate("0.1.0", {
      method: "pip",
      latest: "0.2.0",
      platform: "linux",
      env: { IMURUN_PYTHON: "/venv/bin/python" },
      run: () => true,
    })
    expect(result.ok).toBe(true)
    expect(result.command).toBe("/venv/bin/python -m pip install --upgrade imurun")
    expect(result.message).toContain("next start")
  })

  test("a binary is downloaded and put in place", async () => {
    const directory = workspace()
    const target = join(directory, "imurun.exe")
    writeFileSync(target, "the old program".padEnd(64, " "))

    const result = await runUpdate("0.1.0", {
      method: "binary",
      latest: "0.2.0",
      platform: "win32",
      arch: "x64",
      execPath: target,
      fetchImpl: (async () => new Response(programBytes())) as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    expect(result.command).toContain("releases/download/v0.2.0/imurun-windows-x64.exe")
    expect(readFileSync(target)[0]).toBe(0x4d)
    expect(result.message).toContain("start IMURUN again")
  })

  test("a POSIX binary is swapped in the same way", async () => {
    const directory = workspace()
    const target = join(directory, "imurun")
    writeFileSync(target, "the old program".padEnd(64, " "))

    const result = await runUpdate("0.1.0", {
      method: "binary",
      latest: "0.2.0",
      platform: "linux",
      arch: "x64",
      execPath: target,
      fetchImpl: (async () => new Response(elfBytes())) as unknown as typeof fetch,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(target)[0]).toBe(0x7f)
  })

  test("a download that is not a program never replaces the program", async () => {
    const directory = workspace()
    const target = join(directory, "imurun-windows-x64.exe")
    writeFileSync(target, "the old program".padEnd(64, " "))

    const result = await runUpdate("0.1.0", {
      method: "binary",
      latest: "0.2.0",
      platform: "linux",
      arch: "x64",
      execPath: target,
      fetchImpl: (async () =>
        new Response("<html>captive portal</html>".padEnd(600 * 1024, " "))) as unknown as typeof fetch,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("could not replace")
    expect(readFileSync(target, "utf8")).toStartWith("the old program")
  })

  test("a source checkout is pulled and installed", async () => {
    const ran: string[] = []
    const result = await runUpdate("0.1.0", {
      method: "source",
      argv1: "/home/me/imurun/packages/cli/src/index.ts",
      run: (spec) => {
        ran.push([spec.command, ...spec.args].join(" "))
        return true
      },
    })
    expect(result.ok).toBe(true)
    expect(ran).toEqual(["git -C /home/me/imurun pull --ff-only", "bun install"])
  })

  test("a diverged checkout says so instead of pretending", async () => {
    const result = await runUpdate("0.1.0", {
      method: "source",
      argv1: "/home/me/imurun/packages/cli/src/index.ts",
      run: (spec) => spec.command !== "git",
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("fast-forward")
  })

  test("an npx copy is never installed over", async () => {
    const result = await runUpdate("0.1.0", { method: "ephemeral", run: () => true })
    expect(result.ok).toBe(false)
    expect(result.performed).toBe(false)
    expect(result.message).toContain("npx imurun@latest")
  })
})

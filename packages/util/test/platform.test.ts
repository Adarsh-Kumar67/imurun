import { describe, expect, test } from "bun:test"
import { resolveShell } from "../src/platform"

describe("resolveShell", () => {
  test("always names a shell and the arguments that precede a command", () => {
    const shell = resolveShell()
    expect(typeof shell.shell).toBe("string")
    expect(shell.shell.length).toBeGreaterThan(0)
    expect(shell.args.length).toBeGreaterThan(0)
    expect(typeof shell.posix).toBe("boolean")
    expect(shell.label.length).toBeGreaterThan(0)
  })

  test("is detected once, so every command uses the same shell", () => {
    expect(resolveShell()).toBe(resolveShell())
  })

  test("prefers a POSIX shell, so grep/sed/cat work like a coding model expects", () => {
    const shell = resolveShell()
    if (process.platform === "win32") {
      // Windows only falls back to cmd when no POSIX shell is installed at all.
      if (!shell.posix) expect(shell.label.toLowerCase()).toContain("cmd")
      else expect(shell.label.toLowerCase()).toContain("bash")
      return
    }
    expect(shell.posix).toBe(true)
    expect(shell.args).toContain("-c")
  })

  test("never hands commands to the Store's WSL stub on Windows", () => {
    if (process.platform !== "win32") return
    expect(resolveShell().shell.toLowerCase()).not.toContain("windowsapps")
  })
})

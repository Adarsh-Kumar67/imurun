/**
 * The clipboard path, without a clipboard.
 *
 * Every branch is driven through injected lookups and runners, so the tests say
 * what happens when a tool is missing or fails — the cases a real machine only
 * shows you the first time you run IMURUN over SSH.
 */
import { describe, expect, test } from "bun:test"
import { clipboardCommand, copyToClipboard } from "../src/clipboard"
import { existsSync, readFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function finder(installed: string[]) {
  return (name: string) => (installed.includes(name) ? `/bin/${name}` : undefined)
}

describe("clipboardCommand", () => {
  test("Windows asks clip", () => {
    expect(clipboardCommand({ os: "windows", find: finder(["clip.exe"]) })).toEqual({
      command: ["/bin/clip.exe"],
      label: "clip",
    })
    expect(clipboardCommand({ os: "windows", find: () => undefined })).toBeUndefined()
  })

  test("macOS has pbcopy even when PATH is bare", () => {
    expect(clipboardCommand({ os: "macos", find: () => undefined })).toEqual({
      command: ["/usr/bin/pbcopy"],
      label: "pbcopy",
    })
  })

  test("Linux takes the first of three, and admits when there is none", () => {
    expect(clipboardCommand({ os: "linux", find: finder(["xclip"]) })).toEqual({
      command: ["/bin/xclip", "-selection", "clipboard"],
      label: "xclip",
    })
    expect(clipboardCommand({ os: "linux", find: finder(["xsel"]) })).toEqual({
      command: ["/bin/xsel", "--clipboard", "--input"],
      label: "xsel",
    })
    expect(clipboardCommand({ os: "linux", find: () => undefined })).toBeUndefined()
  })
})

describe("copyToClipboard", () => {
  test("pipes the text into the platform tool", async () => {
    const sent: Array<{ command: string[]; input: string }> = []
    const result = await copyToClipboard("hello clipboard", {
      os: "macos",
      find: () => "/usr/bin/pbcopy",
      run: async (command, input) => {
        sent.push({ command, input })
        return { code: 0, stderr: "" }
      },
    })
    expect(result).toEqual({ ok: true, via: "pbcopy" })
    expect(sent[0]?.input).toBe("hello clipboard")
  })

  test("a failing tool falls back to a file, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imurun-clip-"))
    const result = await copyToClipboard("keep this", {
      os: "windows",
      find: () => "/bin/clip.exe",
      run: async () => ({ code: 1, stderr: "access denied" }),
      fallbackDir: dir,
    })
    expect(result.ok).toBe(false)
    expect(result.via).toBe("file")
    expect(result.error).toContain("clip exited with code 1: access denied")
    expect(result.fallbackPath).toBeTruthy()
    expect(existsSync(result.fallbackPath!)).toBe(true)
    expect(readFileSync(result.fallbackPath!, "utf8")).toBe("keep this")
  })

  test("no tool at all still ends with the text on disk when a directory is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imurun-clip-"))
    const result = await copyToClipboard("offline copy", {
      os: "linux",
      find: () => undefined,
      fallbackDir: dir,
      fallbackName: "answer",
    })
    expect(result.via).toBe("file")
    expect(result.fallbackPath).toContain("answer-")
    expect(readFileSync(result.fallbackPath!, "utf8")).toBe("offline copy")
  })

  test("without a fallback directory it reports the failure instead", async () => {
    const result = await copyToClipboard("nowhere to go", { os: "linux", find: () => undefined })
    expect(result).toEqual({
      ok: false,
      via: "none",
      error: "no clipboard tool is installed on this machine",
    })
  })
})

import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@imurun/util"
import { readTool, writeTool, editTool, shellTool, globTool, grepTool } from "../src/tool"
import type { ToolContext } from "../src/tool/types"

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imurun-tools-"))
  ctx = { workingDir: dir, sessionId: "ses_test", log: createLogger("test") }
})

describe("read tool", () => {
  test("reads a file with line numbers", async () => {
    writeFileSync(join(dir, "hello.txt"), "alpha\nbeta\ngamma\n")
    const result = await readTool.execute({ path: "hello.txt" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("1\u2502 alpha")
    expect(result.output).toContain("3\u2502 gamma")
  })

  test("offset and limit windows", async () => {
    writeFileSync(join(dir, "many.txt"), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"))
    const result = await readTool.execute({ path: "many.txt", offset: 10, limit: 3 }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("line 10")
    expect(result.output).toContain("line 12")
    expect(result.output).not.toContain("line 13")
    expect(result.output).toContain("showing lines 10-12 of 50")
  })

  test("reports missing files", async () => {
    const result = await readTool.execute({ path: "nope.txt" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("File not found")
  })

  test("detects binary files", async () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]))
    const result = await readTool.execute({ path: "bin.dat" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Binary")
  })

  test("rejects directories", async () => {
    mkdirSync(join(dir, "subdir"))
    const result = await readTool.execute({ path: "subdir" }, ctx)
    expect(result.ok).toBe(false)
  })
})

describe("write tool", () => {
  test("creates files and parent directories", async () => {
    const result = await writeTool.execute({ path: "nested/deep/new.txt", content: "hello world" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Created")
    expect(readFileSync(join(dir, "nested", "deep", "new.txt"), "utf8")).toBe("hello world")
  })

  test("overwrites existing files", async () => {
    writeFileSync(join(dir, "existing.txt"), "old")
    const result = await writeTool.execute({ path: "existing.txt", content: "new" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Updated")
    expect(readFileSync(join(dir, "existing.txt"), "utf8")).toBe("new")
  })

  test("rejects missing content", async () => {
    const result = await writeTool.execute({ path: "x.txt" }, ctx)
    expect(result.ok).toBe(false)
  })

  test("append adds to the end, inserting a newline when one is missing", async () => {
    writeFileSync(join(dir, "story.md"), "# Chapter one\nsome words")
    const result = await writeTool.execute({ path: "story.md", content: "## Chapter two", mode: "append" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("Appended")
    expect(readFileSync(join(dir, "story.md"), "utf8")).toBe("# Chapter one\nsome words\n## Chapter two")
  })

  test("append creates the file when it does not exist yet", async () => {
    const result = await writeTool.execute({ path: "fresh.txt", content: "first", mode: "append" }, ctx)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "fresh.txt"), "utf8")).toBe("first")
  })

  test("create refuses to clobber an existing file", async () => {
    writeFileSync(join(dir, "keep.txt"), "precious")
    const result = await writeTool.execute({ path: "keep.txt", content: "gone", mode: "create" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("already exists")
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("precious")
  })

  test("create writes a new file and reports its size", async () => {
    const result = await writeTool.execute({ path: "new.ts", content: "export const a = 1\n", mode: "create" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ path: "new.ts", mode: "create" })
    const data = result.data as { bytes: number; lines: number }
    expect(data.bytes).toBeGreaterThan(0)
    expect(data.lines).toBe(2)
  })
})

describe("edit tool", () => {
  test("replaces unique occurrences", async () => {
    writeFileSync(join(dir, "code.ts"), "const a = 1\nconst b = 2\n")
    const result = await editTool.execute(
      { path: "code.ts", oldString: "const b = 2", newString: "const b = 42" },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("line 2")
    expect(readFileSync(join(dir, "code.ts"), "utf8")).toBe("const a = 1\nconst b = 42\n")
  })

  test("refuses ambiguous matches without replaceAll", async () => {
    writeFileSync(join(dir, "dup.txt"), "same\nsame\n")
    const result = await editTool.execute({ path: "dup.txt", oldString: "same", newString: "diff" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("2 times")
    expect(readFileSync(join(dir, "dup.txt"), "utf8")).toBe("same\nsame\n")
  })

  test("replaceAll replaces every occurrence", async () => {
    writeFileSync(join(dir, "dup.txt"), "same\nsame\n")
    const result = await editTool.execute(
      { path: "dup.txt", oldString: "same", newString: "diff", replaceAll: true },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "dup.txt"), "utf8")).toBe("diff\ndiff\n")
  })

  test("fails when oldString is absent", async () => {
    writeFileSync(join(dir, "f.txt"), "hello")
    const result = await editTool.execute({ path: "f.txt", oldString: "goodbye", newString: "hi" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not found")
  })

  test("fails on no-op edits", async () => {
    writeFileSync(join(dir, "f.txt"), "hello")
    const result = await editTool.execute({ path: "f.txt", oldString: "hello", newString: "hello" }, ctx)
    expect(result.ok).toBe(false)
  })
})

describe("glob tool", () => {
  test("finds files by pattern, newest first", async () => {
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "a.ts"), "a")
    writeFileSync(join(dir, "src", "b.ts"), "b")
    writeFileSync(join(dir, "src", "c.js"), "c")

    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("src/a.ts")
    expect(result.output).toContain("src/b.ts")
    expect(result.output).not.toContain("c.js")
  })

  test("ignores node_modules", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x")
    writeFileSync(join(dir, "app.js"), "y")

    const result = await globTool.execute({ pattern: "**/*.js" }, ctx)
    expect(result.output).toContain("app.js")
    expect(result.output).not.toContain("node_modules")
  })
})

describe("grep tool", () => {
  test("finds matching lines with file and line number", async () => {
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "auth.ts"), "function login() {\n  return 42\n}\n")
    writeFileSync(join(dir, "src", "other.ts"), "nothing here\n")

    const result = await grepTool.execute({ pattern: "function login" }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("src/auth.ts")
    expect(result.output).toContain("1\u2502 function login")
  })

  test("include filter narrows files", async () => {
    writeFileSync(join(dir, "a.ts"), "TODO fix\n")
    writeFileSync(join(dir, "b.md"), "TODO fix\n")

    const result = await grepTool.execute({ pattern: "TODO", include: "*.ts" }, ctx)
    expect(result.output).toContain("a.ts")
    expect(result.output).not.toContain("b.md")
  })

  test("caseInsensitive search", async () => {
    writeFileSync(join(dir, "x.txt"), "Hello World\n")
    const sensitive = await grepTool.execute({ pattern: "hello" }, ctx)
    expect(sensitive.output).toContain("No matches")

    const insensitive = await grepTool.execute({ pattern: "hello", caseSensitive: false }, ctx)
    expect(insensitive.output).toContain("Hello World")
  })

  test("invalid regex is reported", async () => {
    const result = await grepTool.execute({ pattern: "([unclosed" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Invalid regular expression")
  })
})

describe("shell tool", () => {
  test("runs commands and captures stdout", async () => {
    const command = process.platform === "win32" ? "echo hello-imurun" : "echo hello-imurun"
    const result = await shellTool.execute({ command }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain("hello-imurun")
  })

  test("reports non-zero exit codes", async () => {
    const command = process.platform === "win32" ? "exit /b 3" : "exit 3"
    const result = await shellTool.execute({ command }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("exit code 3")
  })

  test("times out long commands", async () => {
    const command = process.platform === "win32" ? "ping -n 6 127.0.0.1 >nul" : "sleep 5"
    const result = await shellTool.execute({ command, timeoutMs: 800 }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("timed out")
  }, 10_000)

  test("runs in the working directory", async () => {
    const command = process.platform === "win32" ? "cd" : "pwd"
    const result = await shellTool.execute({ command }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output.toLowerCase()).toContain(dir.toLowerCase())
  })
})

import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@imurun/util"
import { modelSeesImages } from "../src/agent/vision"
import { toModelMessage } from "../src/agent/context"
import { createScreenshotTool } from "../src/tool/screenshot"
import { readTool } from "../src/tool/read"
import type { ToolContext } from "../src/tool/types"
import type { Message } from "@imurun/schema"

let dir: string
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "imurun-vision-"))
  ctx = { workingDir: dir, sessionId: "ses_test", log: createLogger("test") }
})

/** A 640×480 PNG, complete enough for the header reader. */
function pngBytes(width = 640, height = 480): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  Buffer.from([0, 0, 0, 13]).copy(bytes, 8)
  Buffer.from([0x49, 0x48, 0x44, 0x52]).copy(bytes, 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe("modelSeesImages", () => {
  test("knows the open-weight vision families", () => {
    expect(modelSeesImages("qwen2.5-vl-7b")).toBe(true)
    expect(modelSeesImages("llava-1.6-13b")).toBe(true)
    expect(modelSeesImages("moondream2")).toBe(true)
    expect(modelSeesImages("gemma-3-12b")).toBe(true)
  })

  test("knows the hosted ones", () => {
    expect(modelSeesImages("openai/gpt-4o-mini")).toBe(true)
    expect(modelSeesImages("anthropic/claude-sonnet-4")).toBe(true)
    expect(modelSeesImages("google/gemini-2.5-pro")).toBe(true)
  })

  test("a text-only coder model is not fooled into accepting pixels", () => {
    expect(modelSeesImages("qwen2.5-coder-7b")).toBe(false)
    expect(modelSeesImages("llama-3.1-8b-instruct")).toBe(false)
    expect(modelSeesImages(undefined)).toBe(false)
    expect(modelSeesImages("")).toBe(false)
  })

  test("config can force either answer", () => {
    expect(modelSeesImages("qwen2.5-coder-7b", { force: true })).toBe(true)
    expect(modelSeesImages("qwen2.5-vl-7b", { force: false })).toBe(false)
  })

  test("config can add families IMURUN does not know", () => {
    expect(modelSeesImages("acme-eyes-9b")).toBe(false)
    expect(modelSeesImages("acme-eyes-9b", { extra: ["acme-eyes"] })).toBe(true)
  })
})

describe("read on an image", () => {
  test("a text-only model is told what the picture is, not shown it", async () => {
    writeFileSync(join(dir, "shot.png"), pngBytes(640, 480))
    const result = await readTool.execute({ path: "shot.png" }, { ...ctx, vision: false })
    expect(result.ok).toBe(true)
    expect(result.images).toBeUndefined()
    expect(result.output).toContain("640\u00d7480 PNG")
    expect(result.output).toContain("cannot see images")
  })

  test("a vision model gets the bytes", async () => {
    writeFileSync(join(dir, "shot.png"), pngBytes(640, 480))
    const result = await readTool.execute({ path: "shot.png" }, { ...ctx, vision: true })
    expect(result.ok).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(result.images?.[0]?.mime).toBe("image/png")
    // base64 of the same bytes
    expect(Buffer.from(result.images![0]!.data, "base64").equals(pngBytes(640, 480))).toBe(true)
  })

  test("an extensionless image is recognised by its bytes", async () => {
    writeFileSync(join(dir, "capture"), pngBytes(100, 50))
    const result = await readTool.execute({ path: "capture" }, { ...ctx, vision: false })
    expect(result.ok).toBe(true)
    expect(result.output).toContain("100\u00d750 PNG")
  })

  test("a binary file that is not an image is still refused", async () => {
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]))
    const result = await readTool.execute({ path: "blob.bin" }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Binary")
  })
})

describe("screenshot tool", () => {
  test("reports honestly when this machine cannot capture a screen", async () => {
    const tool = createScreenshotTool({ capture: () => undefined })
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("No screen-capture tool")
  })

  test("hands the picture to a vision model", async () => {
    const target = join(dir, "shot.png")
    const tool = createScreenshotTool({
      capture: (path) => ({ command: ["fake", path], label: "fake" }),
      run: async (command) => {
        writeFileSync(command[command.length - 1]!, pngBytes(1024, 768))
        return { code: 0, stderr: "" }
      },
    })
    const result = await tool.execute({ path: target }, { ...ctx, vision: true })
    expect(result.ok).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(result.output).toContain("1024\u00d7768 PNG")
    expect(result.title).toContain("1024\u00d7768")
  })

  test("a text-only model gets the path and an instruction not to guess", async () => {
    const target = join(dir, "shot.png")
    const tool = createScreenshotTool({
      capture: (path) => ({ command: ["fake", path], label: "fake" }),
      run: async (command) => {
        writeFileSync(command[command.length - 1]!, pngBytes())
        return { code: 0, stderr: "" }
      },
    })
    const result = await tool.execute({ path: target }, { ...ctx, vision: false })
    expect(result.ok).toBe(true)
    expect(result.images).toBeUndefined()
    expect(result.output).toContain(target)
    expect(result.output).toContain("cannot see images")
  })

  test("a failed capture is reported with the tool that failed", async () => {
    const tool = createScreenshotTool({
      capture: (path) => ({ command: ["fake", path], label: "grim" }),
      run: async () => ({ code: 3, stderr: "no display" }),
    })
    const result = await tool.execute({ path: join(dir, "shot.png") }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("grim")
    expect(result.error).toContain("no display")
  })

  test("a silent no-op is caught rather than passed on as an empty image", async () => {
    const tool = createScreenshotTool({
      capture: (path) => ({ command: ["fake", path], label: "fake" }),
      run: async () => ({ code: 0, stderr: "" }),
    })
    const result = await tool.execute({ path: join(dir, "missing.png") }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("produced no file")
  })

  test("can open the capture for the user", async () => {
    const target = join(dir, "shot.png")
    const opened: string[] = []
    const tool = createScreenshotTool({
      capture: (path) => ({ command: ["fake", path], label: "fake" }),
      run: async (command) => {
        writeFileSync(command[command.length - 1]!, pngBytes())
        return { code: 0, stderr: "" }
      },
      open: (path) => opened.push(path),
    })
    await tool.execute({ path: target, open: true }, ctx)
    expect(opened).toEqual([target])
  })
})

describe("tool results on their way to the model", () => {
  const message = (content: Message["content"]): Message => ({
    id: "msg_1",
    sessionId: "ses_test",
    role: "tool",
    content,
    toolCallId: "call_1",
    createdAt: 1,
    metadata: { toolName: "read" },
  })

  test("text stays a plain text result", () => {
    const converted = toModelMessage(message("file contents")) as {
      content: Array<{ output: { type: string; value: unknown } }>
    }
    expect(converted.content[0]!.output.type).toBe("text")
    expect(converted.content[0]!.output.value).toBe("file contents")
  })

  test("an image result becomes a content result carrying the bytes", () => {
    const converted = toModelMessage(
      message([
        { type: "text", text: "Image: 640\u00d7480 PNG." },
        { type: "image", mime: "image/png", data: "AAAA" },
      ]),
    ) as { content: Array<{ output: { type: string; value: unknown[] } }> }

    expect(converted.content[0]!.output.type).toBe("content")
    const value = converted.content[0]!.output.value as Array<Record<string, unknown>>
    expect(value[0]).toEqual({ type: "text", text: "Image: 640\u00d7480 PNG." })
    expect(value[1]).toEqual({ type: "file", data: { type: "data", data: "AAAA" }, mediaType: "image/png" })
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readGgufContextLength, readGgufInfo } from "../src/gguf"

/**
 * A tiny GGUF writer, enough to produce a valid metadata header. The real files
 * are gigabytes; what the reader has to cope with is the layout, not the size.
 */
function gguf(pairs: Array<[string, number | string | Array<string | number>]>): Buffer {
  const chunks: Buffer[] = []
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value, 0)
    return buffer
  }
  const u64 = (value: number): Buffer => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(BigInt(value), 0)
    return buffer
  }
  const str = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8")
    return Buffer.concat([u64(bytes.length), bytes])
  }

  chunks.push(Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(pairs.length))
  for (const [key, value] of pairs) {
    chunks.push(str(key))
    if (typeof value === "string") {
      chunks.push(u32(8), str(value))
    } else if (typeof value === "number") {
      chunks.push(u32(10), u64(value))
    } else if (typeof value[0] === "string") {
      chunks.push(u32(9), u32(8), u64(value.length))
      for (const item of value as string[]) chunks.push(str(item))
    } else {
      chunks.push(u32(9), u32(10), u64(value.length))
      for (const item of value as number[]) chunks.push(u64(item))
    }
  }
  return Buffer.concat(chunks)
}

async function withFile<T>(content: Buffer, run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "imurun-gguf-"))
  const path = join(dir, "model.gguf")
  await writeFile(path, content)
  try {
    return await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("readGgufInfo", () => {
  test("reads the architecture and trained context window", async () => {
    const buffer = gguf([
      ["general.architecture", "qwen2"],
      ["general.name", "Qwen2.5 Coder"],
      ["qwen2.context_length", 32768],
      ["qwen2.embedding_length", 3584],
      ["qwen2.block_count", 28],
    ])
    const info = await withFile(buffer, (path) => readGgufInfo(path))
    expect(info?.architecture).toBe("qwen2")
    expect(info?.contextLength).toBe(32768)
    expect(info?.embeddingLength).toBe(3584)
    expect(info?.blockCount).toBe(28)
  })

  test("keeps reading past values of every scalar width", async () => {
    const buffer = gguf([
      ["general.alignment", 32],
      ["general.file_type", 15],
      ["qwen2.context_length", 8192],
    ])
    const info = await withFile(buffer, (path) => readGgufInfo(path))
    expect(info?.contextLength).toBe(8192)
  })

  test("stops at the tokenizer block instead of walking megabytes", async () => {
    const buffer = gguf([
      ["general.architecture", "llama"],
      ["tokenizer.ggml.model", "gpt2"],
      ["llama.context_length", 131072],
    ])
    const info = await withFile(buffer, (path) => readGgufInfo(path))
    // the only thing we wanted was before the tokenizer block
    expect(info?.architecture).toBe("llama")
    expect(info?.contextLength).toBeUndefined()
  })

  test("skips a string array to reach later keys", async () => {
    const buffer = gguf([
      ["general.architecture", "qwen2"],
      ["tokenizer.ggml.tokens", ["a", "bb", "ccc"]],
      ["qwen2.context_length", 4096],
    ])
    const info = await withFile(buffer, (path) => readGgufInfo(path))
    expect(info?.contextLength).toBeUndefined() // tokenizer came first, so we stopped
  })

  test("a file that is not GGUF is reported as unknown, never thrown", async () => {
    const info = await withFile(Buffer.alloc(128, 7), (path) => readGgufInfo(path))
    expect(info).toBeUndefined()
  })

  test("a missing file is reported as unknown, never thrown", async () => {
    expect(await readGgufInfo("C:/definitely/not/here.gguf")).toBeUndefined()
  })

  test("readGgufContextLength only returns usable numbers", async () => {
    const withLength = gguf([
      ["general.architecture", "qwen2"],
      ["qwen2.context_length", 32768],
    ])
    expect(await withFile(withLength, (path) => readGgufContextLength(path))).toBe(32768)

    const zero = gguf([
      ["general.architecture", "qwen2"],
      ["qwen2.context_length", 0],
    ])
    expect(await withFile(zero, (path) => readGgufContextLength(path))).toBeUndefined()
  })
})

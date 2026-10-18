/**
 * GGUF metadata reader — the only reliable way to learn a model's context
 * window *before* it is loaded.
 *
 * llama.cpp defaults `--ctx-size` to 4096 when it is not told otherwise, which
 * silently truncates requests for models trained on far more. The official
 * catalog carries a `contextLength`, but a file the user imported (or one
 * installed before that field existed) does not — so we read the number out of
 * the file itself.
 *
 * Only the metadata block at the head of the file is parsed, and parsing stops
 * as soon as the keys we want are found, so the multi-megabyte tokenizer arrays
 * are never loaded. Pure Node APIs, no dependency, no network.
 */
import { open, type FileHandle } from "node:fs/promises"

const GGUF_MAGIC = 0x46554747 // "GGUF" as little-endian u32
const CHUNK_BYTES = 64 * 1024
/** Give up rather than scan a pathological file. */
const MAX_METADATA_BYTES = 16 * 1024 * 1024

/** Value type ids used by the GGUF spec. */
const TYPE_UINT8 = 0
const TYPE_INT8 = 1
const TYPE_UINT16 = 2
const TYPE_INT16 = 3
const TYPE_UINT32 = 4
const TYPE_INT32 = 5
const TYPE_FLOAT32 = 6
const TYPE_BOOL = 7
const TYPE_STRING = 8
const TYPE_ARRAY = 9
const TYPE_UINT64 = 10
const TYPE_INT64 = 11
const TYPE_FLOAT64 = 12

const SCALAR_BYTES: Record<number, number> = {
  [TYPE_UINT8]: 1,
  [TYPE_INT8]: 1,
  [TYPE_UINT16]: 2,
  [TYPE_INT16]: 2,
  [TYPE_UINT32]: 4,
  [TYPE_INT32]: 4,
  [TYPE_FLOAT32]: 4,
  [TYPE_BOOL]: 1,
  [TYPE_UINT64]: 8,
  [TYPE_INT64]: 8,
  [TYPE_FLOAT64]: 8,
}

export interface GgufInfo {
  version: number
  /** e.g. "qwen2" — every per-model key is prefixed with it. */
  architecture?: string
  /** `<arch>.context_length`: the window the model was trained with. */
  contextLength?: number
  /** `<arch>.embedding_length`: hidden size. */
  embeddingLength?: number
  /** `<arch>.block_count`: number of layers. */
  blockCount?: number
}

/** A forward-only, buffered cursor over an open file. */
class Cursor {
  private buffer = Buffer.alloc(0)
  private position = 0
  private consumed = 0

  constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  get offset(): number {
    return this.consumed + this.position
  }

  private async ensure(bytes: number): Promise<void> {
    if (this.position + bytes <= this.buffer.length) return
    // Refill: drop what has been consumed, then read enough to satisfy the ask.
    this.consumed += this.position
    this.buffer = this.buffer.subarray(this.position)
    this.position = 0
    while (this.buffer.length < bytes) {
      const chunk = Buffer.alloc(Math.max(CHUNK_BYTES, bytes))
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.consumed + this.buffer.length)
      if (bytesRead <= 0) throw new Error("unexpected end of file")
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, bytesRead)])
    }
  }

  private async take(bytes: number): Promise<Buffer> {
    await this.ensure(bytes)
    const slice = this.buffer.subarray(this.position, this.position + bytes)
    this.position += bytes
    return slice
  }

  async u8(): Promise<number> {
    return (await this.take(1)).readUInt8(0)
  }

  async u16(): Promise<number> {
    return (await this.take(2)).readUInt16LE(0)
  }

  async u32(): Promise<number> {
    return (await this.take(4)).readUInt32LE(0)
  }

  async u64(): Promise<number> {
    return Number((await this.take(8)).readBigUInt64LE(0))
  }

  async str(): Promise<string> {
    const length = await this.u64()
    if (length <= 0) return ""
    if (length > 1024 * 1024) throw new Error("implausible GGUF string length")
    return (await this.take(length)).toString("utf8")
  }

  async skip(bytes: number): Promise<void> {
    if (bytes <= 0) return
    if (this.position + bytes <= this.buffer.length) {
      this.position += bytes
      return
    }
    // Skip the buffered part, then move the file position without reading.
    const left = bytes - (this.buffer.length - this.position)
    this.consumed += this.buffer.length
    this.buffer = Buffer.alloc(0)
    this.position = 0
    this.consumed += left
  }
}

/** Advances the cursor past a value of any type, without materialising it. */
async function skipValue(cursor: Cursor, type: number): Promise<void> {
  if (type === TYPE_STRING) {
    await cursor.skip(await cursor.u64())
    return
  }
  if (type === TYPE_ARRAY) {
    const elementType = await cursor.u32()
    const count = await cursor.u64()
    if (count <= 0) return
    if (elementType === TYPE_STRING) {
      // Strings are variable length, so the lengths must be walked.
      for (let i = 0; i < count; i++) await cursor.skip(await cursor.u64())
      return
    }
    const size = SCALAR_BYTES[elementType]
    if (size === undefined) throw new Error(`unknown GGUF array element type ${elementType}`)
    await cursor.skip(size * count)
    return
  }
  const size = SCALAR_BYTES[type]
  if (size === undefined) throw new Error(`unknown GGUF value type ${type}`)
  await cursor.skip(size)
}

async function readInteger(cursor: Cursor, type: number): Promise<number> {
  return type === TYPE_UINT64 || type === TYPE_INT64 ? cursor.u64() : cursor.u32()
}

/**
 * Reads the context window (and a few other facts) out of a GGUF file.
 * Returns undefined when the file is not GGUF or the keys are absent.
 */
export async function readGgufInfo(path: string): Promise<GgufInfo | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, "r")
    const { size } = await handle.stat()
    if (size < 32) return undefined

    const cursor = new Cursor(handle, size)
    if ((await cursor.u32()) !== GGUF_MAGIC) return undefined
    const version = await cursor.u32()
    await cursor.u64() // tensor count
    const kvCount = await cursor.u64()
    if (!Number.isFinite(kvCount) || kvCount < 0) return undefined

    const info: GgufInfo = { version }
    for (let i = 0; i < kvCount; i++) {
      if (cursor.offset > MAX_METADATA_BYTES) break
      const key = await cursor.str()
      const type = await cursor.u32()

      if (key === "general.architecture" && type === TYPE_STRING) {
        info.architecture = await cursor.str()
        continue
      }
      if (key.endsWith(".context_length") && (type === TYPE_UINT32 || type === TYPE_UINT64)) {
        info.contextLength = await readInteger(cursor, type)
        continue
      }
      if (key.endsWith(".embedding_length") && (type === TYPE_UINT32 || type === TYPE_UINT64)) {
        info.embeddingLength = await readInteger(cursor, type)
        continue
      }
      if (key.endsWith(".block_count") && (type === TYPE_UINT32 || type === TYPE_UINT64)) {
        info.blockCount = await readInteger(cursor, type)
        continue
      }
      // The per-architecture keys always precede the tokenizer block, so once
      // the tokenizer starts there is nothing left worth reading.
      if (key.startsWith("tokenizer.")) break
      await skipValue(cursor, type)
    }

    return info
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Convenience wrapper: just the trained context window, when known. */
export async function readGgufContextLength(path: string): Promise<number | undefined> {
  const info = await readGgufInfo(path)
  const length = info?.contextLength
  return length && length > 0 ? length : undefined
}

import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "@imurun/util"
import { downloadFile } from "../src"

// deterministic 300 KB payload
const SIZE = 300 * 1024
const PAYLOAD = new Uint8Array(SIZE)
for (let i = 0; i < SIZE; i++) PAYLOAD[i] = (i * 31 + 7) % 256
const PAYLOAD_SHA = sha256(PAYLOAD)

interface ServeState {
  /** Requests that should fail with 500 before working. */
  failures: number
  requests: Array<{ range?: string; url: string }>
  /** Adds latency between chunks for abort tests. */
  slow?: boolean
}

function startServer(state: ServeState) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      state.requests.push({ range: request.headers.get("range") ?? undefined, url: url.pathname })

      if (state.failures > 0) {
        state.failures -= 1
        return new Response("server error", { status: 500 })
      }

      const range = request.headers.get("range")
      let start = 0
      let end = SIZE - 1
      let status = 200
      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/)
        if (match) {
          start = Number(match[1])
          if (match[2]) end = Math.min(Number(match[2]), SIZE - 1)
          status = 206
        }
      }

      const slice = PAYLOAD.slice(start, end + 1)
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
      }
      if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${SIZE}`

      if (state.slow) {
        // drip the payload so the client can abort mid-flight
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const chunkSize = 16 * 1024
            for (let offset = 0; offset < slice.byteLength; offset += chunkSize) {
              controller.enqueue(slice.slice(offset, offset + chunkSize))
              await Bun.sleep(80)
            }
            controller.close()
          },
        })
        return new Response(stream, { status, headers })
      }

      return new Response(slice, { status, headers })
    },
  })
}

const dir = mkdtempSync(join(tmpdir(), "imurun-dl-"))
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe("downloadFile", () => {
  test("downloads a file with progress and verifies the checksum", async () => {
    const state: ServeState = { failures: 0, requests: [] }
    const server = startServer(state)
    try {
      const destination = join(dir, "model.gguf")
      const events: number[] = []
      let finalPercent = 0

      const result = await downloadFile({
        url: `http://127.0.0.1:${server.port}/model.gguf`,
        destination,
        sha256: PAYLOAD_SHA,
        onProgress: (p) => {
          events.push(p.downloadedBytes)
          if (p.percent !== undefined) finalPercent = p.percent
        },
      })

      expect(result.sizeBytes).toBe(SIZE)
      expect(result.sha256).toBe(PAYLOAD_SHA)
      expect(result.resumed).toBe(false)
      expect(finalPercent).toBe(100)
      expect(events.length).toBeGreaterThan(0)

      const onDisk = new Uint8Array(await Bun.file(destination).arrayBuffer())
      expect(onDisk.length).toBe(SIZE)
      expect(sha256(onDisk)).toBe(PAYLOAD_SHA)
      // no leftover .part
      expect(await Bun.file(`${destination}.part`).exists()).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("resumes a partial download with a range request", async () => {
    const state: ServeState = { failures: 0, requests: [] }
    const server = startServer(state)
    try {
      const destination = join(dir, "resume.gguf")
      const partPath = `${destination}.part`
      const existing = Math.floor(SIZE * 0.4)
      await Bun.write(partPath, PAYLOAD.slice(0, existing))

      const result = await downloadFile({
        url: `http://127.0.0.1:${server.port}/resume.gguf`,
        destination,
        sha256: PAYLOAD_SHA,
      })

      expect(result.resumed).toBe(true)
      expect(state.requests[0]!.range).toBe(`bytes=${existing}-`)

      const onDisk = new Uint8Array(await Bun.file(destination).arrayBuffer())
      expect(onDisk.length).toBe(SIZE)
      expect(sha256(onDisk)).toBe(PAYLOAD_SHA)
    } finally {
      server.stop(true)
    }
  })

  test("retries transient failures and eventually succeeds", async () => {
    const state: ServeState = { failures: 1, requests: [] }
    const server = startServer(state)
    try {
      const destination = join(dir, "retry.gguf")
      const result = await downloadFile({
        url: `http://127.0.0.1:${server.port}/retry.gguf`,
        destination,
      })
      expect(result.sizeBytes).toBe(SIZE)
      expect(state.requests.length).toBeGreaterThanOrEqual(2)
    } finally {
      server.stop(true)
    }
  }, 15_000)

  test("rejects a corrupted download and cleans the part file", async () => {
    const state: ServeState = { failures: 0, requests: [] }
    const server = startServer(state)
    try {
      const destination = join(dir, "corrupt.gguf")
      const wrong = "0".repeat(64)
      await expect(
        downloadFile({
          url: `http://127.0.0.1:${server.port}/corrupt.gguf`,
          destination,
          sha256: wrong,
          attempts: 1,
        }),
      ).rejects.toThrow(/Checksum mismatch/)
      expect(await Bun.file(`${destination}.part`).exists()).toBe(false)
      expect(await Bun.file(destination).exists()).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("abort stops the transfer and keeps the partial file for resume", async () => {
    const state: ServeState = { failures: 0, requests: [], slow: true }
    const server = startServer(state)
    try {
      const destination = join(dir, "aborted.gguf")
      const controller = new AbortController()
      const running = downloadFile({
        url: `http://127.0.0.1:${server.port}/aborted.gguf`,
        destination,
        signal: controller.signal,
        attempts: 1,
      })

      await Bun.sleep(250)
      controller.abort()

      await expect(running).rejects.toThrow(/abort/i)
      const part = Bun.file(`${destination}.part`)
      expect(await part.exists()).toBe(true)
      expect(part.size).toBeGreaterThan(0)
      expect(part.size).toBeLessThan(SIZE)
    } finally {
      server.stop(true)
    }
  })

  test("server errors surface a helpful message", async () => {
    const state: ServeState = { failures: 5, requests: [] }
    const server = startServer(state)
    try {
      const destination = join(dir, "missing.gguf")
      await expect(
        downloadFile({
          url: `http://127.0.0.1:${server.port}/missing.gguf`,
          destination,
          attempts: 2,
        }),
      ).rejects.toThrow(/HTTP 500/)
    } finally {
      server.stop(true)
    }
  }, 15_000)
})

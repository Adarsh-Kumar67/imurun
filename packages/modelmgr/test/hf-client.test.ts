import { describe, expect, test } from "bun:test"
import { sha256 } from "@imurun/util"
import { headFile, resolveFileUrl } from "../src"

const PAYLOAD = new Uint8Array(4096).map((_, i) => (i * 13 + 5) % 256)
const CONTENT_SHA = sha256(PAYLOAD)
/** Simulates a Xet reconstruction hash (64 hex chars, but not the file sha). */
const XET_HASH = "713e381286c0f37db13944ac48f0cb2da4024b0aa4741aac21da49a44f171ea5"

describe("hugging face client", () => {
  test("resolveFileUrl builds the canonical download URL", () => {
    expect(resolveFileUrl("org/repo", "model-Q4_K_M.gguf")).toBe(
      "https://huggingface.co/org/repo/resolve/main/model-Q4_K_M.gguf?download=true",
    )
  })

  test("headFile reads X-Linked-ETag/SHA-256 from the redirect hop, not the CDN xet hash", async () => {
    let server: ReturnType<typeof Bun.serve>
    server = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url)
        if (url.pathname === "/repo/resolve/main/model.gguf") {
          return new Response(null, {
            status: 302,
            headers: {
              location: `http://127.0.0.1:${server.port}/cdn/signed?token=abc`,
              "x-linked-etag": `"${CONTENT_SHA}"`,
              "x-linked-size": String(PAYLOAD.byteLength),
            },
          })
        }
        if (url.pathname === "/cdn/signed") {
          return new Response(PAYLOAD, {
            status: 200,
            headers: {
              etag: `"${XET_HASH}"`, // must NOT be used for verification
              "accept-ranges": "bytes",
            },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const info = await headFile(`http://127.0.0.1:${server.port}/repo/resolve/main/model.gguf`)
      expect(info.sha256).toBe(CONTENT_SHA)
      expect(info.sha256).not.toBe(XET_HASH)
      expect(info.sizeBytes).toBe(PAYLOAD.byteLength)
      expect(info.acceptsRanges).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("headFile works on direct responses with x-linked-etag", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(PAYLOAD, {
          status: 200,
          headers: {
            "x-linked-etag": `"${CONTENT_SHA}"`,
            "content-length": String(PAYLOAD.byteLength),
            "accept-ranges": "bytes",
          },
        })
      },
    })

    try {
      const info = await headFile(`http://127.0.0.1:${server.port}/direct.gguf`)
      expect(info.sha256).toBe(CONTENT_SHA)
      expect(info.sizeBytes).toBe(PAYLOAD.byteLength)
    } finally {
      server.stop(true)
    }
  })

  test("headFile surfaces HTTP errors with the URL", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("gone", { status: 404 })
      },
    })

    try {
      await expect(headFile(`http://127.0.0.1:${server.port}/missing.gguf`)).rejects.toThrow(/HTTP 404/)
    } finally {
      server.stop(true)
    }
  })
})

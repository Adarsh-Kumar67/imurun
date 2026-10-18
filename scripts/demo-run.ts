#!/usr/bin/env bun
/**
 * M3 demo — proves the whole pipeline works end to end:
 *
 *   fake local model server (OpenAI-compatible SSE)
 *        ↓
 *   imurun run "create hello.txt ..."  (spawned as a real CLI process)
 *        ↓
 *   agent streams text, requests a tool call, writes the file, answers
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

// ── 1. fake local inference server ──────────────────────────────────────────

function sse(delta: object, finish: string | null = null, usage?: object): string {
  return (
    `data: ${JSON.stringify({
      id: "chatcmpl-demo",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "demo-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`
  )
}

let call = 0
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "demo-model", object: "model" }] })
    }
    if (!url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 })
    }

    await req.json()
    call++
    let payload = ""

    if (call === 1) {
      // first turn: the model "decides" to write a file
      const args = JSON.stringify({ path: "hello.txt", content: "Hello from IMURUN.\nThis file was written by the agent.\n" })
      payload += sse({ role: "assistant", tool_calls: [{ index: 0, id: "call_demo_1", type: "function", function: { name: "write", arguments: "" } }] })
      for (const piece of [args.slice(0, 20), args.slice(20, 45), args.slice(45)]) {
        payload += sse({ tool_calls: [{ index: 0, function: { arguments: piece } }] })
      }
      payload += sse({}, "tool_calls", { prompt_tokens: 30, completion_tokens: 18, total_tokens: 48 })
    } else {
      // second turn: after the tool result, the model responds
      payload += sse({ role: "assistant", content: "" })
      for (const piece of ["Done — ", "I created ", "hello.txt ", "with a greeting."]) {
        payload += sse({ content: piece })
      }
      payload += sse({}, "stop", { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 })
    }
    payload += "data: [DONE]\n\n"

    return new Response(payload, { headers: { "content-type": "text/event-stream" } })
  },
})

// ── 2. demo project with config pointing at the fake server ────────────────

const projectDir = mkdtempSync(join(tmpdir(), "imurun-demo-"))
writeFileSync(
  join(projectDir, "imurun.json"),
  JSON.stringify(
    {
      model: "demo-model",
      providers: {
        demo: { id: "demo", kind: "local", type: "custom", baseURL: `http://127.0.0.1:${server.port}/v1`, models: ["demo-model"] },
      },
    },
    null,
    2,
  ),
)

console.log("\n  ═══ M3 demo: imurun run ═══")
console.log(`  fake model server: http://127.0.0.1:${server.port}/v1`)
console.log(`  project: ${projectDir}\n`)

// ── 3. spawn the real CLI ───────────────────────────────────────────────────

const cli = Bun.spawn(
  [process.execPath, "run", join(root, "packages", "cli", "src", "index.ts"), "run", "create hello.txt with a greeting", "--yes", "--dir", projectDir],
  { stdout: "inherit", stderr: "inherit", env: { ...process.env, IMURUN_HOME: join(projectDir, ".home") } },
)
const exitCode = await cli.exited

// ── 4. verify the results ───────────────────────────────────────────────────

const filePath = join(projectDir, "hello.txt")
const fileWritten = existsSync(filePath)
console.log("\n  ═══ verification ═══")
console.log(`  exit code:        ${exitCode}`)
console.log(`  hello.txt exists: ${fileWritten}`)
if (fileWritten) console.log(`  content:          ${JSON.stringify(readFileSync(filePath, "utf8"))}`)

// ── 5. memory: the session must have been summarized to disk ──────────────

const memoryRoot = join(projectDir, ".home", "memory")
const indexPath = join(memoryRoot, "index.json")

interface Digest {
  sessionId: string
  files: string[]
  highlights: string[]
  messageCount: number
}

let digest: Digest | undefined
try {
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { digests: Digest[] }
  digest = index.digests[0]
} catch {
  digest = undefined
}

const digestFile = digest ? join(memoryRoot, "sessions", `${digest.sessionId}.md`) : undefined
const digestWritten = digestFile ? existsSync(digestFile) : false
const notedFile = digest?.files.includes("hello.txt") ?? false

console.log("\n  ═══ memory ═══")
console.log(`  index.json:       ${existsSync(indexPath)}`)
console.log(`  digest file:      ${digestFile ? digestFile.replace(projectDir, ".") : "(none)"} ${digestWritten ? "✔" : "✖"}`)
console.log(`  files recorded:   ${digest?.files.join(", ") ?? "(none)"}`)
console.log(`  highlights:       ${digest?.highlights.join(" | ") ?? "(none)"}`)

server.stop(true)
const ok = exitCode === 0 && fileWritten && digestWritten && notedFile
console.log(ok ? "\n  ✔ M3 end-to-end demo PASSED\n" : "\n  ✖ M3 demo FAILED\n")
process.exit(ok ? 0 : 1)

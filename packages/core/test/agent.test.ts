/**
 * End-to-end agent test: a fake OpenAI-compatible server (the same protocol
 * the local llama.cpp daemon speaks) drives a full agent loop — streaming,
 * tool calls, permissions, persistence.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImurunConfig } from "@imurun/schema"
import {
  Agent,
  ImurunDatabase,
  PermissionManager,
  ProviderRegistry,
  SessionStore,
  ToolRegistry,
  probeProvider,
  type AgentEvent,
} from "../src"

// ── Fake OpenAI-compatible server ───────────────────────────────────────────

interface ChunkOptions {
  content?: string
  toolCall?: { id: string; name: string; arguments: string }
  finish?: "stop" | "tool_calls" | "length" | null
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

function sseChunk(options: ChunkOptions): string {
  const delta: Record<string, unknown> = {}
  if (options.content) delta.content = options.content
  if (options.toolCall) {
    delta.tool_calls = [
      {
        index: 0,
        id: options.toolCall.id,
        type: "function",
        function: { name: options.toolCall.name, arguments: options.toolCall.arguments },
      },
    ]
  }
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: options.finish ?? null }],
    ...(options.usage ? { usage: options.usage } : {}),
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function textScript(...pieces: string[]): string {
  let out = sseChunk({})
  for (const piece of pieces) out += sseChunk({ content: piece })
  out += sseChunk({ finish: "stop", usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
  return out + "data: [DONE]\n\n"
}

function toolCallScript(id: string, name: string, argsJson: string): string {
  // stream the arguments in pieces to exercise incremental assembly
  const parts = [argsJson.slice(0, 4), argsJson.slice(4, 9), argsJson.slice(9)].filter(Boolean)
  let out = sseChunk({ toolCall: { id, name, arguments: parts[0] ?? "" } })
  for (const piece of parts.slice(1)) {
    out += sseChunk({ toolCall: { id, name, arguments: piece } }).replace(/"id":"[^"]+",/, "")
  }
  out += sseChunk({ finish: "tool_calls", usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } })
  return out + "data: [DONE]\n\n"
}

/** Text that the engine stops because the output limit was reached. */
function lengthScript(...pieces: string[]): string {
  let out = sseChunk({})
  for (const piece of pieces) out += sseChunk({ content: piece })
  out += sseChunk({ finish: "length", usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } })
  return out + "data: [DONE]\n\n"
}

/** The exact refusal a llama.cpp engine returns for an over-sized request. */
function overflowResponse(): Response {
  return Response.json(
    {
      error: {
        message:
          "request (4221 tokens) exceeds the available context size (4096 tokens), try increasing it",
        type: "invalid_request_error",
      },
    },
    { status: 400 },
  )
}

interface FakeServer {
  url: string
  requests: Array<Record<string, unknown>>
  close(): void
}

type FakeScript = string | Response | ((body: Record<string, unknown>) => string | Response)

function startFakeServer(scripts: Array<FakeScript>): FakeServer {
  const requests: Array<Record<string, unknown>> = []
  let call = 0

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json()) as Record<string, unknown>
        requests.push(body)
        // repeat the last script when the queue is exhausted (useful for loop tests)
        const script =
          scripts.length === 0
            ? textScript("(no scripted responses)")
            : scripts[Math.min(call, scripts.length - 1)]!
        call++
        const payload = typeof script === "function" ? script(body) : script
        if (payload instanceof Response) return payload
        return new Response(payload, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "test-model", object: "model" }] })
      }
      return new Response("not found", { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    close: () => server.stop(true),
  }
}

// ── Test harness ────────────────────────────────────────────────────────────

interface Harness {
  store: ImurunDatabase
  sessions: SessionStore
  providers: ProviderRegistry
  tools: ToolRegistry
  config: ImurunConfig
  workingDir: string
}

async function harness(serverUrl: string): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "imurun-e2e-"))
  const workingDir = mkdtempSync(join(tmpdir(), "imurun-work-"))
  const store = await ImurunDatabase.open(join(home, "test.db"))
  const config = ImurunConfig.parse({
    providers: {
      test: {
        id: "test",
        kind: "local",
        type: "custom",
        baseURL: serverUrl,
        models: ["test-model"],
      },
    },
  })
  return {
    store,
    sessions: new SessionStore(store),
    providers: new ProviderRegistry(config),
    tools: ToolRegistry.default(),
    config,
    workingDir,
  }
}

function collectingEvents(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, onEvent: (e) => events.push(e) }
}

/** Replays the events the way the transcript does, so a reset takes text back. */
function displayedText(events: AgentEvent[]): string {
  let display = ""
  for (const event of events) {
    if (event.type === "text") display += event.delta
    else if (event.type === "text-reset") display = event.text
  }
  return display
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("provider layer", () => {
  test("probeProvider reports ready and lists models", async () => {
    const server = startFakeServer([])
    const { config } = await harness(server.url)
    const info = await probeProvider(
      { id: "test", kind: "local", type: "custom", baseURL: server.url, models: [], enabled: true },
      config,
    )
    expect(info.status).toBe("ready")
    expect(info.models).toContain("test-model")
    server.close()
  })

  test("resolve supports provider/model references", async () => {
    const server = startFakeServer([])
    const { providers } = await harness(server.url)
    const resolved = providers.resolve("test/some-model")
    expect(resolved.provider.id).toBe("test")
    expect(resolved.modelId).toBe("some-model")
    server.close()
  })
})

describe("agent loop", () => {
  test("streams text, executes tools, and persists everything", async () => {
    const targetFile = "result.txt"
    const argsJson = JSON.stringify({ path: targetFile, content: "hello from agent" })
    const server = startFakeServer([
      toolCallScript("call_1", "write", argsJson),
      textScript("Done", " — created ", "result.txt"),
    ])

    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "create result.txt with a greeting",
      workingDir: h.workingDir,
      verifyChanges: false,
      onEvent,
    })

    // file was written by the tool
    expect(existsSync(join(h.workingDir, targetFile))).toBe(true)
    expect(readFileSync(join(h.workingDir, targetFile), "utf8")).toBe("hello from agent")

    // result aggregates both steps
    expect(result.text).toContain("Done")
    expect(result.steps).toBe(2)
    expect(result.usage.inputTokens).toBeGreaterThan(0)

    // message history: user, assistant(tool call), tool, assistant(text)
    const messages = h.sessions.getMessages(session.id)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(messages[1]!.toolCalls?.[0]!.name).toBe("write")
    expect(messages[1]!.toolCalls?.[0]!.args).toEqual({ path: targetFile, content: "hello from agent" })
    expect(messages[2]!.toolCallId).toBe(messages[1]!.toolCalls?.[0]!.id)
    expect(messages[2]!.metadata?.toolName).toBe("write")

    // events arrived in order
    const types = events.map((e) => e.type)
    expect(types).toContain("step-start")
    expect(types).toContain("tool-start")
    expect(types).toContain("tool-end")
    expect(types).toContain("done")
    expect(types.indexOf("tool-start")).toBeLessThan(types.indexOf("tool-end"))

    // both requests reached the server; the second includes the tool result
    expect(server.requests).toHaveLength(2)
    const secondMessages = server.requests[1]!.messages as Array<Record<string, unknown>>
    const toolMessage = secondMessages.find((m) => m.role === "tool")
    expect(toolMessage).toBeDefined()
    expect(JSON.stringify(toolMessage)).toContain("Created")

    // session usage accumulated
    const updated = h.sessions.get(session.id)
    expect(updated?.totalInputTokens).toBeGreaterThan(0)

    h.store.close()
    server.close()
  })

  test("text-only responses finish in one step", async () => {
    const server = startFakeServer([textScript("Hello", " there!")])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
    })

    const result = await agent.run({ sessionId: session.id, input: "hi", workingDir: h.workingDir })

    expect(result.text).toBe("Hello there!")
    expect(result.steps).toBe(1)
    expect(h.sessions.getMessages(session.id)).toHaveLength(2)
    h.store.close()
    server.close()
  })

  test("denied permission blocks the tool but keeps the loop alive", async () => {
    const argsJson = JSON.stringify({ path: "denied.txt", content: "should not exist" })
    const server = startFakeServer([
      toolCallScript("call_1", "write", argsJson),
      textScript("Understood, skipping that."),
    ])

    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [], mode: "manual" }),
      config: h.config,
      onPermission: async () => false, // user says no
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "create denied.txt",
      workingDir: h.workingDir,
    })

    expect(existsSync(join(h.workingDir, "denied.txt"))).toBe(false)
    expect(result.text).toContain("Understood")

    const messages = h.sessions.getMessages(session.id)
    const toolMessage = messages.find((m) => m.role === "tool")
    expect(toolMessage?.content).toContain("Permission denied")
    h.store.close()
    server.close()
  })

  test("in manual mode without a handler, ask-tools are denied", async () => {
    const argsJson = JSON.stringify({ path: "x.txt", content: "nope" })
    const server = startFakeServer([toolCallScript("call_1", "write", argsJson), textScript("ok")])

    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [], mode: "manual" }),
      config: h.config,
      // no onPermission handler, and the mode asks first
    })

    await agent.run({ sessionId: session.id, input: "write a file", workingDir: h.workingDir })

    expect(existsSync(join(h.workingDir, "x.txt"))).toBe(false)
    const toolMessage = h.sessions.getMessages(session.id).find((m) => m.role === "tool")
    expect(toolMessage?.content).toContain("--yes")
    h.store.close()
    server.close()
  })

  test("permission defaults to auto: tools run with no handler and no prompt", async () => {
    const argsJson = JSON.stringify({ path: "auto.txt", content: "allowed" })
    const server = startFakeServer([toolCallScript("call_1", "write", argsJson), textScript("Wrote it.")])

    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      // deliberately no onPermission handler
    })

    await agent.run({ sessionId: session.id, input: "write a file", workingDir: h.workingDir, verifyChanges: false })

    expect(existsSync(join(h.workingDir, "auto.txt"))).toBe(true)
    h.store.close()
    server.close()
  })

  test("auto-allowed read tool runs without a handler", async () => {
    const server = startFakeServer([
      toolCallScript("call_1", "read", JSON.stringify({ path: "seed.txt" })),
      textScript("I read it."),
    ])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { writeFileSync } = await import("node:fs")
    writeFileSync(join(h.workingDir, "seed.txt"), "file contents")

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
    })

    await agent.run({ sessionId: session.id, input: "read seed.txt", workingDir: h.workingDir })

    const toolMessage = h.sessions.getMessages(session.id).find((m) => m.role === "tool")
    expect(toolMessage?.content).toContain("file contents")
    h.store.close()
    server.close()
  })

  test("maxSteps stops runaway loops", async () => {
    // always responds with a tool call — a loop that never ends on its own
    const argsJson = JSON.stringify({ path: "loop.txt", content: "again" })
    const server = startFakeServer([toolCallScript("call_1", "write", argsJson)])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "loop forever",
      workingDir: h.workingDir,
      maxSteps: 3,
    })

    expect(result.steps).toBe(3)
    h.store.close()
    server.close()
  })

  test("there is no step cap by default: the run continues past 40 rounds", async () => {
    const argsJson = JSON.stringify({ path: "loop.txt", content: "again" })
    // a tool call for 45 rounds, then a plain answer — the old default cap was 40
    const scripts = [
      ...Array.from({ length: 45 }, () => toolCallScript("call_1", "write", argsJson)),
      textScript("finished at last"),
    ]
    const server = startFakeServer(scripts)
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "keep going",
      workingDir: h.workingDir,
      verifyChanges: false,
    })

    expect(result.steps).toBe(46)
    expect(result.text).toContain("finished at last")
    h.store.close()
    server.close()
  })

  test("an explicit maxSteps cap still stops a runaway loop", async () => {
    const argsJson = JSON.stringify({ path: "loop.txt", content: "again" })
    const server = startFakeServer([toolCallScript("call_1", "write", argsJson)])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "loop forever",
      workingDir: h.workingDir,
      maxSteps: 5,
      verifyChanges: false,
      onEvent,
    })

    expect(result.steps).toBe(5)
    // the user is told the cap was hit, not left wondering why it stopped
    const notice = events.find((event) => event.type === "notice" && event.text.includes("max-steps"))
    expect(notice).toBeDefined()
    h.store.close()
    server.close()
  })

  test("a very long run is announced, not blocked", async () => {
    const argsJson = JSON.stringify({ path: "loop.txt", content: "again" })
    const scripts = [
      ...Array.from({ length: 100 }, () => toolCallScript("call_1", "write", argsJson)),
      textScript("done"),
    ]
    const server = startFakeServer(scripts)
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "keep going",
      workingDir: h.workingDir,
      verifyChanges: false,
      onEvent,
    })

    expect(result.steps).toBe(101)
    const notice = events.find((event) => event.type === "notice" && event.text.includes("still working"))
    expect(notice).toBeDefined()
    h.store.close()
    server.close()
  })

  test("an answer cut off by the output limit is carried on, not dropped", async () => {
    const server = startFakeServer([
      lengthScript("The parser reads the first token", " and then"),
      textScript(" continues here and finishes."),
    ])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
    })

    const result = await agent.run({ sessionId: session.id, input: "explain", workingDir: h.workingDir, onEvent })

    // both halves are present, in order, with nothing repeated
    expect(result.text).toContain("The parser reads the first token and then")
    expect(result.text).toContain("continues here and finishes.")
    expect(result.steps).toBe(2)

    // a continuation was announced, and the model was told not to repeat itself
    expect(events.some((event) => event.type === "continuation")).toBe(true)
    const secondMessages = server.requests[1]!.messages as Array<Record<string, unknown>>
    const continueMessage = secondMessages.at(-1)!
    expect(continueMessage.role).toBe("user")
    expect(String(continueMessage.content)).toContain("cut off by the output limit")
    expect(String(continueMessage.content)).toContain("Do not repeat")

    h.store.close()
    server.close()
  })

  test("a request refused for being too large is compacted and retried", async () => {
    const server = startFakeServer([overflowResponse(), textScript("Recovered after compacting.")])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
    })

    // a small window, so the planner has something to fold away
    const result = await agent.run({
      sessionId: session.id,
      input: "do the thing",
      workingDir: h.workingDir,
      contextWindow: 4096,
      onEvent,
    })

    // the raw engine error never reached the caller, and the retry was an
    // overflow compaction (not just the pre-flight budget trim)
    expect(result.text).toContain("Recovered after compacting")
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(
      events.some((event) => event.type === "compacted" && event.reason === "overflow"),
    ).toBe(true)
    // it took two attempts: the refused request, then the good one
    expect(server.requests.length).toBe(2)

    h.store.close()
    server.close()
  })

  test("a tool call cut off mid-payload becomes a request to continue", async () => {
    // the write call's arguments are truncated: the JSON never closes
    const truncated = toolCallScript("call_1", "write", JSON.stringify({ path: "big.txt", content: "x".repeat(50) }))
    const server = startFakeServer([
      // drop the final DONE so the payload looks unterminated, then a clean reply
      truncated.replace("data: [DONE]\n\n", ""),
      textScript("I'll write it in pieces instead."),
    ])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({ sessionId: session.id, input: "write big.txt", workingDir: h.workingDir, onEvent })

    // it did not fail; it recovered and asked itself to continue
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(result.text).toContain("write it in pieces")
    h.store.close()
    server.close()
  })

  test("a near-miss tool call written as prose is recovered, never printed", async () => {
    const callJson = JSON.stringify({ name: "write", arguments: { path: "leak.txt", content: "ok" } })
    const server = startFakeServer([textScript(`Writing that now: ${callJson}`), textScript("Done.")])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({
      sessionId: session.id,
      input: "create leak.txt",
      workingDir: h.workingDir,
      verifyChanges: false,
      onEvent,
    })

    // the intended tool ran…
    expect(existsSync(join(h.workingDir, "leak.txt"))).toBe(true)
    expect(result.steps).toBe(2)
    // …and the prose was kept while the JSON payload never reached the screen
    const shown = displayedText(events)
    expect(shown).toContain("Writing that now:")
    expect(shown).toContain("Done.")
    expect(shown).not.toContain('"name"')
    expect(shown).not.toContain('"arguments"')
    h.store.close()
    server.close()
  })

  test("a tool call written inside a fence is retracted with its fence", async () => {
    const callJson = JSON.stringify({ name: "write", arguments: { path: "fenced.txt", content: "hi" } })
    const server = startFakeServer([
      textScript("Let me write it.\n```json\n", callJson),
      textScript("Saved."),
    ])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    await agent.run({
      sessionId: session.id,
      input: "write fenced.txt",
      workingDir: h.workingDir,
      verifyChanges: false,
      onEvent,
    })

    expect(existsSync(join(h.workingDir, "fenced.txt"))).toBe(true)
    const resets = events.filter((event) => event.type === "text-reset")
    expect(resets).toHaveLength(1)
    expect((resets[0] as { text: string }).text).toBe("Let me write it.\n")
    const shown = displayedText(events)
    expect(shown).not.toContain("```json")
    expect(shown).not.toContain('"name"')
    h.store.close()
    server.close()
  })

  test("a tool the model invented is reported, not printed", async () => {
    const server = startFakeServer([textScript('{"name": "teleport", "arguments": {"to": "mars"}}')])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
    })

    const result = await agent.run({ sessionId: session.id, input: "go", workingDir: h.workingDir, onEvent })

    const notices = events.filter((event) => event.type === "tool-unrecognised")
    expect(notices).toHaveLength(1)
    expect((notices[0] as { detail: string }).detail).toContain("teleport")
    expect(displayedText(events)).toBe("")
    expect(result.text).toBe("")
    h.store.close()
    server.close()
  })

  test("a turn that changed files asks for a check before it finishes", async () => {
    const callJson = JSON.stringify({ name: "write", arguments: { path: "checked.txt", content: "x" } })
    const server = startFakeServer([
      textScript(callJson),
      textScript("I created checked.txt."),
      textScript("Verified: checked.txt now holds the value."),
    ])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({ sessionId: session.id, input: "make checked.txt", workingDir: h.workingDir, onEvent })

    expect(existsSync(join(h.workingDir, "checked.txt"))).toBe(true)
    // the check was asked for, and named the file that changed
    const verifying = events.filter((event) => event.type === "verifying")
    expect(verifying).toHaveLength(1)
    expect((verifying[0] as { files: string[] }).files).toEqual(["checked.txt"])
    // the model was told to confirm the change landed before answering
    const lastRequest = server.requests.at(-1)!.messages as Array<Record<string, unknown>>
    expect(JSON.stringify(lastRequest)).toContain("confirm that the changes you just made actually landed")
    expect(result.steps).toBe(3)
    expect(result.text).toContain("Verified")
    h.store.close()
    server.close()
  })

  test("no check is asked for when the model inspected the file itself", async () => {
    const callJson = JSON.stringify({ name: "write", arguments: { path: "seen.txt", content: "y" } })
    const server = startFakeServer([
      textScript(callJson),
      toolCallScript("call_2", "read", JSON.stringify({ path: "seen.txt" })),
      textScript("Done: seen.txt holds y."),
    ])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
      onPermission: async () => true,
    })

    const result = await agent.run({ sessionId: session.id, input: "make seen.txt", workingDir: h.workingDir, onEvent })

    expect(events.some((event) => event.type === "verifying")).toBe(false)
    expect(result.steps).toBe(3)
    expect(result.text).toContain("Done")
    h.store.close()
    server.close()
  })

  test("an ordinary JSON answer is still shown to the user", async () => {
    const server = startFakeServer([textScript('{"answer": 42}')])
    const h = await harness(server.url)
    const session = h.sessions.create({ workingDir: h.workingDir, model: "test-model" })
    const { events, onEvent } = collectingEvents()

    const agent = new Agent({
      sessions: h.sessions,
      providers: h.providers,
      tools: h.tools,
      permissions: new PermissionManager(h.store, { rules: [], disabledTools: [] }),
      config: h.config,
    })

    const result = await agent.run({ sessionId: session.id, input: "give me json", workingDir: h.workingDir, onEvent })

    expect(result.text).toBe('{"answer": 42}')
    expect(displayedText(events)).toBe('{"answer": 42}')
    h.store.close()
    server.close()
  })
})

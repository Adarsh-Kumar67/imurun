#!/usr/bin/env bun
/**
 * Diagnostic: does llama-server survive a second chat request?
 *
 * Reproduces the "ECONNREFUSED on the second turn" report by starting the
 * engine with the real flags and sending two chat completions in a row.
 */
import { join } from "node:path"
import { listInstalled } from "@imurun/modelmgr"
import { LlamaCppEngine } from "../packages/runtime/src/engines/llama-cpp"
import { imurunDir, readText } from "@imurun/util"

const target = (process.argv[2] ?? "qwen2.5-coder-7b").toLowerCase()
const port = Number(process.argv[3] ?? 42500)
const logFile = join(imurunDir("logs"), `diag-${port}.log`)

const installed = await listInstalled()
const model = installed.find((m) => m.modelId.toLowerCase().includes(target))
if (!model) {
  console.error(`no installed model matching ${target}: ${installed.map((m) => m.id).join(", ")}`)
  process.exit(1)
}

const engine = new LlamaCppEngine()
console.log(`starting ${model.id} on port ${port} … log: ${logFile}`)
const handle = await engine.start({
  modelPath: model.path,
  modelName: model.modelId,
  port,
  logFile,
  contextSize: 8192,
})
console.log(`ready pid=${handle.pid}`)

async function chat(messages: unknown[]): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: model!.modelId, messages, stream: false, max_tokens: 64 }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  return text.slice(0, 200)
}

const history: unknown[] = []
for (let i = 1; i <= 4; i++) {
  history.push({ role: "user", content: `Message number ${i}. Reply with one short sentence.` })
  try {
    const reply = await chat(history)
    console.log(`request ${i}: ok — ${reply}`)
    history.push({ role: "assistant", content: "ok" })
    history.push({ role: "tool", content: "x".repeat(2000), tool_call_id: "t1" })
  } catch (error) {
    console.error(`request ${i}: FAILED — ${(error as Error).message}`)
    break
  }
}

const alive = await engine.health(port).catch((e) => ({ healthy: false, detail: String(e) }))
console.log(`final health: ${JSON.stringify(alive)}`)
await engine.stop(handle).catch(() => {})
console.log(`--- log tail ---`)
try {
  const log = await readText(logFile)
  console.log(log.split(/\r?\n/).slice(-25).join("\n"))
} catch {
  console.log("(no log written)")
}

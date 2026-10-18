/**
 * TUI demo — exercises the interactive surface without attaching a terminal,
 * so it runs unattended (CI, pipes, cmd.exe). It boots a TuiApp against a
 * scratch project database and drives the pure building blocks the full-screen
 * app is made of: the key parser, the selection palette, the transcript
 * renderer, and the command registry.
 *
 *   bun run scripts/demo-tui.ts
 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImurunDatabase, defaultAgent, loadConfigSafe } from "@imurun/core"
import { KeyParser, Palette, TuiApp, renderTranscript } from "@imurun/tui"
import type { Block, KeyEvent } from "@imurun/tui"

function describe(key: KeyEvent): string {
  if (key.ctrl) return `ctrl+${key.input}`
  if (key.name) return key.name
  return JSON.stringify(key.input ?? "")
}

async function main(): Promise<number> {
  const workingDir = await mkdtemp(join(tmpdir(), "imurun-tui-"))
  const { loaded } = await loadConfigSafe(workingDir)
  const database = await ImurunDatabase.openProject(workingDir)

  const app = new TuiApp({ version: "0.1.0-demo", workingDir, database, config: loaded.config })
  await app.reloadAgents()
  app.agent = defaultAgent(app.agents)

  // 1) raw input → key events (arrow keys, ctrl+c, typed text)
  const parser = new KeyParser()
  const keys = parser.push("\u001b[A\u001b[Z\u0003/model")
  console.log(`keys: ${keys.map(describe).join(" ")}`)

  // 2) the "/" suggestion palette filters by prefix
  const palette = new Palette(
    app.commands.names().map((name) => ({ id: name, label: `/${name}`, detail: app.commands.find(name)?.summary })),
    { title: "commands", maxRows: 5 },
  )
  palette.setQuery("mod")
  console.log(`palette("mod"): ${palette.items.map((item) => item.label).join(", ")}`)

  // 3) transcript blocks → styled lines
  const blocks: Block[] = [
    { kind: "user", text: "which model am I running?" },
    { kind: "tool", title: "registry", status: "ok", detail: "read installed models" },
    { kind: "assistant", text: "You are on the model selected in this session." },
    { kind: "notice", text: "model ready", tone: "ok" },
  ]
  for (const line of renderTranscript(blocks, 72)) console.log(line)

  // 4) command surface — the app is not attached to a screen, so these write
  //    to the transcript buffer (no render, no terminal needed)
  app.printCommands()
  app.showAgents()
  app.showTools()
  await app.showStatus()

  await app.shutdown(0)
  console.log("\ndemo ok")
  return 0
}

process.exit(await main())

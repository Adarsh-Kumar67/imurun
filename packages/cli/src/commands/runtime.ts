/**
 * imurun runtime — manage the local inference runtime.
 *
 *   imurun runtime status                 show engine, port, health, uptime
 *   imurun runtime start                  start + supervise (Ctrl+C stops)
 *   imurun runtime start --background     start with a detached supervisor
 *   imurun runtime stop                   stop everything, free RAM
 *   imurun runtime restart                stop + start
 *   imurun runtime logs                   show the runtime log tail
 */
import { loadConfigSafe } from "@imurun/core"
import { RuntimeManager, describeContext } from "@imurun/runtime"
import chalk from "chalk"
import { formatDuration, imurunDir, readText, truncate } from "@imurun/util"
import { join } from "node:path"
import type { Command } from "../framework/command"

function parseModelOption(model: string | undefined): { modelPath?: string; modelName?: string } {
  if (!model) return {}
  return model.toLowerCase().endsWith(".gguf") ? { modelPath: model } : { modelName: model }
}

export const runtimeCommand: Command = {
  name: "runtime",
  summary: "Manage the local inference runtime",
  usage: "imurun runtime <status|start|stop|restart|logs> [--background] [--model <name|path>] [--engine llama-cpp|ollama] [--port <n>]",
  options: [
    { name: "background", short: "b", type: "boolean", description: "Start with a detached supervisor (survives this terminal)" },
    { name: "model", type: "string", description: "Ollama model name (qwen2.5-coder:7b) or path to a .gguf file" },
    { name: "engine", type: "string", description: "Engine to use: llama-cpp (default) or ollama" },
    { name: "port", type: "string", description: "Port for the local OpenAI-compatible API" },
    { name: "tail", type: "string", description: "Number of log lines to show (default 40)" },
  ],

  async run({ args, options }) {
    const sub = args[0] ?? "status"
    const { loaded } = await loadConfigSafe(process.cwd())
    const config = loaded.config

    // runtime package is the implementation; core re-exports config only
    const manager = new RuntimeManager(config)

    switch (sub) {
      case "status":
        return statusCommand(manager)

      case "start": {
        const model = parseModelOption(options.model as string | undefined)
        const port = options.port ? Number(options.port) : undefined
        const engineId = options.engine as string | undefined

        const state = await manager.start({ ...model, port, engineId })
        console.log(
          `\n  ${chalk.green("●")} runtime started — ${chalk.bold(state.engine)} on port ${chalk.cyan(String(state.port))}` +
            (state.model ? ` ${chalk.gray(`model ${state.model}`)}` : ""),
        )

        if (options.background === true) {
          const pid = await manager.spawnSupervisor()
          console.log(`  ${chalk.gray(`detached supervisor pid ${pid}; it unloads on idle or when clients disconnect`)}`)
          console.log(`  ${chalk.gray("stop it any time with: imurun runtime stop")}\n`)
          return 0
        }

        console.log(`  ${chalk.gray("supervising — the model stops when this terminal closes (Ctrl+C)")}\n`)
        const reason = await manager.supervise(state)
        console.log(`\n  ${chalk.gray(`runtime stopped (${reason}) — memory released`)}\n`)
        return 0
      }

      case "stop":
        await manager.stop()
        console.log(`\n  ${chalk.green("✔")} runtime stopped — RAM freed\n`)
        return 0

      case "restart": {
        const model = parseModelOption(options.model as string | undefined)
        const port = options.port ? Number(options.port) : undefined
        const state = await manager.restart({ ...model, port, engineId: options.engine as string | undefined })
        if (options.background === true) {
          await manager.spawnSupervisor()
          console.log(`\n  ${chalk.green("●")} runtime restarted in background (port ${state.port})\n`)
          return 0
        }
        console.log(`\n  ${chalk.green("●")} runtime restarted (port ${state.port}) — supervising\n`)
        const reason = await manager.supervise(state)
        console.log(`\n  ${chalk.gray(`runtime stopped (${reason})`)}\n`)
        return 0
      }

      case "logs": {
        const tail = Math.max(Number(options.tail ?? 40), 1)
        const logPath = join(imurunDir("logs"), "runtime.log")
        let content: string
        try {
          content = await readText(logPath)
        } catch {
          console.log(`\n  ${chalk.gray(`no runtime log yet (${logPath})`)}\n`)
          return 0
        }
        const lines = content.split(/\r?\n/)
        const shown = lines.slice(-tail)
        console.log("")
        for (const line of shown) console.log(`  ${chalk.gray(truncate(line, 160))}`)
        console.log("")
        return 0
      }

      default:
        console.error(`  ✖ Unknown subcommand: ${sub}`)
        console.error("  Try: imurun runtime status | start | stop | restart | logs")
        return 1
    }
  },
}

async function statusCommand(manager: RuntimeManager): Promise<number> {
  const status = await manager.status()

  console.log("")
  if (status.running && status.state) {
    const uptime = formatDuration(Date.now() - status.state.startedAt)
    console.log(`  ${chalk.green("● running")}  ${chalk.bold(status.state.engine)} port ${chalk.cyan(String(status.state.port))}`)
    if (status.state.model) console.log(`    model:      ${chalk.white(status.state.model)}`)
    const context = describeContext(status.state)
    if (context) {
      console.log(
        `    context:    ${chalk.white(context.window)}${context.detail ? chalk.gray(`  ${context.detail}`) : ""}`,
      )
    }
    console.log(`    uptime:     ${uptime}`)
    if (status.supervisorPid) console.log(`    supervisor: pid ${status.supervisorPid}`)
    if (status.health?.detail) console.log(`    health:     ${status.health.detail}`)
  } else if (status.state) {
    console.log(`  ${chalk.yellow("○ stopped")}  (stale state for ${status.state.engine}, port ${status.state.port})`)
    console.log(`    ${chalk.gray(status.health?.detail ?? "engine not reachable")}`)
  } else {
    console.log(`  ${chalk.gray("○ not running")}`)
    console.log(`    ${chalk.gray("start it with: imurun run \"<task>\" or imurun runtime start")}`)
  }

  console.log("")
  console.log(`  ${chalk.gray("engines:")}`)
  for (const engine of status.engines) {
    const badge = engine.available ? chalk.green("✔") : chalk.gray("✖")
    console.log(`    ${badge} ${engine.displayName} ${chalk.gray(engine.detail ?? "")}`)
  }
  console.log("")
  return 0
}

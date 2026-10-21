/**
 * imurun deep — run a model that does not fit.
 *
 * The GGUF catalog is made of models small enough to sit in memory. This
 * command is the other path: AirLLM streams a model's layers from disk, so a
 * 32B or 70B model answers on a laptop with a 4 GB card. It is slow, and it
 * is the difference between "that model cannot run here" and "that model runs
 * here, eventually".
 *
 *   imurun deep                     what can run deeply, and whether it can
 *   imurun deep <repo|id|path>      install the engine if needed, then run it
 *   imurun deep --stop              stop the deep engine
 *   imurun deep --no-start          set it up without starting it
 */
import chalk from "chalk"
import { existsSync } from "node:fs"
import { loadConfigSafe, patchGlobalConfig } from "@imurun/core"
import {
  DEEP_MODELS,
  airllmEngineDir,
  airllmVenvPython,
  ensureAirllmEngine,
  findDeepModel,
  looksLikeRepo,
} from "@imurun/modelmgr"
import { AirLlmEngine, RuntimeManager, probeAirllm } from "@imurun/runtime"
import type { Command } from "../framework/command"

/** A live line while something slow is happening, cleared when it ends. */
function liveLabel(): { set(message: string): void; clear(): void } {
  let current = ""
  const quiet = !process.stdout.isTTY
  const draw = () => {
    if (quiet) return
    process.stdout.write(`\r\x1b[2K  ${current}`)
  }
  return {
    set(message: string) {
      current = message
      if (quiet) {
        // One line per change is kind to a log file.
        if (message) console.log(`  ${message}`)
        return
      }
      draw()
    },
    clear() {
      if (!quiet) process.stdout.write("\r\x1b[2K")
      current = ""
    },
  }
}

export const deepCommand: Command = {
  name: "deep",
  summary: "Run a model larger than this machine using AirLLM (streamed from disk)",
  usage: "imurun deep [repo|model-id|directory] [--stop] [--no-start]",
  options: [
    { name: "stop", type: "boolean", description: "Stop the deep engine and free the memory" },
    { name: "no-start", type: "boolean", description: "Install and select the model, but do not start it" },
    { name: "no-install", type: "boolean", description: "Do not install airllm/torch even when missing" },
  ],

  async run({ args, options }) {
    const { loaded } = await loadConfigSafe(process.cwd())
    const config = loaded.config
    const manager = new RuntimeManager(config)

    if (options.stop === true) {
      await manager.stop()
      console.log("")
      console.log(`  ${chalk.green("\u2714")} ${chalk.gray("the deep engine is stopped")}`)
      console.log("")
      return 0
    }

    const query = args[0]

    // ── no argument: what can run, and what is needed ──────────────────────
    if (!query) {
      const python = airllmVenvPython()
      const engine = new AirLlmEngine(config.runtime.airllm.python)
      const availability = await engine.isAvailable()
      const status = await probeAirllm(config.runtime.port).catch(() => undefined)

      console.log("")
      console.log(`  ${chalk.bold("The deep engine")} ${chalk.gray("AirLLM: layers streamed from disk")}`)
      console.log("")
      console.log(
        `  ${python ? chalk.green("\u2714") : chalk.yellow("\u26a0")} ` +
          chalk.gray(python ? `airllm and torch are installed (${python})` : "airllm is not installed yet"),
      )
      if (!python) {
        console.log(`    ${chalk.gray("install it:")} ${chalk.cyan("imurun setup --deep")}`)
        console.log(`    ${chalk.gray("or run a model below and it will be installed on the way")}`)
      }
      console.log(`  ${chalk.gray(availability.detail ?? "")}`)
      if (status?.stage) {
        const percent = typeof status.percent === "number" ? ` ${status.percent}%` : ""
        console.log(`  ${chalk.cyan("\u25cf")} ${chalk.gray(`running: ${status.stage}${percent} ${status.detail ?? ""}`)}`)
      }
      console.log("")
      console.log(`  ${chalk.bold("What can run deeply")}`)
      console.log("")
      for (const model of DEEP_MODELS) {
        const gated = model.gated ? chalk.yellow(" needs HF access") : ""
        console.log(
          `    ${chalk.cyan(model.id.padEnd(30))} ${chalk.gray(`${model.paramsB}B · ${model.license}`)}${gated}`,
        )
        console.log(`      ${chalk.gray(model.description)}`)
      }
      console.log("")
      console.log(`  ${chalk.gray("Run one:")} ${chalk.cyan("imurun deep Qwen/Qwen2.5-Coder-32B-Instruct")}`)
      console.log(`  ${chalk.gray("Or any repo:")} ${chalk.cyan("imurun deep <owner>/<model>")}`)
      console.log(`  ${chalk.gray("Or local weights:")} ${chalk.cyan("imurun deep C:\\models\\my-model")}`)
      console.log("")
      return 0
    }

    // ── resolve the reference ──────────────────────────────────────────────
    const known = findDeepModel(query)
    let repo: string
    let label: string
    if (known) {
      repo = known.repo
      label = known.displayName
    } else if (looksLikeRepo(query) || existsSync(query)) {
      repo = query
      label = query.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() ?? query
    } else {
      console.log("")
      console.log(
        `  ${chalk.yellow("\u26a0")} ${chalk.gray(`"${query}" is not a deep model id, a repo (owner/name), or a directory.`)}`,
      )
      console.log(`  ${chalk.gray("Run")} ${chalk.cyan("imurun deep")} ${chalk.gray("to see the list.")}`)
      console.log("")
      return 1
    }

    // ── the engine ─────────────────────────────────────────────────────────
    const engineStatus = await new AirLlmEngine(config.runtime.airllm.python).isAvailable()
    if (!engineStatus.available) {
      console.log("")
      console.log(`  ${chalk.yellow("\u26a0")} ${chalk.gray(engineStatus.detail ?? "Python 3 is required.")}`)
      console.log("")
      return 1
    }

    const venv = airllmVenvPython()
    if (!venv && options["no-install"] !== true) {
      console.log("")
      console.log(`  ${chalk.bold("Setting up the deep engine")} ${chalk.gray(`(${airllmEngineDir()})`)}`)
      console.log("")
      const live = liveLabel()
      const result = await ensureAirllmEngine({
        python: config.runtime.airllm.python,
        onStatus: (line) => live.set(chalk.gray(line.slice(0, 140))),
      })
      live.clear()
      if (!result.installed) {
        console.log("")
        console.log(`  ${chalk.yellow("\u26a0")} ${chalk.gray(result.reason ?? "the deep engine could not be installed")}`)
        console.log("")
        return 1
      }
      console.log(`  ${chalk.green("\u2714")} ${chalk.gray("airllm and torch are ready")}`)
      console.log("")
    }

    // ── remember it, so the next start is `imurun` on its own ──────────────
    const ref = `airllm/${repo}`
    await patchGlobalConfig({ model: ref })
    console.log("")
    console.log(`  ${chalk.green("\u2714")} ${chalk.bold(label)} ${chalk.gray("is now the default model")}`)
    console.log(`    ${chalk.gray(ref)}`)
    console.log(
      `  ${chalk.gray("The first answer downloads the weights (tens of GB) and then loads them layer by layer.")}`,
    )

    if (options["no-start"] === true) {
      console.log(`  ${chalk.gray("Start it with")} ${chalk.cyan("imurun runtime start")} ${chalk.gray("or just")} ${chalk.cyan("imurun")}`)
      console.log("")
      return 0
    }

    // ── start it, and say what is happening ────────────────────────────────
    console.log("")
    const live = liveLabel()
    live.set(chalk.gray(`starting the deep engine for ${label}`))
    try {
      await manager.start({
        engineId: "airllm",
        modelRepo: repo,
        modelName: label,
        nativeContextSize: known?.contextLength,
      })
      live.clear()
      console.log(`  ${chalk.green("\u2714")} ${chalk.gray("the deep engine is listening on port")} ${chalk.cyan(String(config.runtime.port))}`)
      const health = await manager.status()
      if (health.health?.detail) console.log(`    ${chalk.gray(health.health.detail)}`)
      console.log("")
      console.log(`  ${chalk.gray("Start the interface with")} ${chalk.cyan("imurun")} ${chalk.gray("- it will use this model.")}`)
      console.log("")
      return 0
    } catch (error) {
      live.clear()
      console.log("")
      console.log(`  ${chalk.yellow("\u26a0")} ${chalk.gray((error as Error).message)}`)
      console.log("")
      return 1
    }
  },
}

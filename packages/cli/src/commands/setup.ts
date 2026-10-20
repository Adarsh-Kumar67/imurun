/**
 * imurun setup — put this machine in a state where IMURUN can actually run.
 *
 * Installing the program is only half of it. To answer a question you also
 * need the inference engine and a model file, and until both are there the
 * command does nothing useful. This command does that part, with no
 * questionnaire: it looks at the machine, picks the model that fits, installs
 * the engine and downloads the model.
 *
 * The same work happens automatically when the program is installed, so most
 * people never need this — it is here for the machine that was set up by
 * hand, or the one whose model was deleted.
 */
import chalk from "chalk"
import { loadConfigSafe } from "@imurun/core"
import {
  autoSetup,
  CATALOG,
  createInstallRenderer,
  fittingModels,
  listInstalled,
  loadHardware,
} from "@imurun/modelmgr"
import type { Command } from "../framework/command"

export const setupCommand: Command = {
  name: "setup",
  summary: "Install the engine and a model that fits this machine",
  usage: "imurun setup [model-id] [--check] [--force] [--quiet]",
  options: [
    { name: "check", type: "boolean", description: "Say what would be installed, and stop" },
    { name: "force", type: "boolean", description: "Install even when a model is already there" },
    { name: "quiet", type: "boolean", description: "Only report the result" },
  ],

  async run({ args, options }) {
    const { loaded } = await loadConfigSafe(process.cwd())
    const config = loaded.config
    const modelId = args[0]
    const quiet = options.quiet === true

    if (options.check === true) {
      const installed = await listInstalled()
      const hardware = await loadHardware()
      const fitting = fittingModels(hardware, CATALOG)
      console.log("")
      console.log(`  ${chalk.bold("What is already here")}`)
      if (installed.length === 0) console.log(`    ${chalk.gray("no model installed")}`)
      for (const model of installed) {
        console.log(`    ${chalk.green("✔")} ${chalk.cyan(model.id)} ${chalk.gray(`· ${model.quant}`)}`)
      }
      console.log("")
      console.log(`  ${chalk.bold("What would be installed")}`)
      const pick = fitting[0]
      if (!pick) {
        console.log(`    ${chalk.yellow("nothing in the catalog fits this machine's memory")}`)
      } else {
        const variant = pick.model.quantizations.find((q) => q.type === pick.recommendedQuant)
        console.log(
          `    ${chalk.cyan(pick.model.id)} ${chalk.gray(pick.recommendedQuant)}` +
            `${variant ? chalk.gray(` · about ${variant.sizeGB.toFixed(1)} GB`) : ""} — ${pick.reason}`,
        )
      }
      console.log("")
      return 0
    }

    if (!quiet) {
      console.log("")
      console.log(`  ${chalk.bold("IMURUN")} ${chalk.gray("setting this machine up")}`)
      console.log("")
    }

    const renderer = createInstallRenderer(quiet ? { write: () => {} } : undefined)
    const result = await autoSetup({
      config,
      force: options.force === true,
      modelId,
      onStatus: (message) => {
        if (!quiet) console.log(`  ${chalk.gray("·")} ${chalk.gray(message)}`)
      },
      onEvent: (event) => renderer.onEvent(event),
    })
    renderer.dispose()

    console.log("")
    if (result.status === "installed") {
      console.log(`  ${chalk.green("✔")} ${chalk.bold("ready")} ${chalk.gray(`— ${result.model?.modelId} ${result.model?.quant}`)}`)
      console.log(`  ${chalk.gray("start it with:")} ${chalk.cyan("imurun")}`)
      console.log("")
      return 0
    }
    if (result.status === "ready") {
      console.log(`  ${chalk.green("✔")} ${chalk.gray("this machine was already set up")}`)
      console.log(`  ${chalk.gray("start it with:")} ${chalk.cyan("imurun")}`)
      console.log("")
      return 0
    }
    console.log(`  ${chalk.yellow("⚠")} ${chalk.gray(result.reason ?? "the setup did not finish")}`)
    console.log(`  ${chalk.gray("try it by hand:")} ${chalk.cyan("imurun models install <id>")}`)
    console.log("")
    return 1
  },
}

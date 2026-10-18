/**
 * imurun providers — inspect configured providers and their reachability.
 */
import { ProviderRegistry, loadConfigSafe } from "@imurun/core"
import chalk from "chalk"
import type { Command } from "../framework/command"

export const providersCommand: Command = {
  name: "providers",
  summary: "List LLM providers and their status",
  usage: "imurun providers [list]",
  options: [{ name: "dir", type: "string", description: "Project directory (default: current)" }],

  async run({ args, options }) {
    const sub = args[0] ?? "list"
    if (sub !== "list") {
      console.error(`  ✖ Unknown subcommand: ${sub}. Try: imurun providers list`)
      return 1
    }

    const workingDir = (options.dir as string | undefined) ?? process.cwd()
    const { loaded } = await loadConfigSafe(workingDir)
    const registry = new ProviderRegistry(loaded.config)
    const infos = await registry.statuses()

    console.log("")
    for (const info of infos) {
      const badge =
        info.status === "ready"
          ? chalk.green("● ready")
          : info.status === "unreachable"
            ? chalk.yellow("○ unreachable")
            : info.status === "disabled"
              ? chalk.gray("○ disabled")
              : chalk.red("● " + info.status)

      const kind = info.config.kind === "local" ? chalk.gray("[local]") : chalk.gray("[api]")
      console.log(`  ${badge}  ${chalk.bold(info.config.id)} ${kind} ${chalk.gray(info.config.type)}`)
      if (info.detail) console.log(`         ${chalk.gray(info.detail)}`)
      if (info.models.length > 0) {
        console.log(`         ${chalk.gray("models: " + info.models.slice(0, 6).join(", "))}`)
      }
    }
    console.log("")
    console.log(chalk.gray("  Add providers in imurun.json under \"providers\"."))
    console.log("")

    return 0
  },
}

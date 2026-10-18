/**
 * imurun providers — inspect configured providers, their reachability, and add
 * or remove one without opening the interface.
 *
 * The catalogue lives in the core package so the CLI and the interactive
 * interface offer exactly the same services with the same endpoints.
 */
import { PROVIDER_PRESETS, ProviderRegistry, getProviderPreset, loadConfigSafe, patchGlobalConfig, presetNeedsKey, removeGlobalConfigEntry } from "@imurun/core"
import type { ProviderConfig } from "@imurun/schema"
import chalk from "chalk"
import type { Command } from "../framework/command"

export const providersCommand: Command = {
  name: "providers",
  summary: "List, add or remove LLM providers",
  usage: "imurun providers [list | presets | add <preset> --key <k> [--url <u>] | remove <id>]",
  options: [
    { name: "dir", type: "string", description: "Project directory (default: current)" },
    { name: "key", type: "string", description: "API key (or an {env:VAR} reference)" },
    { name: "url", type: "string", description: "Endpoint, for a custom OpenAI-compatible service" },
    { name: "model", type: "string", description: "Remember this model as the active one" },
  ],

  async run({ args, options }) {
    const sub = args[0] ?? "list"
    const workingDir = (options.dir as string | undefined) ?? process.cwd()

    if (sub === "presets") {
      console.log("")
      for (const preset of PROVIDER_PRESETS) {
        console.log(`  ${chalk.bold(preset.id.padEnd(12))} ${preset.label.padEnd(24)} ${chalk.gray(preset.note)}`)
        if (preset.console) console.log(`  ${" ".repeat(12)} ${chalk.gray(`key: ${preset.console}`)}`)
      }
      console.log("")
      console.log(chalk.gray("  Add one with: imurun providers add <preset> --key <key>"))
      console.log("")
      return 0
    }

    if (sub === "add") {
      return addProvider(args[1], options as Record<string, string | undefined>)
    }

    if (sub === "remove" || sub === "rm") {
      const id = args[1]
      if (!id) {
        console.error("  ✖ Which provider? imurun providers remove <id>")
        return 1
      }
      await removeGlobalConfigEntry("providers", id)
      console.log(chalk.green(`  ✔ ${id} removed`))
      return 0
    }

    if (sub !== "list") {
      console.error(`  ✖ Unknown subcommand: ${sub}. Try: imurun providers list`)
      return 1
    }

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
    console.log(chalk.gray("  Add one: imurun providers add <preset> --key <key>"))
    console.log(chalk.gray("  Browse:  imurun providers presets"))
    console.log("")
    return 0
  },
}

/** Writes a provider from a preset into the global config. */
async function addProvider(
  id: string | undefined,
  options: Record<string, string | undefined>,
): Promise<number> {
  const preset = id ? getProviderPreset(id) : undefined
  if (!preset) {
    console.error(`  ✖ Unknown provider: ${id ?? "(none)"}. Try: imurun providers presets`)
    return 1
  }

  const baseURL = options.url ?? preset.baseURL
  if (preset.needsBaseURL && !baseURL) {
    console.error("  ✖ This provider needs an endpoint — pass --url <https://host/v1>")
    return 1
  }

  const apiKey = options.key
  if (!apiKey && presetNeedsKey(preset)) {
    console.error(`  ✖ Pass the key with --key, or --key "{env:${preset.keyEnv ?? "YOUR_VAR"}}" to read it from the environment`)
    if (preset.console) console.error(chalk.gray(`    create one at ${preset.console}`))
    return 1
  }

  const provider: ProviderConfig = {
    id: preset.id,
    kind: "api",
    type: preset.type,
    baseURL,
    apiKey,
    models: options.model ? [options.model] : [],
    enabled: true,
  }

  await patchGlobalConfig({ providers: { [provider.id]: provider } })
  if (options.model) await patchGlobalConfig({ model: `${provider.id}/${options.model}` })

  console.log(chalk.green(`  ✔ ${preset.label} added`))
  if (options.model) console.log(chalk.gray(`    active model: ${provider.id}/${options.model}`))
  console.log(chalk.gray("  Check it with: imurun providers list"))
  return 0
}

/**
 * IMURUN CLI — command framework.
 *
 * Tiny by design: commands declare a name, description, options, and a run
 * function. The router parses argv (Bun's util.parseArgs), dispatches, and
 * renders errors cleanly.
 */
import { parseArgs, type ParseArgsConfig } from "node:util"

export interface CommandOption {
  name: string
  short?: string
  type: "boolean" | "string"
  description: string
  default?: string | boolean
}

export interface CommandContext {
  args: string[]
  options: Record<string, string | boolean | undefined>
}

export interface Command {
  name: string
  summary: string
  usage?: string
  options?: CommandOption[]
  run(ctx: CommandContext): Promise<number | void>
}

export class CommandRunner {
  private commands = new Map<string, Command>()
  private fallback?: Command

  register(command: Command): this {
    this.commands.set(command.name, command)
    return this
  }

  setFallback(command: Command): this {
    this.fallback = command
    return this
  }

  list(): Command[] {
    return [...this.commands.values()]
  }

  async dispatch(argv: string[]): Promise<number> {
    const [first, ...rest] = argv
    const command = first && !first.startsWith("-") ? this.commands.get(first) : undefined
    const target = command ?? this.fallback
    const args = command ? rest : argv

    if (!target) {
      this.printHelp()
      // Asking for help is not an error; an unknown command is.
      const wantsHelp = argv.includes("--help") || argv.includes("-h")
      return wantsHelp ? 0 : 1
    }

    const parsed = this.parse(target, args)
    if (!parsed) return 1

    try {
      const code = await target.run(parsed)
      return code ?? 0
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`\n  ✖ ${message}\n`)
      return 1
    }
  }

  private parse(command: Command, args: string[]): CommandContext | undefined {
    const options: Record<string, { type: "boolean" | "string"; short?: string; default?: string | boolean }> = {}
    for (const option of command.options ?? []) {
      const entry: { type: "boolean" | "string"; short?: string; default?: string | boolean } = {
        type: option.type,
      }
      if (option.short) entry.short = option.short
      if (option.default !== undefined) entry.default = option.default
      options[option.name] = entry
    }

    const config: ParseArgsConfig = {
      args,
      allowPositionals: true,
      strict: false,
      options: options as never,
    }

    try {
      const { values, positionals } = parseArgs(config as never) as {
        values: Record<string, string | boolean | undefined>
        positionals: string[]
      }
      if (values.help) {
        this.printCommandHelp(command)
        return undefined
      }
      return { args: positionals, options: values }
    } catch (error) {
      console.error(`  ✖ ${(error as Error).message}`)
      this.printCommandHelp(command)
      return undefined
    }
  }

  printHelp(): void {
    console.log("")
    console.log("  IMURUN — local-first AI coding agent")
    console.log("")
    console.log("  Usage: imurun [command] [options]")
    console.log("")
    console.log("  Commands:")
    for (const command of this.commands.values()) {
      console.log(`    ${command.name.padEnd(12)} ${command.summary}`)
    }
    console.log("")
    console.log("  Run `imurun help <command>` or `imurun <command> --help` for details.")
    console.log("")
  }

  printCommandHelp(command: Command): void {
    console.log("")
    console.log(`  imurun ${command.name} — ${command.summary}`)
    console.log("")
    if (command.usage) console.log(`  Usage: ${command.usage}`)
    if (command.options?.length) {
      console.log("")
      console.log("  Options:")
      for (const option of command.options) {
        const flag = option.short ? `-${option.short}, --${option.name}` : `    --${option.name}`
        console.log(`    ${flag.padEnd(24)} ${option.description}`)
      }
    }
    console.log("")
  }
}

#!/usr/bin/env bun
/**
 * IMURUN — local-first AI coding agent.
 *
 * Running with no arguments opens the interactive UI; every capability is also
 * available as a subcommand for scripting.
 */
import chalk from "chalk"
import { CommandRunner } from "./framework/command"
import { runCommand } from "./commands/run"
import { chatCommand } from "./commands/chat"
import { sessionsCommand } from "./commands/sessions"
import { providersCommand } from "./commands/providers"
import { runtimeCommand } from "./commands/runtime"
import { modelsCommand } from "./commands/models"
import { ragCommand } from "./commands/rag"
import { skillsCommand } from "./commands/skills"
import { VERSION } from "./version"

async function main(): Promise<number> {
  const argv = process.argv.slice(2)

  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`imurun ${VERSION}`)
    return 0
  }

  const runner = new CommandRunner()
    .register(chatCommand)
    .register(runCommand)
    .register(modelsCommand)
    .register(sessionsCommand)
    .register(providersCommand)
    .register(runtimeCommand)
    .register(skillsCommand)
    .register(ragCommand)

  runner.register({
    name: "version",
    summary: "Print the IMURUN version",
    async run() {
      console.log(`imurun ${VERSION}`)
    },
  })

  runner.register({
    name: "help",
    summary: "Show help for a command",
    async run({ args }) {
      const target = args[0]
      if (target) {
        const command = runner.list().find((c) => c.name === target)
        if (!command) {
          console.error(`  ✖ Unknown command: ${target}`)
          return 1
        }
        runner.printCommandHelp(command)
      } else {
        runner.printHelp()
      }
    },
  })

  // No arguments → open the interactive UI when there is a terminal; otherwise
  // fall back to a short usage summary (pipes, CI, `imurun | cat`).
  if (argv.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const code = await chatCommand.run({ args: [], options: {} })
      return code ?? 0
    }
    console.log("")
    console.log(`  ${chalk.bold.cyan("IMURUN")} — your code. your machine. your model.`)
    console.log("")
    console.log(`    ${chalk.cyan("imurun")}                          open the interactive UI`)
    console.log(`    ${chalk.cyan('imurun run "fix the login bug"')}   run a task non-interactively`)
    console.log(`    ${chalk.cyan("imurun models")}                    see models for this machine`)
    console.log(`    ${chalk.cyan("imurun skills")}                    list, inspect and import skills`)
    console.log(`    ${chalk.cyan("imurun rag")}                       search the offline project index`)
    console.log(`    ${chalk.cyan("imurun sessions")}                  list past sessions`)
    console.log(`    ${chalk.cyan("imurun runtime status")}            local inference runtime`)
    console.log("")
    return 0
  }

  return runner.dispatch(argv)
}

process.exitCode = await main()

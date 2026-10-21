/**
 * imurun uninstall — remove the program, and leave the data alone.
 *
 * The distinction is the whole point of this command. The program is a few
 * megabytes you can install again in a minute; the models are gigabytes you
 * would have to download again, and the memory is yours. So the program goes,
 * the data stays, and `--purge` is there for anyone who really means it.
 */
import chalk from "chalk"
import { describeInstallMethod, uninstall } from "@imurun/core"
import type { Command } from "../framework/command"

export const uninstallCommand: Command = {
  name: "uninstall",
  summary: "Remove IMURUN from this machine, keeping your models and memory",
  usage: "imurun uninstall [--purge] [--yes] [--dry-run]",
  options: [
    { name: "purge", type: "boolean", description: "Also delete ~/.imurun: models, memory, sessions, configuration" },
    { name: "yes", short: "y", type: "boolean", description: "Do not ask for confirmation" },
    { name: "dry-run", type: "boolean", description: "Say what would be removed, and change nothing" },
  ],

  async run({ options }) {
    const purge = options.purge === true
    const dryRun = options["dry-run"] === true

    if (dryRun) {
      const plan = uninstall({ purge, dryRun: true })
      console.log("")
      console.log(`  ${chalk.bold("IMURUN would be removed")} ${chalk.gray(`(installed with ${describeInstallMethod(plan.method)})`)}`)
      console.log("")
      for (const item of plan.removed) console.log(`    ${chalk.gray("−")} ${item}`)
      for (const item of plan.kept) console.log(`    ${chalk.green("✓")} kept: ${chalk.gray(item)}`)
      console.log("")
      return 0
    }

    if (!options.yes) {
      const answer = await ask(
        purge
          ? "Remove IMURUN and everything under ~/.imurun — all your models and memory? [y/N] "
          : "Remove IMURUN? Your models and memory are kept. [y/N] ",
      )
      if (answer.trim().toLowerCase() !== "y") {
        console.log("")
        console.log(`  ${chalk.gray("nothing was removed")}`)
        console.log("")
        return 0
      }
    }

    const result = uninstall({ purge })
    console.log("")
    if (result.removed.length > 0) {
      console.log(`  ${chalk.green("✔")} ${chalk.bold("removed")}`)
      for (const item of result.removed) console.log(`    ${chalk.gray("−")} ${item}`)
    } else {
      console.log(`  ${chalk.yellow("⚠")} ${chalk.gray("there was nothing to remove")}`)
    }
    if (result.kept.length > 0) {
      console.log("")
      console.log(`  ${chalk.green("✔")} ${chalk.bold("kept")}`)
      for (const item of result.kept) console.log(`    ${chalk.gray(item)}`)
      console.log("")
      console.log(`  ${chalk.gray("Install it again whenever you like:")} ${chalk.cyan("npm install -g imurun")}`)
      console.log(`  ${chalk.gray("Remove the data too, later:")} ${chalk.cyan("rm -rf ~/.imurun")}`)
    }
    for (const note of result.notes) console.log(`  ${chalk.gray(note)}`)
    if (result.errors.length > 0) {
      console.log("")
      for (const error of result.errors) console.log(`  ${chalk.yellow("⚠")} ${chalk.gray(error)}`)
    }
    console.log("")
    if (result.errors.length > 0) return 1
    if (result.removed.length === 0 && result.method !== "ephemeral") return 1
    return 0
  },
}

/** Reads one line from stdin, so the command can ask before removing. */
function ask(question: string): Promise<string> {
  process.stdout.write(`\n  ${question}`)
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8")
    process.stdin.once("data", (data) => resolve(String(data)))
    process.stdin.resume()
  })
}

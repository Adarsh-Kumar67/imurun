/**
 * imurun update — check for a newer release and install it.
 *
 * IMURUN is published on npm, so the update is the one npm already knows how
 * to do. This command adds the two things npm cannot: a check that says
 * whether there is anything to install, and an answer that explains what to
 * do when the install does not apply (a standalone binary, or a pip install).
 */
import chalk from "chalk"
import { checkForUpdate, compareVersions, runUpdate } from "@imurun/core"
import type { Command } from "../framework/command"
import { VERSION } from "../version"

export const updateCommand: Command = {
  name: "update",
  summary: "Check for a newer IMURUN and install it",
  usage: "imurun update [check] [--yes]",
  options: [
    { name: "check", type: "boolean", description: "Only say whether an update exists; do not install it" },
    { name: "yes", short: "y", type: "boolean", description: "Install without asking" },
  ],

  async run({ args, options }) {
    const onlyCheck = options.check === true || args[0] === "check"

    console.log("")
    console.log(`  ${chalk.bold("IMURUN")} ${chalk.gray(`v${VERSION}`)}`)
    console.log("")

    const status = await checkForUpdate(VERSION)
    if (status.error) {
      console.log(`  ${chalk.yellow("⚠")} ${chalk.gray(status.error)}`)
      console.log(`  ${chalk.gray("You can always download the newest release from")}`)
      console.log(`  ${chalk.cyan("https://github.com/ImuTechz/imurun/releases")}`)
      console.log("")
      return 1
    }

    if (!status.updateAvailable) {
      console.log(`  ${chalk.green("✔")} ${chalk.gray("You are on the newest version")} ${chalk.gray(`(${status.latest})`)}`)
      console.log("")
      return 0
    }

    console.log(`  ${chalk.cyan("→")} ${chalk.gray("A newer version is available:")} ${chalk.bold(status.latest)}`)
    console.log(`  ${chalk.gray(`(you are on ${status.current})`)}`)
    console.log("")

    if (onlyCheck) {
      console.log(`  ${chalk.gray("Run")} ${chalk.cyan("imurun update")} ${chalk.gray("to install it.")}`)
      console.log("")
      return 0
    }

    const result = runUpdate(VERSION)
    if (result.ok) {
      console.log(`  ${chalk.green("✔")} ${chalk.gray(result.message)}`)
      console.log(`  ${chalk.gray("Start IMURUN again to use it.")}`)
      console.log("")
      return 0
    }

    console.log(`  ${chalk.yellow("⚠")} ${chalk.gray(result.message)}`)
    console.log("")
    return 1
  },
}

export { compareVersions }

/**
 * imurun update — check for a newer release and install it.
 *
 * IMURUN can be installed with npm, Bun, pnpm, pip, or as a downloaded
 * executable, and each one has its own way to upgrade. This command detects
 * which one is running, says what it would do, and then does it — so an
 * update works no matter where the copy came from.
 */
import chalk from "chalk"
import {
  RELEASES_PAGE,
  checkForUpdate,
  compareVersions,
  describeCommand,
  describeInstallMethod,
  detectInstallMethod,
  planUpdate,
  probeInstallMethod,
  runUpdate,
} from "@imurun/core"
import type { Command } from "../framework/command"
import { VERSION } from "../version"

export const updateCommand: Command = {
  name: "update",
  summary: "Check for a newer IMURUN and install it",
  usage: "imurun update [check] [--yes] [--dry-run]",
  options: [
    { name: "check", type: "boolean", description: "Only say whether an update exists; do not install it" },
    { name: "yes", short: "y", type: "boolean", description: "Install without asking" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Show the update that would run for this installation, and change nothing",
    },
  ],

  async run({ args, options }) {
    const onlyCheck = options.check === true || args[0] === "check"
    const dryRun = options["dry-run"] === true

    console.log("")
    console.log(`  ${chalk.bold("IMURUN")} ${chalk.gray(`v${VERSION}`)}`)

    // How this copy was installed decides the whole upgrade path, so it is
    // said up front rather than surfacing as a surprise command.
    let method = detectInstallMethod()
    if (method === "unknown") method = probeInstallMethod()
    console.log(`  ${chalk.gray("installed with")} ${chalk.cyan(describeInstallMethod(method))}`)
    console.log("")

    const status = await checkForUpdate(VERSION)
    if (status.error) {
      console.log(`  ${chalk.yellow("\u26a0")} ${chalk.gray(status.error)}`)
      console.log(`  ${chalk.gray("You can always download the newest release from")}`)
      console.log(`  ${chalk.cyan(RELEASES_PAGE)}`)
      console.log("")
      return 1
    }

    if (!status.updateAvailable) {
      console.log(`  ${chalk.green("\u2713")} ${chalk.gray("You are on the newest version")} ${chalk.gray(`(${status.latest})`)}`)
      console.log("")
      return 0
    }

    console.log(`  ${chalk.cyan("\u2192")} ${chalk.gray("A newer version is available:")} ${chalk.bold(status.latest)}`)
    console.log(`  ${chalk.gray(`(you are on ${status.current})`)}`)
    console.log("")

    const plan = planUpdate(VERSION, { method, latest: status.latest })
    const how = describeCommand(plan.command) ?? plan.download?.url
    if (how) console.log(`  ${chalk.gray("this installation updates with:")} ${chalk.cyan(how)}`)
    else console.log(`  ${chalk.gray(plan.summary)}`)
    console.log("")

    if (onlyCheck) {
      console.log(`  ${chalk.gray("Run")} ${chalk.cyan("imurun update")} ${chalk.gray("to install it.")}`)
      console.log("")
      return 0
    }

    if (dryRun) {
      console.log(`  ${chalk.gray(plan.summary)}`)
      console.log(`  ${chalk.gray("dry run — nothing was installed")}`)
      console.log("")
      return 0
    }

    if (plan.kind === "manual") {
      console.log(`  ${chalk.gray(plan.manual ?? plan.summary)}`)
      console.log("")
      return 0
    }

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.log(`  ${chalk.gray("Not installing without confirmation. Re-run with")} ${chalk.cyan("imurun update --yes")}`)
        console.log("")
        return 1
      }
      const answer = (await ask(`Install IMURUN ${status.latest}? [Y/n] `)).trim().toLowerCase()
      if (answer === "n" || answer === "no") {
        console.log("")
        console.log(`  ${chalk.gray("left the version alone")}`)
        console.log("")
        return 0
      }
    }

    console.log(`  ${chalk.gray("installing — this can take a moment")}`)
    console.log("")
    const result = await runUpdate(VERSION, { method, latest: status.latest })
    if (result.ok) {
      console.log(`  ${chalk.green("\u2713")} ${chalk.gray(result.message)}`)
      if (result.performed) console.log(`  ${chalk.gray("Start IMURUN again to use it.")}`)
      console.log("")
      return 0
    }

    console.log(`  ${chalk.yellow("\u26a0")} ${chalk.gray(result.message)}`)
    console.log("")
    return 1
  },
}

/** Reads one line from stdin, so the command can ask before installing. */
function ask(question: string): Promise<string> {
  process.stdout.write(`\n  ${question}`)
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8")
    process.stdin.once("data", (data) => resolve(String(data)))
    process.stdin.resume()
  })
}

export { compareVersions }

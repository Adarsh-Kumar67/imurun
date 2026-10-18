/**
 * imurun sessions — list and inspect past sessions.
 */
import { ImurunDatabase, SessionStore } from "@imurun/core"
import chalk from "chalk"
import { formatTimestamp, truncate } from "@imurun/util"
import type { Command } from "../framework/command"

export const sessionsCommand: Command = {
  name: "sessions",
  summary: "List past sessions for the current project",
  usage: "imurun sessions [list] [--limit <n>] [--all] [--dir <path>]",
  options: [
    { name: "limit", type: "string", description: "Maximum sessions to show (default 15)" },
    { name: "all", type: "boolean", description: "Include sessions from other projects" },
    { name: "dir", type: "string", description: "Project directory (default: current)" },
  ],

  async run({ args, options }) {
    const sub = args[0] ?? "list"
    if (sub !== "list") {
      console.error(`  ✖ Unknown subcommand: ${sub}. Try: imurun sessions list`)
      return 1
    }

    const workingDir = (options.dir as string | undefined) ?? process.cwd()
    const limit = Number(options.limit ?? 15)

    const store = await ImurunDatabase.openProject(workingDir)
    const sessions = new SessionStore(store)
    const list = sessions.list({
      limit,
      workingDir: options.all ? undefined : workingDir,
    })

    if (list.length === 0) {
      console.log("\n  No sessions yet. Start one with: imurun run \"your task\"\n")
      store.close()
      return 0
    }

    console.log("")
    for (const session of list) {
      const when = formatTimestamp(session.updatedAt)
      const title = truncate(session.title, 50)
      console.log(
        `  ${chalk.cyan(session.id)}  ${chalk.gray(when)}  ${chalk.white(title)} ${chalk.gray(`(${session.messageCount} msgs)`)}`,
      )
    }
    console.log("")
    console.log(`  Resume with: imurun run "..." --session <id>${options.all ? "" : " --dir <path>"}`)
    console.log("")

    store.close()
    return 0
  },
}

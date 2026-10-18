/**
 * imurun chat — the interactive terminal UI.
 *
 * Running plain `imurun` with no arguments launches this too, so the first
 * thing a new user sees is a working session rather than a help screen.
 */
import { ImurunDatabase, loadConfigSafe } from "@imurun/core"
import { startTui } from "@imurun/tui"
import { VERSION } from "../version"
import type { Command } from "../framework/command"

export const chatCommand: Command = {
  name: "chat",
  summary: "Start the interactive chat UI",
  usage: "imurun chat [--dir <path>]",
  options: [{ name: "dir", type: "string", description: "Working directory (default: current)" }],

  async run({ options }) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("  ✖ The interactive UI needs a terminal.")
      console.error('    For scripted use, try:  imurun run "your task"')
      return 1
    }
    const workingDir = (options.dir as string | undefined) ?? process.cwd()
    const { loaded } = await loadConfigSafe(workingDir)
    const database = await ImurunDatabase.openProject(workingDir)
    return startTui({ version: VERSION, workingDir, database, config: loaded.config })
  },
}

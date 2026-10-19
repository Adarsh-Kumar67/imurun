/**
 * Slash commands for the TUI.
 *
 * Each command is a thin wrapper around a TuiApp method so the app owns state
 * and the command layer stays declarative and easy to extend.
 */
import { SlashRegistry, type SlashCommand } from "./slash"
import { theme } from "./theme"
import type { TuiApp } from "./app"

const COMMANDS: SlashCommand[] = [
  {
    name: "help",
    summary: "Show commands, or details for one",
    usage: "/help [command]",
    run(app, args) {
      const name = args[0]
      if (!name) {
        app.printCommands()
        return
      }
      const command = app.commands.find(name)
      if (!command) {
        app.printError(`Unknown command: /${name}`)
        return
      }
      app.print()
      app.print(`  ${theme.accent(`/${command.name}`)} — ${command.summary}`)
      if (command.usage) app.print(theme.dim(`  usage: ${command.usage}`))
      if (command.aliases?.length) app.print(theme.dim(`  aliases: ${command.aliases.map((a) => `/${a}`).join(", ")}`))
      app.print()
    },
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    summary: "Leave IMURUN and free the model's memory",
    run(app) {
      void app.shutdown(0)
    },
  },
  {
    name: "new",
    summary: "Start a fresh session",
    run(app) {
      app.newSession()
    },
  },
  {
    name: "session",
    summary: "Pick, rename, delete or resume a session",
    usage: "/session [list|rename <title>|delete <ref>|new|<number|id>]",
    aliases: ["sessions", "resume"],
    run(app, args) {
      app.sessionCommand(args)
    },
  },
  {
    name: "provider",
    summary: "Add a cloud provider (OpenAI, Anthropic, Google, Groq, NVIDIA, OpenRouter\u2026)",
    usage: "/provider [list|remove <id>|<id>]",
    run(app, args) {
      return app.providerCommand(args)
    },
  },
  {
    name: "setup",
    aliases: ["wizard", "onboard"],
    summary: "Choose where models run: this machine or online",
    run(app) {
      return app.setupWizard()
    },
  },
  {
    name: "plan",
    aliases: ["plans"],
    summary: "Show the written plan (goal, approach, steps) and update it",
    usage: "/plan [show | new <goal> | done <n> | reopen <n> | note <text> | open | clear]",
    run(app, args) {
      return app.planCommand(args)
    },
  },
  {
    name: "todo",
    aliases: ["todos"],
    summary: "Show or edit the plan the model is working through",
    usage: "/todo [list | add <step> | start <n> | done <n> | reopen <n> | rm <n> | clear-done]",
    run(app, args) {
      return app.todoCommand(args)
    },
  },
  {
    name: "clear",
    summary: "Clear the screen",
    run(app) {
      app.clearScreen()
    },
  },
  {
    name: "model",
    summary: "Switch the model (opens a picker) or download more",
    usage: "/model [ref]",
    run(app, args) {
      return app.setModel(args.join(" ").trim() || undefined)
    },
  },
  {
    name: "models",
    summary: "List installed models and machine recommendations",
    run(app) {
      return app.showModels()
    },
  },
  {
    name: "effort",
    aliases: ["reasoning"],
    summary: "Set how hard the model thinks (low/medium/high/max)",
    usage: "/effort [low|medium|high|max]",
    run(app, args) {
      return app.effortCommand(args)
    },
  },
  {
    name: "install",
    summary: "Download a model from the catalog (shows disk impact)",
    usage: "/install [model-id] [quant]",
    run(app, args) {
      return app.installCommand(args)
    },
  },
  {
    name: "remove",
    summary: "Delete an installed model and free its disk space",
    usage: "/remove <id>",
    run(app, args) {
      return app.removeCommand(args)
    },
  },
  {
    name: "agent",
    summary: "Switch the active agent (opens a picker)",
    usage: "/agent [id]",
    run(app, args) {
      app.setAgent(args[0])
    },
  },
  {
    name: "agents",
    summary: "List available agents",
    run(app) {
      app.showAgents()
    },
  },
  {
    name: "skills",
    summary: "Run a skill, list them, or import a published skill pack",
    usage: "/skills [id|sync <owner/repo>]",
    run(app, args) {
      return app.skillsCommand(args)
    },
  },
  {
    name: "permission",
    aliases: ["permissions", "approve"],
    summary: "Choose how tool calls are approved (auto, manual, read-only)",
    usage: "/permission [auto|manual|readonly]",
    run(app, args) {
      return app.permissionCommand(args[0])
    },
  },
  {
    name: "queue",
    summary: "Show, edit, drop, or clear messages queued behind the current turn",
    usage: "/queue [edit <n>|drop <n>|clear]",
    run(app, args) {
      return app.queueCommand(args)
    },
  },
  {
    name: "memory",
    summary: "Show what IMURUN remembers, or search it",
    usage: "/memory [query]",
    run(app, args) {
      return app.showMemory(args.join(" ").trim() || undefined)
    },
  },
  {
    name: "compact",
    summary: "Free context now: fold older turns into the session summary",
    usage: "/compact",
    run(app) {
      return app.compactCommand()
    },
  },
  {
    name: "tools",
    summary: "List the tools available to the current agent",
    run(app) {
      app.showTools()
    },
  },
  {
    name: "cwd",
    summary: "Show or change the working directory",
    usage: "/cwd [path]",
    run(app, args) {
      return app.changeDirectory(args.join(" ").trim() || undefined)
    },
  },
  {
    name: "status",
    summary: "Show model, agent, runtime and storage status",
    run(app) {
      return app.showStatus()
    },
  },
  {
    name: "runtime",
    summary: "Control the local inference runtime",
    usage: "/runtime [status|stop]",
    run(app, args) {
      return app.runtimeCommand(args[0])
    },
  },
  {
    name: "rag",
    summary: "Search the project index, or refresh it",
    usage: "/rag [status|index|search <query>|clear]",
    run(app, args) {
      return app.ragCommand(args)
    },
  },
]

export function createCommandRegistry(): SlashRegistry {
  const registry = new SlashRegistry()
  for (const command of COMMANDS) registry.register(command)
  return registry
}

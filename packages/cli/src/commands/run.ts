/**
 * imurun run — non-interactive one-shot task execution.
 *
 *   imurun run "fix the login bug"          stream output to the terminal
 *   imurun run "..." --yes                  auto-approve tool permissions
 *   imurun run "..." --model local/qwen     pick a model
 *   imurun run "..." --session <id>         continue an existing session
 */
import {
  Agent,
  ImurunDatabase,
  MemoryStore,
  PermissionManager,
  ProviderRegistry,
  ResearchEngine,
  SessionStore,
  ToolRegistry,
  defaultAgent,
  getAgent,
  loadAgents,
  loadConfigSafe,
  loadSkills,
  probeProvider,
  restrictToolRegistry,
} from "@imurun/core"
import type { AgentEvent } from "@imurun/core"
import {
  CATALOG,
  createInstallRenderer,
  fittingModels,
  installModel,
  listInstalled,
  loadHardware,
} from "@imurun/modelmgr"
import chalk from "chalk"
import { formatDuration, truncate } from "@imurun/util"
import type { ImurunConfig, InstalledModel } from "@imurun/schema"
import { ensureLocalRuntime, resolveLocalTarget, activeHeartbeats, type LocalSession } from "@imurun/runtime"
import type { Command } from "../framework/command"

export const runCommand: Command = {
  name: "run",
  summary: "Run a task non-interactively (one-shot mode)",
  usage: 'imurun run "<task>" [--model <ref>] [--agent <id>] [--yes] [--session <id>] [--dir <path>] [--no-install]',
  options: [
    { name: "model", type: "string", description: "Model reference, e.g. local/qwen2.5-coder-7b" },
    { name: "agent", type: "string", description: "Agent to run as, e.g. build, plan (default: build)" },
    { name: "yes", short: "y", type: "boolean", description: "Auto-approve all tool permissions" },
    { name: "session", type: "string", description: "Continue an existing session id" },
    { name: "dir", type: "string", description: "Working directory (default: current)" },
    { name: "quiet", short: "q", type: "boolean", description: "Only print the final answer" },
    { name: "no-install", type: "boolean", description: "Never auto-install a model, even when none is present" },
    {
      name: "max-steps",
      type: "string",
      description: "Optional safety cap on model\u2194tool rounds (default: no cap)",
    },
  ],

  async run({ args, options }) {
    const task = args.join(" ").trim()
    if (!task) {
      console.error('  ✖ Provide a task, e.g. imurun run "add tests for auth.ts"')
      return 1
    }

    const workingDir = (options.dir as string | undefined) ?? process.cwd()
    const autoApprove = options.yes === true
    const quiet = options.quiet === true

    const { loaded } = await loadConfigSafe(workingDir)
    const { config } = loaded

    const store = await ImurunDatabase.openProject(workingDir)
    const sessions = new SessionStore(store)

    const sessionId = (options.session as string | undefined)
    if (sessionId && !sessions.get(sessionId)) {
      console.error(`  ✖ Session not found: ${sessionId}`)
      return 1
    }
    const session = sessionId
      ? sessions.get(sessionId)!
      : sessions.create({ workingDir, model: config.model })

    // resolve the model: explicit flag → session → config → default installed
    const installed = await listInstalled()
    const requestedRef = (options.model as string | undefined) ?? session.model ?? config.model
    let resolution = resolveLocalTarget(requestedRef, installed)
    if (resolution.error) {
      console.error(`  ✖ ${resolution.error}`)
      return 1
    }
    if (!resolution.modelRef && options["no-install"] !== true) {
      // Nothing to run with — set the machine up automatically, no prompts.
      const chosen = await autoInstallBest(config, quiet)
      if (!chosen) return 1
      resolution = resolveLocalTarget(chosen.modelId, [chosen])
    }
    if (!resolution.modelRef) {
      console.error("  ✖ No model selected.")
      console.error(`    ${chalk.gray("install a local model:")}  imurun models install qwen2.5-coder-7b`)
      console.error(`    ${chalk.gray("or pick one:")}            imurun run "..." --model <id>`)
      return 1
    }
    const modelRef = resolution.modelRef
    if (modelRef !== session.model) {
      sessions.update(session.id, { model: modelRef })
    }

    // bring the local runtime up when this is a local model
    let localSession: LocalSession | undefined
    if (resolution.target) {
      if (!quiet) process.stderr.write(`  ${chalk.gray("starting the local runtime (first load takes a moment)…")}\n`)
      localSession = await ensureLocalRuntime(config, resolution.target, session.id, { unrefHeartbeat: true })
      if (!quiet) process.stderr.write(`  ${chalk.gray("runtime ready")}\n`)
    }

    const providers = new ProviderRegistry(config)
    const baseTools = ToolRegistry.default()
    const permissions = PermissionManager.withSavedRules(store, {
      rules: config.permissions.rules,
      disabledTools: config.disabledTools,
      mode: config.permissions.mode,
      projectPath: workingDir,
    })

    // Resolve the agent: --agent flag → build.
    const agents = await loadAgents({ workingDir })
    const agentDef = (options.agent as string | undefined) ? getAgent(agents, options.agent as string) : undefined
    if (options.agent && !agentDef) {
      console.error(`  ✖ Unknown agent: ${options.agent} (try: ${agents.map((a) => a.id).join(", ")})`)
      return 1
    }
    const activeAgent = agentDef ?? defaultAgent(agents)
    const tools = restrictToolRegistry(baseTools, activeAgent)
    const role = activeAgent.prompt.trim() || undefined

    if (!quiet) {
      process.stderr.write(
        `\n  ${chalk.bold.cyan("IMURUN")} ${chalk.gray(`session ${session.id.slice(0, 12)}…`)} ${chalk.gray("│")} ${chalk.cyan(modelRef)} ${chalk.gray(`│ agent ${activeAgent.id}`)}\n\n`,
      )
    }

    const started = Date.now()
    let wroteText = false
    /** When the current thinking block started, for the live counter. */
    let thinkingSince: number | undefined

    const agent = new Agent({
      sessions,
      providers,
      tools,
      permissions,
      config,
      memory: new MemoryStore(),
      skills: await loadSkills({ workingDir }),
      // The research engine decides whether this question needs the internet,
      // and gathers the evidence before the model answers. Without it, the
      // model has to remember to search — which small models do not.
      research: await ResearchEngine.create({ config: config.web }).catch(() => undefined),
      onPermission: async (request) => {
        if (autoApprove) return true
        if (quiet) return false
        process.stderr.write(
          `\n  ${chalk.yellow("⚠ permission required")} ${chalk.bold(request.tool)} ${chalk.gray(request.detail ?? "")}\n` +
            `  ${chalk.gray("non-interactive mode: re-run with --yes to approve automatically")}\n\n`,
        )
        return false
      },
    })

    const usage = { inputTokens: 0, outputTokens: 0 }
    let lastActivityTouch = 0
    const touchActivity = () => {
      if (!localSession) return
      const now = Date.now()
      if (now - lastActivityTouch < 1500) return
      lastActivityTouch = now
      void localSession.manager.activity(session.id).catch(() => {})
    }

    const onEvent = (event: AgentEvent) => {
      touchActivity()
      switch (event.type) {
        case "text":
          if (!quiet) {
            process.stdout.write(event.delta)
            wroteText = true
          }
          break
        case "text-reset":
          // Text already written to stdout turned out to be a tool-call payload.
          // A terminal cannot unprint it, so say so rather than stay silent.
          if (!quiet) {
            process.stderr.write(`\n  ${chalk.gray("(a tool-call payload was withheld)")}\n`)
            wroteText = false
          }
          break
        case "reasoning":
          // Thinking is not the answer, so it goes to stderr as a quiet hint —
          // piped output stays clean. The counter ticks in place with a
          // carriage return, so the line grows no new lines while it thinks.
          if (!quiet) {
            if (!thinkingSince) thinkingSince = Date.now()
            const seconds = Math.floor((Date.now() - thinkingSince) / 1000)
            const clock = `${String(seconds).padStart(2, "0")}s`
            process.stderr.write(`\r  ${chalk.gray("◈")} ${chalk.gray(`thinking · ${clock}`)}   `)
          }
          break
        case "step-start":
          // A new step: end the thinking line so the next one starts clean.
          if (!quiet && thinkingSince) {
            thinkingSince = undefined
            process.stderr.write("\r[2K")
          }
          break
        case "notice":
          if (!quiet) {
            const tone = event.tone === "warn" ? chalk.yellow : chalk.gray
            process.stderr.write(`\n  ${tone("·")} ${tone(event.text)}\n`)
          }
          break
        case "tool-unrecognised":
          if (!quiet) {
            process.stderr.write(`\n  ${chalk.yellow("⚠")} the model asked for an unknown tool\n`)
          }
          break
        case "verifying":
          if (!quiet) {
            process.stderr.write(
              `\n  ${chalk.gray("·")} ${chalk.gray(`checking ${event.files.length} changed file(s)`)}\n`,
            )
          }
          break
        case "tool-start":
          if (!quiet) {
            if (wroteText) process.stderr.write("\n")
            process.stderr.write(`  ${chalk.gray("●")} ${chalk.bold(event.title ?? event.name)}\n`)
          }
          break
        case "tool-end":
          if (!quiet) {
            const icon = event.ok ? chalk.green("✔") : chalk.red("✖")
            const firstLine = truncate(event.output.split("\n")[0] ?? "", 100)
            process.stderr.write(`    ${icon} ${chalk.gray(firstLine)}\n`)
          }
          break
        case "done":
          // The thinking line is finished; clear it so the answer starts on
          // a clean line.
          if (!quiet && thinkingSince) {
            thinkingSince = undefined
            process.stderr.write("\r\u001b[2K")
          }
          usage.inputTokens = event.usage.inputTokens
          usage.outputTokens = event.usage.outputTokens
          break
        case "error":
          console.error(`\n  ✖ ${event.error.message}`)
          break
      }
    }

    // Everything the agent sends is budgeted against the window the engine
    // actually loaded. An explicit config override wins; for an API model that
    // is neither local nor configured, ask the provider what it publishes.
    let contextWindow = config.contextWindow ?? resolution.target?.contextLength
    if (localSession) {
      const status = await localSession.manager.status().catch(() => undefined)
      if (status?.state?.contextSize && status.state.contextSize > 0) contextWindow = status.state.contextSize
    } else if (!contextWindow) {
      try {
        const resolvedApi = providers.resolve(modelRef)
        if (resolvedApi.provider.kind === "api") {
          const info = await probeProvider(resolvedApi.provider, config).catch(() => undefined)
          contextWindow = info?.modelContext?.[resolvedApi.modelId]
        }
      } catch {
        /* a resolution error is reported by the agent itself */
      }
    }

    try {
      const result = await agent.run({
        sessionId: session.id,
        input: task,
        model: modelRef,
        workingDir,
        agentId: activeAgent.id,
        role,
        contextWindow,
        maxSteps: parseMaxSteps(options["max-steps"]),
        onEvent,
      })

      if (quiet) {
        process.stdout.write(result.text + "\n")
      } else {
        if (wroteText) process.stdout.write("\n")
        process.stderr.write(
          `\n  ${chalk.gray(
            `${result.steps} step${result.steps === 1 ? "" : "s"} │ ${usage.inputTokens}+${usage.outputTokens} tokens │ ${formatDuration(
              Date.now() - started,
            )} │ model ${result.model}`,
          )}\n\n`,
        )
      }
      return 0
    } finally {
      if (localSession) {
        await localSession.detach().catch(() => {})
        if (localSession.started) {
          // We brought the runtime up for this one-shot task — take it down
          // again so memory is released the moment the command returns. But if
          // another client (an open `imurun` UI, say) is still attached, leave
          // the runtime to them instead of yanking the model out from under it.
          const remaining = await activeHeartbeats(15_000).catch(() => [])
          if (remaining.length === 0) await localSession.manager.stop().catch(() => {})
        }
      }
      store.close()
    }
  },
}

/**
 * `--max-steps N` is an opt-in safety cap. Anything that is not a positive
 * integer means "no cap" — the default — rather than a silent zero.
 */
function parseMaxSteps(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * First-run onboarding: when nothing is installed, download and set up the
 * best-fitting model for this machine automatically — including the inference
 * engine — so `imurun run` works on a fresh, unknown system with no prompts.
 */
async function autoInstallBest(config: ImurunConfig, quiet: boolean): Promise<InstalledModel | undefined> {
  const hardware = await loadHardware()
  const fitting = fittingModels(hardware, CATALOG)
  if (fitting.length === 0) {
    console.error("  ✖ No catalog model fits this machine's available memory.")
    console.error(`    ${chalk.gray("browse everything:")} imurun models list --all`)
    return undefined
  }

  const pick = fitting[0]!
  const { model, recommendedQuant } = pick
  if (!quiet) {
    process.stderr.write(
      `\n  ${chalk.bold.cyan("IMURUN")} ${chalk.gray("no local model found — setting up this machine automatically")}\n` +
        `  ${chalk.green("★")} ${chalk.bold(model.displayName)} ${chalk.gray(`(${model.id}, ${recommendedQuant})`)}\n\n`,
    )
  }

  const sink: { write: (s: string) => void; isTTY?: boolean } = quiet ? { write: () => {} } : process.stdout
  const renderer = createInstallRenderer(sink)
  try {
    const installed = await installModel({
      modelId: model.id,
      quant: recommendedQuant,
      hardware,
      engineVariant: config.runtime.engineVariant,
      onEvent: (event) => renderer.onEvent(event),
    })
    renderer.dispose()
    if (!quiet) process.stderr.write(`\n  ${chalk.green("✔")} ready — ${chalk.cyan(installed.modelId)} ${installed.quant}\n\n`)
    return installed
  } catch (error) {
    renderer.dispose()
    console.error(`\n  ✖ Automatic setup failed: ${(error as Error).message}`)
    console.error(`    ${chalk.gray("try installing one by hand:")} imurun models install <id>`)
    return undefined
  }
}

/**
 * Agent — the conversation loop.
 *
 * One run: append the user message, then repeatedly
 *   1. stream a model response,
 *   2. if it contains tool calls: check permissions, execute each tool,
 *      persist results, and loop;
 *   3. otherwise finish.
 *
 * Tools are executed by IMURUN (not the AI SDK) so every call flows through
 * permissions, events, and storage.
 */
import { streamText, type LanguageModelUsage, type ModelMessage } from "ai"
import type { ContentPart, ImurunConfig, ToolCall, ToolResult } from "@imurun/schema"
import { createLogger, imurunDir, resolveShell, type Logger } from "@imurun/util"
import type { SessionStore } from "../session/session"
import { buildSystemPrompt } from "../session/system-prompt"
import { ProviderRegistry, type ResolvedModel } from "../provider/registry"
import type { ToolRegistry } from "../tool/registry"
import type { ToolContext } from "../tool/types"
import { PermissionManager, type PermissionRequest } from "../permission/permission"
import { assembleModelMessages, planCompaction, planHistoryChars } from "./context"
import { DEFAULT_CONTEXT_WINDOW, MAX_MESSAGE_CHARS } from "./context"
import { ThinkSplitter } from "./think-splitter"
import { supportsReasoningEffort } from "../provider/registry"
import {
  isPendingToolCall,
  isToolCallAttempt,
  recoverTextToolCalls,
  retractStartFor,
  toolCallGuardIndex,
} from "./tool-recovery"
import type { MemoryStore } from "../memory/store"
import { digestToPrompt, messageText } from "../memory/summarize"
import { formatLedger, ledgerFor } from "../memory/ledger"
import { planPromptLines } from "../todo/plan"
import { todoPromptLines } from "../tool/todo"
import { formatHit } from "../memory/search"
import { learnFromMessage } from "../memory/learn"
import { CardVault } from "../memory/brain"
import { projectRagIndex, refreshRagIndex } from "../rag/config"
import { formatRagHit } from "../rag/index"
import { modelSeesImages } from "./vision"
import { selectSkills, skillsToPromptSection } from "./skills"
import type { SkillDefinition } from "./skills"

export type AgentEvent =
  | { type: "step-start"; step: number }
  | { type: "text"; delta: string }
  /**
   * The model's thinking, as it arrives. Kept apart from the answer so the UI
   * can show it collapsed; it is never mixed into the displayed message.
   */
  | { type: "reasoning"; delta: string }
  /**
   * The displayable text for the current step is exactly this — sent when text
   * that had already been shown turns out to be part of a tool-call payload and
   * must be taken back.
   */
  | { type: "text-reset"; text: string }
  /** The model tried to call a tool that does not exist (or was cut off). */
  | { type: "tool-unrecognised"; detail: string }
  /** Something worth telling the user that is not part of the answer. */
  | { type: "notice"; text: string; tone?: "info" | "warn" }
  | { type: "skill"; id: string; name: string }
  /** History had to be folded into a summary to fit the window. */
  | { type: "compacted"; droppedMessages: number; keptMessages: number; reason: "budget" | "overflow" | "manual" }
  /** The answer hit the output limit; the run asked the model to carry on. */
  | { type: "continuation"; attempt: number }
  /** Files changed this turn and none were inspected since; a check was asked for. */
  | { type: "verifying"; files: string[] }
  /**
   * Project material the index found and put into this turn's prompt, so the UI
   * can show what was consulted rather than the user wondering why the answers
   * suddenly know the codebase.
   */
  | { type: "rag"; hits: Array<{ path: string; start: number; end: number; score: number }> }
  | { type: "tool-start"; callId: string; name: string; args: unknown; title?: string }
  | { type: "tool-end"; callId: string; name: string; ok: boolean; output: string; title?: string }
  | { type: "permission"; request: PermissionRequest; allowed: boolean }
  | { type: "step-end"; step: number; usage?: AgentUsage }
  | { type: "error"; error: Error }
  | { type: "done"; steps: number; usage: AgentUsage }

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
}

export interface RunOptions {
  sessionId: string
  input: string | ContentPart[]
  /** Overrides the session/config model for this run. */
  model?: string
  workingDir: string
  signal?: AbortSignal
  /** Maximum model↔tool round trips. */
  maxSteps?: number
  /** Restricts the tool set for this run (agent-specific). */
  tools?: ToolRegistry
  /** Active agent id, surfaced in the system prompt. */
  agentId?: string
  /**
   * The agent's role preamble. Placed directly after the shared base rules, so
   * a role can specialise them; project instructions still win.
   */
  role?: string
  /** Extra system-prompt sections appended for this run (skills, one-offs). */
  extraSystemSections?: string[]
  /** Skip memory recall for this run (subagents, one-shot utilities). */
  disableMemory?: boolean
  /** Skip automatic skill selection for this run. */
  disableSkills?: boolean
  /**
   * The model's real context window in tokens, as reported by the runtime.
   * Everything the agent sends is budgeted against it.
   */
  contextWindow?: number
  /** Start from a deliberately tighter budget (after an explicit /compact). */
  tightContext?: boolean
  /**
   * Ask for one verification pass when a run changed files and nothing was
   * inspected afterwards. On by default; one-shot utilities turn it off.
   */
  verifyChanges?: boolean
  onEvent?: (event: AgentEvent) => void
}

export interface RunResult {
  text: string
  steps: number
  usage: AgentUsage
  model: string
  provider: string
}

export interface AgentOptions {
  sessions: SessionStore
  providers: ProviderRegistry
  tools: ToolRegistry
  permissions: PermissionManager
  config: ImurunConfig
  /** Long-term memory; enables recall, todos and session digests. */
  memory?: MemoryStore
  /** Skill library; the best match is applied automatically to each request. */
  skills?: SkillDefinition[]
  /** Interactive permission handler; when absent, "ask" decisions are denied. */
  onPermission?: (request: PermissionRequest, toolName: string) => Promise<boolean>
  log?: Logger
}

/**
 * The step ceiling is off by default: a run continues until the model stops
 * asking for tools, however many rounds that takes. `maxSteps` survives only as
 * an explicit opt-in cap (`--max-steps`), and even a long run is announced
 * rather than silently cut short.
 */
const LONG_RUN_NOTICE_STEPS = 100
/** How many times a request may be recomputed for being over the window. */
const MAX_CONTEXT_RETRIES = 2
/** How many times an answer cut off by the output limit is carried on. */
const MAX_CONTINUATIONS = 3

const CONTINUE_PROMPT =
  "[system] Your previous message was cut off by the output limit before it finished. " +
  "Continue from exactly where it stopped. Do not repeat anything you already wrote, do not restart the " +
  "answer, and do not add a preamble. If there is a lot left to produce, write it into files with small " +
  "write/append steps instead of one long message."

/** How many verification passes a run may ask for before it must stop. */
const MAX_VERIFICATIONS = 1

const VERIFY_PROMPT =
  "[system] Before you finish, confirm that the changes you just made actually landed: re-read the file you " +
  "wrote or edited (or its tail), and if the project has a test, build or type check that covers it, run that. " +
  "If something did not land, do not simply repeat the same attempt — work out why and fix it a different way. " +
  "Then give your final answer: what changed, in which files, what you ran, and what the result was."

function zeroUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0 }
}

/**
 * True for the engine refusing a request for being bigger than its window.
 *
 * llama.cpp answers `request (N tokens) exceeds the available context size
 * (M tokens)`; other backends phrase it differently. Matching the handful of
 * real wordings is better than guessing at arbitrary errors.
 */
function isContextOverflow(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes("exceeds the available context size") ||
    message.includes("context_length_exceeded") ||
    message.includes("maximum context length") ||
    message.includes("reduce the length of the messages") ||
    /context (window|size|length)[^.]*exceed/.test(message) ||
    /too many tokens/.test(message)
  )
}

/** True when a tool call was cut off mid-payload and could not be parsed. */
function isTruncatedToolCall(error: unknown): boolean {
  return /invalid tool input|unexpected end of json|unexpected end of input|json parse|unterminated/i.test(
    errorMessage(error),
  )
}

/**
 * True when a provider refused the request because of the reasoning-effort
 * value. These come back as a 400 before anything is generated, which is what
 * makes it safe to retry with a different level.
 */
function isEffortRejection(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return (
    /reasoning[_ ]?effort|thinking[_ ]?(effort|level)/.test(message) &&
    /(invalid|unsupported|unknown|not supported|unexpected|400|unrecognized)/.test(message)
  )
}

function addUsage(target: AgentUsage, usage: LanguageModelUsage | undefined): void {
  if (!usage) return
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  target.inputTokens += input
  target.outputTokens += output
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Flattens a run input into the text used for memory and skill matching. */
function promptQuery(input: string | ContentPart[]): string {
  if (typeof input === "string") return input
  return input
    .map((part) => (part.type === "text" ? part.text : part.type === "file" ? part.path : ""))
    .join(" ")
    .trim()
}

/** Extracts a short permission detail from tool args: path or command. */
function permissionDetail(toolName: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.command === "string") return args.command.slice(0, 200)
  if (typeof args.path === "string") {
    const mode = typeof args.mode === "string" && args.mode !== "overwrite" ? ` (${args.mode})` : ""
    return `${args.path}${mode}`
  }
  if (typeof args.key === "string") return String(args.key)
  return undefined
}

export class Agent {
  private readonly log: Logger

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? createLogger("agent")
  }

  async run(run: RunOptions): Promise<RunResult> {
    const { sessions, providers, tools, permissions, config } = this.options
    const activeTools = run.tools ?? tools
    // No cap unless the caller asked for one. A task runs to completion.
    const maxSteps = run.maxSteps

    const session = sessions.get(run.sessionId)
    if (!session) throw new Error(`Session not found: ${run.sessionId}`)

    sessions.addMessage({ sessionId: session.id, role: "user", content: run.input })

    const resolved: ResolvedModel = providers.resolve(run.model ?? session.model ?? config.model)
    if (!session.model) sessions.update(session.id, { model: resolved.modelId })

    // Whether this model has eyes decides what a screenshot or a PNG read is
    // worth: pixels for a vision model, an honest sentence for anything else.
    const vision = modelSeesImages(resolved.modelId, { force: config.vision, extra: config.visionModels })

    // ── Long-term memory: recall + compaction ──────────────────────────────
    // Oldest turns that fall outside the context budget are summarized into
    // `~/.imurun/memory/` and re-injected as a prompt section, so the model
    // keeps the thread instead of silently forgetting the start of the session.
    const memory = this.options.memory
    const memoryOn = Boolean(memory && config.memory.enabled && !run.disableMemory)
    const history = () => sessions.getMessages(session.id).filter((m) => m.role !== "system")

    let compactedSummary: string | undefined
    let memories: string[] = []
    let durableNotes: string[] = []
    let todos: string[] = []
    let inProgress: string[] = []

    // The project's key/value ledger: what was already written, what is still
    // half-done. Cheap to read, and the model needs it to resume rather than
    // start again.
    try {
      inProgress = formatLedger(await ledgerFor(run.workingDir).open())
    } catch (error) {
      this.log.debug(`progress ledger skipped: ${errorMessage(error)}`)
    }

    // The plan the user can watch. A fresh session should pick up the steps that
    // are still open rather than start the work over.
    let planned: string[] = []
    try {
      planned = await todoPromptLines(run.workingDir)
    } catch (error) {
      this.log.debug(`todo list skipped: ${errorMessage(error)}`)
    }

    // The written plan for this project, if a previous run left one.
    let planLines: string[] = []
    try {
      planLines = await planPromptLines(run.workingDir)
    } catch (error) {
      this.log.debug(`plan skipped: ${errorMessage(error)}`)
    }

    const query = promptQuery(run.input)

    if (memory && memoryOn) {
      try {
        memories = (
          await memory.search(query, {
            limit: config.memory.maxRecallEntries,
            projectPath: run.workingDir,
            // With cross-session recall off, past sessions' digests stay out of
            // the prompt; this machine's own notes are still recalled.
            sources: config.memory.crossSession ? undefined : ["note"],
          })
        ).map((hit) => formatHit(hit))
        durableNotes = await memory.durable(run.workingDir)
        todos = (await memory.openTodos(run.workingDir)).slice(0, 10)
      } catch (error) {
        // Memory must never break a run.
        this.log.debug(`memory recall skipped: ${errorMessage(error)}`)
      }

      // Standing instructions and personal facts the user stated in passing
      // ("always use tabs", "my name is …") are learned here, rather than being
      // lost whenever the model does not think to call the memory tool.
      try {
        if (typeof run.input === "string") {
          const learned = await learnFromMessage(memory, run.input, {
            learnStyle: config.memory.learnStyle,
            projectPath: run.workingDir,
            sessionId: run.sessionId,
          })
          for (const note of learned) run.onEvent?.({ type: "notice", text: `noted \u00b7 ${note}`, tone: "info" })
        }
      } catch (error) {
        this.log.debug(`learning skipped: ${errorMessage(error)}`)
      }
    }

    // ── The card vault: the second brain ─────────────────────────────────────
    // Typed markdown cards that strengthen with use and fade with disuse. The
    // tier decides what reaches the model: `core` cards always, `active` ones
    // while they are in play, `warm`/`cold` on search, and — at most one, and
    // only now and then — an archived card as a nudge from further back. The
    // persona file, if the user has written one, personalises every prompt.
    let secondBrain: string[] = []
    let persona: string | undefined
    if (memoryOn && config.memory.vault) {
      try {
        const vault = this.cardVault(config)
        await vault.ensureScaffold()
        persona = await vault.persona()
        secondBrain = (await vault.inject()).map(
          (card) => `- [${card.type}] ${card.title}${card.description ? ` \u2014 ${card.description}` : ""}`,
        )
        const recalled = await vault.recall(query, { limit: 3 })
        for (const card of recalled) {
          memories.push(`[card] ${card.title}${card.description ? ` \u2014 ${card.description}` : ""}`)
        }
        if (recalled.length === 0) {
          // Nothing matched, so this is the moment for a nudge from the back of
          // the mind: one cold or archived card, and not on every turn.
          const stray = Math.random() < 0.15 ? await vault.randomRecall() : undefined
          if (stray) {
            run.onEvent?.({
              type: "notice",
              text: `recalled \u00b7 ${stray.title} \u2014 ${stray.description ?? "an older note"}`,
              tone: "info",
            })
            memories.push(`[card] ${stray.title}${stray.description ? ` \u2014 ${stray.description}` : ""}`)
          }
        }
      } catch (error) {
        this.log.debug(`card vault skipped: ${errorMessage(error)}`)
      }
    }

    // ── Project context: what the index already knows about this request ─────
    // Found before the model can ask for it, so a local model with a small
    // window starts the turn with the right files in view instead of spending
    // its steps hunting for them. This is the "auto-inject" half of the index;
    // `code_search` is the other half, for when the model wants to dig.
    let ragSection: string[] = []
    let ragHits: Array<{ path: string; start: number; end: number; score: number }> = []
    if (config.rag.enabled && config.rag.autoInject && activeTools.get("code_search")) {
      try {
        const index = projectRagIndex(run.workingDir, config)
        await refreshRagIndex(index, config)
        const hits = index.search(query, { limit: config.rag.maxInjectChunks })
        if (hits.length > 0) {
          ragSection = [
            "## Project context",
            "",
            "The most relevant places in this project for the request. Prefer these over searching again.",
            "",
            ...hits.map((hit) => formatRagHit(hit)),
          ]
          ragHits = hits.map((hit) => ({ path: hit.path, start: hit.start, end: hit.end, score: hit.score }))
          run.onEvent?.({ type: "rag", hits: ragHits })
        }
      } catch (error) {
        // Indexing must never break a turn; the model can still call code_search.
        this.log.debug(`project context skipped: ${errorMessage(error)}`)
      }
    }
    // True once the turn's first step has been persisted, so the injected
    // sources are recorded exactly once.
    let ragRecorded = false

    // ── Skills: apply the method that fits this request ────────────────────
    // A skill is a way of working, so it belongs in the prompt; the user should
    // not have to remember a command for it to be used.
    let skillSections: string[] = []
    const skillLibrary = this.options.skills ?? []
    if (!run.disableSkills && skillLibrary.length > 0) {
      const matches = selectSkills(promptQuery(run.input), skillLibrary, { limit: 1 })
      const section = skillsToPromptSection(matches)
      if (section) {
        skillSections = [section]
        for (const match of matches) run.onEvent?.({ type: "skill", id: match.skill.id, name: match.skill.name })
        this.log.debug(`applying skill: ${matches.map((match) => match.skill.id).join(", ")}`)
      }
    }

    // ── Capabilities: the model is told what it can actually do here ───────
    const toolNames = new Set(activeTools.list().map((tool) => tool.name))
    const capabilities: string[] = ["read, create and edit files, and run shell commands"]
    if (toolNames.has("glob") && toolNames.has("grep")) capabilities.push("search the project by file name and by content")
    if (toolNames.has("code_search")) capabilities.push("search the whole project by meaning over an offline index that keeps itself up to date")
    if (toolNames.has("web_search")) capabilities.push("search the internet and read web pages (these fail cleanly when offline)")
    if (memoryOn) capabilities.push("store and recall durable memory across sessions")
    if (vision) capabilities.push("look at images and screenshots you give it")
    if (toolNames.has("screenshot")) capabilities.push("see what is on this machine's screen by taking a screenshot")
    if (toolNames.has("shell")) {
      const shell = resolveShell()
      capabilities.push(
        shell.posix
          ? `run commands in ${shell.label} \u2014 a POSIX shell, so grep, sed, cat, head, tail, pipes and && work as they do on Linux and macOS`
          : `run commands in ${shell.label}, the only shell on this machine (no grep/sed/cat unless they are installed)`,
      )
      capabilities.push("open files, folders, applications and web links with the platform opener")
      capabilities.push("start long-running commands (servers, watchers) in the background")
    }
    if (toolNames.has("progress")) capabilities.push("keep a resumable record of work in progress, so a later run picks up where it stopped")
    if (toolNames.has("task")) capabilities.push("delegate focused work to a subagent with its own context window")
    if (skillLibrary.length > 0) capabilities.push(`apply any of ${skillLibrary.length} built-in skills automatically when one fits`)
    if (toolNames.has("write")) capabilities.push("write a new skill or agent for you when you ask for one")

    // ── Context budget ────────────────────────────────────────────────────
    // Everything sent to a local model competes for one window: the system
    // prompt, the recalled memory, and the conversation. Work out what is left
    // for the conversation instead of hoping it fits — llama.cpp refuses an
    // over-sized request outright, which used to surface as a hard error.
    const contextWindow = run.contextWindow && run.contextWindow > 0 ? run.contextWindow : DEFAULT_CONTEXT_WINDOW

    const buildSystem = (summary?: string): string =>
      buildSystemPrompt({
        workingDir: run.workingDir,
        model: resolved.modelId,
        agent: run.agentId,
        role: run.role,
        tools: activeTools.list().map((tool) => tool.name),
        capabilities,
        skillsDir: imurunDir("skills"),
        agentsDir: imurunDir("agents"),
        instructions: config.instructions,
        memories,
        notes: durableNotes,
        secondBrain,
        persona,
        todos: summary ? [] : [...planned, ...todos],
        plan: summary ? undefined : planLines,
        compactedSummary: summary,
        extraSections: [...(run.extraSystemSections ?? []), ...skillSections, ...ragSection],
        inProgress,
      })

    let system = buildSystem(undefined)
    let historyBudget = planHistoryChars(contextWindow, system.length)
    if (run.tightContext) historyBudget = Math.floor(historyBudget * 0.5)

    const modelMessages = (): ModelMessage[] =>
      assembleModelMessages(history(), {
        maxChars: historyBudget,
        minMessages: 2,
        maxMessageChars: Math.max(Math.min(Math.floor(historyBudget * 0.5), MAX_MESSAGE_CHARS), 2_000),
      })

    /**
     * Folds whatever the window cannot hold into the durable digest and rebuilds
     * the prompt. The digest is written to ~/.imurun/memory/, so the model keeps
     * the thread of the dropped turns — this is what makes dropping history
     * "freeing context" rather than "forgetting".
     */
    const compact = async (reason: "budget" | "overflow" | "manual"): Promise<void> => {
      const plan = planCompaction(history(), { maxChars: historyBudget, minMessages: 2 })
      if (memory && memoryOn && config.memory.autoSummarize && plan.dropped.length > 0) {
        try {
          const digest = await memory.summarize(session, history())
          compactedSummary = digestToPrompt(digest)
        } catch (error) {
          this.log.debug(`compaction digest skipped: ${errorMessage(error)}`)
        }
      }
      system = buildSystem(compactedSummary)
      historyBudget = planHistoryChars(contextWindow, system.length)
      if (run.tightContext || reason === "overflow") historyBudget = Math.floor(historyBudget * 0.5)
      run.onEvent?.({
        type: "compacted",
        droppedMessages: plan.dropped.length,
        keptMessages: plan.kept.length,
        reason,
      })
      this.log.debug(
        `context ${reason}: kept ${plan.kept.length}, folded ${plan.dropped.length} message(s) into the digest ` +
          `(budget ${historyBudget} chars of a ${contextWindow}-token window)`,
      )
    }

    // Nothing the window cannot hold is left un-summarised before the first call.
    await compact("budget")

    const aiTools = activeTools.toAiSdkTools()
    const totalUsage = zeroUsage()
    let finalText = ""
    let steps = 0
    let continuations = 0
    // Multistep discipline: remember what this turn changed and whether anything
    // looked at it afterwards, so the agent checks its own work before finishing.
    const verifyChanges = run.verifyChanges ?? true
    // The thinking-effort knob, only when this provider takes one. A provider
    // that rejects the value steps it down (see the retry below).
    let effort = config.reasoningEffort && supportsReasoningEffort(resolved.provider) ? config.reasoningEffort : undefined
    const changedFiles = new Map<string, number>()
    let lastInspectionStep = 0
    let verifications = 0

    while (maxSteps === undefined || steps < maxSteps) {
      steps++
      run.signal?.throwIfAborted()
      run.onEvent?.({ type: "step-start", step: steps })
      // Long is allowed; silent is not. Past a hundred rounds the user is told
      // what is happening and how to stop it, and the run carries on.
      if (steps === LONG_RUN_NOTICE_STEPS) {
        run.onEvent?.({
          type: "notice",
          text: `still working \u2014 ${steps} steps so far \u00b7 esc to stop`,
          tone: "info",
        })
      }

      let text = ""
      let streamedLength = 0
      /** Where a possible tool-call payload starts, once one has been spotted. */
      let guardIndex: number | undefined
      /** How far the guard has scanned; a prefix scanned clear stays clear. */
      let scanFrom = 0
      /** The model's thinking for this step, kept apart from the answer. */
      let reasoning = ""
      const think = new ThinkSplitter()
      const toolCalls: ToolCall[] = []
      let stepUsage: AgentUsage = zeroUsage()
      let streamError: Error | undefined
      let finishReason: string | undefined

      this.log.debug(`step ${steps}: streaming from ${resolved.provider.id}/${resolved.modelId}`)

      // A request can still be refused for size (a single very large message, or
      // an engine that loaded a smaller window than it was asked for). Compacting
      // harder and asking again beats handing the user a raw engine error.
      for (let attempt = 0; ; attempt++) {
        text = ""
        streamedLength = 0
        guardIndex = undefined
        scanFrom = 0
        toolCalls.length = 0
        stepUsage = zeroUsage()
        streamError = undefined
        finishReason = undefined

        try {
          const result = streamText({
            model: resolved.model,
            system,
            messages: modelMessages() as ModelMessage[],
            tools: aiTools,
            abortSignal: run.signal,
            maxRetries: 1,
            // The effort knob only goes to providers that take one, and under
            // the provider's own name, so the SDK turns it into the right body
            // field rather than an unknown parameter.
            ...(effort ? { providerOptions: { [resolved.provider.id]: { reasoningEffort: effort } } } : {}),
          })

          for await (const part of result.fullStream) {
            switch (part.type) {
              case "text-delta": {
                // Reasoning that arrives inline (a ` think` block in the text
                // stream) is pulled out here, so it never reaches the answer.
                const split = think.push(part.text)
                if (split.reasoning) {
                  reasoning += split.reasoning
                  run.onEvent?.({ type: "reasoning", delta: split.reasoning })
                }
                if (!split.text) break
                text += split.text
                // Hold back anything from the point a tool-call payload could
                // begin, so a near-miss JSON blob is never streamed to the user
                // as though it were an answer. The rest flows through normally.
                if (guardIndex === undefined) {
                  const at = toolCallGuardIndex(text, scanFrom)
                  scanFrom = at
                  if (at < text.length) guardIndex = at
                }
                const limit = guardIndex ?? text.length
                if (limit > streamedLength) {
                  const pending = text.slice(streamedLength, limit)
                  streamedLength = limit
                  run.onEvent?.({ type: "text", delta: pending })
                }
                break
              }
              case "reasoning-delta": {
                // Providers with a separate thinking channel (and local engines
                // that report reasoning_content).
                reasoning += part.text
                run.onEvent?.({ type: "reasoning", delta: part.text })
                break
              }
              case "tool-call":
                toolCalls.push({ id: part.toolCallId, name: part.toolName, args: part.input })
                break
              case "error":
                streamError = part.error instanceof Error ? part.error : new Error(String(part.error))
                break
              case "finish": {
                addUsage(totalUsage, part.totalUsage)
                stepUsage = {
                  inputTokens: part.totalUsage?.inputTokens ?? 0,
                  outputTokens: part.totalUsage?.outputTokens ?? 0,
                }
                finishReason = (part as { finishReason?: string }).finishReason
                break
              }
              default:
                break
            }
          }

          // Anything the splitter was still holding — a partial tag, or a think
          // block the model never closed — lands before the step is judged.
          const tail = think.flush()
          if (tail.reasoning) {
            reasoning += tail.reasoning
            run.onEvent?.({ type: "reasoning", delta: tail.reasoning })
          }
          if (tail.text) text += tail.text
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error))
        }

        // Nothing has been generated when the engine refuses a request up front,
        // so retrying cannot duplicate output.
        if (streamError && isContextOverflow(streamError) && attempt < MAX_CONTEXT_RETRIES) {
          this.log.warn(`request exceeded the context window — compacting and retrying (attempt ${attempt + 1})`)
          await compact("overflow")
          continue
        }
        // A provider that does not know the requested effort level refuses the
        // request before generating anything. Step the level down once, then
        // give up on the knob — the user is told either way.
        if (streamError && effort && isEffortRejection(streamError)) {
          const next = effort === "max" ? "high" : undefined
          const note =
            next === undefined
              ? `${resolved.provider.id} does not support reasoning effort — continuing without it.`
              : `${resolved.provider.id} rejected reasoning effort "${effort}" — trying "${next}".`
          this.log.warn(note)
          run.onEvent?.({ type: "notice", text: note, tone: "info" })
          effort = next
          continue
        }
        // A tool call cut off mid-payload (a `write` that ran past the output
        // limit) is not a failure to report: it is a request to write in pieces.
        if (streamError && isTruncatedToolCall(streamError)) {
          this.log.debug(`discarding a cut-off tool call: ${errorMessage(streamError)}`)
          streamError = undefined
          finishReason = "length"
        }
        break
      }

      if (streamError) {
        run.onEvent?.({ type: "error", error: streamError })
        throw streamError
      }

      // Local models often emit a tool call as bare text instead of a structured
      // call (they leave off the wrapper their template asked for). That text is
      // a *request*, not an answer: recover it, and take back any of it that had
      // already reached the screen.
      const guard = toolCallGuardIndex(text)
      if (guard > streamedLength) {
        const pending = text.slice(streamedLength, guard)
        streamedLength = guard
        run.onEvent?.({ type: "text", delta: pending })
      }

      const held = text.slice(guard)
      if (held) {
        const isKnownName = (name: string): boolean => activeTools.get(name) !== undefined
        const recovered = toolCalls.length === 0 ? recoverTextToolCalls(held, isKnownName) : []
        if (recovered.length > 0) {
          toolCalls.push(...recovered.map((call) => ({ id: call.id, name: call.name, args: call.input })))
          this.log.debug(`recovered ${recovered.length} tool call(s) from model text`)
        }

        if (recovered.length > 0 || isToolCallAttempt(held) || isPendingToolCall(held)) {
          // Either it became a real call, or it was shaped like one but named
          // nothing runnable (or stopped mid-payload). Print the payload either
          // way is never the right answer.
          if (recovered.length === 0) {
            this.log.debug(`discarded an unrecognised tool-call payload (${held.length} chars)`)
            run.onEvent?.({ type: "tool-unrecognised", detail: held.trim().slice(0, 160) })
          }
          const cut = retractStartFor(text, guard)
          text = text.slice(0, cut)
          if (streamedLength > cut) {
            streamedLength = cut
            run.onEvent?.({ type: "text-reset", text })
          }
        } else {
          // A false alarm — the held text is ordinary content after all.
          run.onEvent?.({ type: "text", delta: held })
          streamedLength = text.length
        }
      }

      // Persist the assistant step. A step that produced neither an answer nor a
      // tool call — a payload the guard withheld — leaves no trace in history.
      if (text.trim() || toolCalls.length > 0) {
        sessions.addMessage({
          sessionId: session.id,
          role: "assistant",
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: { inputTokens: stepUsage.inputTokens, outputTokens: stepUsage.outputTokens, cost: 0 },
          metadata: {
            model: resolved.modelId,
            provider: resolved.provider.id,
            // Recorded on the turn's first step, and only there: the sources are
            // what the whole turn was working from, and repeating them on every
            // later step would be noise. Resuming the session brings them back.
            ...(ragRecorded || ragHits.length === 0
              ? {}
              : { ragSources: ragHits.map((hit) => ({ ...hit })) }),
          },
        })
        ragRecorded = true
      }

      if (text) finalText += (finalText ? "\n" : "") + text

      run.onEvent?.({ type: "step-end", step: steps, usage: stepUsage })

      // ── Output was cut off: carry the answer on instead of dropping it ────
      // Local models routinely run out of output room mid-file. Stopping there
      // is what makes generation look "incomplete"; asking for the rest, with an
      // explicit instruction not to repeat, is what makes it finish.
      if (finishReason === "length" && toolCalls.length === 0 && continuations < MAX_CONTINUATIONS) {
        continuations++
        sessions.addMessage({ sessionId: session.id, role: "user", content: CONTINUE_PROMPT })
        run.onEvent?.({ type: "continuation", attempt: continuations })
        this.log.debug(`output reached the limit — continuing (${continuations}/${MAX_CONTINUATIONS})`)
        continue
      }

      if (toolCalls.length === 0) {
        // The model is ready to answer. If this turn changed files and nothing
        // has looked at them since, ask for one pass of checking before the
        // answer stands — the difference between "I wrote it" and "it is there".
        const lastChange = changedFiles.size > 0 ? Math.max(...changedFiles.values()) : 0
        if (verifyChanges && lastChange > 0 && lastInspectionStep < lastChange && verifications < MAX_VERIFICATIONS) {
          verifications++
          const files = [...changedFiles.keys()]
          run.onEvent?.({ type: "verifying", files })
          sessions.addMessage({ sessionId: session.id, role: "user", content: VERIFY_PROMPT })
          this.log.debug(`verifying ${files.length} changed file(s) before finishing`)
          continue
        }
        break
      }

      // execute tools sequentially so permission prompts and output stay ordered
      for (const call of toolCalls) {
        run.signal?.throwIfAborted()
        const tool = activeTools.get(call.name)
        const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>
        const title = tool?.title?.(args)

        run.onEvent?.({ type: "tool-start", callId: call.id, name: call.name, args: call.args, title })

        let result: ToolResult
        if (!tool) {
          result = { ok: false, output: `Unknown tool: ${call.name}`, error: `Unknown tool: ${call.name}` }
        } else {
          const decision = permissions.check({ tool: call.name, detail: permissionDetail(call.name, args) })

          if (decision.action === "deny") {
            result = {
              ok: false,
              output: `Permission denied for tool "${call.name}".`,
              error: "permission denied",
            }
            run.onEvent?.({
              type: "permission",
              request: { tool: call.name, detail: permissionDetail(call.name, args) },
              allowed: false,
            })
          } else if (decision.action === "ask") {
            const request: PermissionRequest = { tool: call.name, detail: permissionDetail(call.name, args) }
            const allowed = this.options.onPermission
              ? await this.options.onPermission(request, call.name)
              : false
            run.onEvent?.({ type: "permission", request, allowed })
            if (!allowed) {
              result = {
                ok: false,
                output:
                  `Permission denied for tool "${call.name}". ` +
                  `(Non-interactive mode: re-run with --yes to auto-approve, or add an allow rule to imurun.json.)`,
                error: "permission denied",
              }
            } else {
              result = await this.executeTool(tool, args, run, call.name, vision)
            }
          } else {
            result = await this.executeTool(tool, args, run, call.name, vision)
          }
        }

        sessions.addMessage({
          sessionId: session.id,
          role: "tool",
          // An image-producing tool (a screenshot, a PNG read) hands its picture
          // back with the text, so a vision model sees it in the same step.
          content: result.images?.length
            ? [
                { type: "text" as const, text: result.output },
                ...result.images.map((image) => ({ type: "image" as const, mime: image.mime, data: image.data })),
              ]
            : result.output,
          toolCallId: call.id,
          metadata: { toolName: call.name },
        })

        run.onEvent?.({
          type: "tool-end",
          callId: call.id,
          name: call.name,
          ok: result.ok,
          output: result.output,
          title: result.title ?? title,
        })

        // Remember what changed, and whether the model looked at it afterwards.
        if (result.ok) {
          if (call.name === "write" || call.name === "edit") {
            const path = (result.data as { path?: string } | undefined)?.path
            if (path) changedFiles.set(path, steps)
          } else if (call.name === "read" || call.name === "shell") {
            lastInspectionStep = steps
          }
        }

        this.log.debug(`tool ${call.name} ${result.ok ? "ok" : "failed"}`)
      }
    }

    if (maxSteps !== undefined && steps >= maxSteps) {
      this.log.warn(`run stopped after reaching the explicit maxSteps cap (${maxSteps})`)
      run.onEvent?.({
        type: "notice",
        text: `stopped at the --max-steps cap (${maxSteps}) \u2014 the task may be unfinished`,
        tone: "warn",
      })
    }

    // Refresh the session digest so RAG and future recalls see this turn —
    // including any todos it introduced — without waiting for the session to end.
    if (memory && memoryOn && config.memory.autoSummarize) {
      try {
        await memory.summarize(sessions.get(session.id) ?? session, history())
      } catch (error) {
        this.log.debug(`memory digest skipped: ${errorMessage(error)}`)
      }
    }

    const done: AgentEvent = { type: "done", steps, usage: totalUsage }
    run.onEvent?.(done)

    return {
      text: finalText,
      steps,
      usage: totalUsage,
      model: resolved.modelId,
      provider: resolved.provider.id,
    }
  }

  /**
   * One vault per root, reused across turns so the card cache stays warm.
   * The root follows `memory.vaultPath`, defaulting to `~/.imurun/vault`.
   */
  private vaultCache?: { root: string; vault: CardVault }
  private cardVault(config: ImurunConfig): CardVault {
    const root = config.memory.vaultPath ?? imurunDir("vault")
    if (!this.vaultCache || this.vaultCache.root !== root) {
      this.vaultCache = { root, vault: new CardVault(root) }
    }
    return this.vaultCache.vault
  }

  private async executeTool(
    tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
    args: Record<string, unknown>,
    run: RunOptions,
    name: string,
    vision = false,
  ): Promise<ToolResult> {
    const ctx: ToolContext = {
      workingDir: run.workingDir,
      sessionId: run.sessionId,
      agentId: run.agentId,
      signal: run.signal,
      log: this.log.child(name),
      config: this.options.config,
      vision,
      ledger: ledgerFor(run.workingDir),
    }
    try {
      const result = await tool.execute(args, ctx)
      return result
    } catch (error) {
      return { ok: false, output: `Tool "${name}" threw: ${errorMessage(error)}`, error: errorMessage(error) }
    }
  }
}

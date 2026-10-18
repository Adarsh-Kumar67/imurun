/**
 * TuiApp — the interactive IMURUN session, full-screen.
 *
 * Layout (alternate screen buffer):
 *
 *   ┌ header ───────────────────────── model · agent · cwd ─────────────┐
 *   │ transcript (scrolling, streamed)                                 │
 *   │                                                                  │
 *   ├ overlay ── command palette / model picker / agent picker ────────┤
 *   ├ status ── hints, spinner, install progress ──────────────────────┤
 *   └ ❯ input ─────────────────────────────────────────────────────────┘
 *
 * Input is raw-mode key handling (see ./keys), rendering is whole-frame
 * (see ./screen and ./render). Everything is dependency-free so it behaves the
 * same in cmd.exe, Windows Terminal, and Unix terminals.
 */
import { existsSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import {
  Agent,
  ImurunDatabase,
  MemoryStore,
  PermissionManager,
  ProviderRegistry,
  SessionStore,
  ToolRegistry,
  createTaskTool,
  clearRagCache,
  defaultAgent,
  getAgent,
  getRagIndex,
  getSkill,
  loadAgents,
  loadConfigSafe,
  loadSkills,
  primaryAgents,
  restrictToolRegistry,
  subagents,
  syncSkillPack,
} from "@imurun/core"
import type {
  AgentEvent,
  PermissionRequest,
  SkillDefinition,
  SubagentRequest,
  SubagentResult,
  SubagentRunner,
} from "@imurun/core"
import { formatHits } from "@imurun/core"
import {
  CATALOG,
  createInstallRenderer,
  fittingModels,
  getCatalogModel,
  installModel,
  listInstalled,
  loadHardware,
  removeInstalled,
} from "@imurun/modelmgr"
import { RuntimeManager, activeHeartbeats, describeContext, ensureLocalRuntime, findInstalled, resolveLocalTarget } from "@imurun/runtime"
import type { LocalSession } from "@imurun/runtime"
import type {
  AgentDefinition,
  ImurunConfig,
  InstalledModel,
  PermissionMode,
  QuantType,
  Session,
} from "@imurun/schema"
import { formatBytes, formatDuration, formatTimestamp, setLogLevel } from "@imurun/util"
import { agentSwitchLine, caret as caretGlyph, ellipsis, progress as animProgress, spinnerFrame } from "./animate"
import { createCommandRegistry } from "./commands"
import { KeyParser, type KeyEvent, type MouseEvent } from "./keys"
import { creditLine, renderWordmark, welcomeLines } from "./logo"
import { Palette, type PaletteItem } from "./palette"
import { buildPromptBox, caretPosition, promptRowCount } from "./prompt"
import { estimateToolMs, progressPhrase, progressWords } from "./progress"
import { MessageQueue, formatQueue } from "./queue"
import { composeFrame, renderTranscript, type Block, type Tone } from "./render"
import { Screen } from "./screen"
import { sidebarLines, type SidebarState } from "./sidebar"
import { parseSlash, type ParsedSlash, type SlashRegistry } from "./slash"
import { firstLine, fitVisible, padVisible, visibleWidth } from "./text"
import { sym, theme } from "./theme"

export { fitInput } from "./text"

export interface TuiOptions {
  version: string
  workingDir: string
  database: ImurunDatabase
  config: ImurunConfig
}

interface SessionListItem {
  id: string
  title: string
  model?: string
  updatedAt: number
}

interface TurnUsage {
  inputTokens: number
  outputTokens: number
}

interface CompleteOverlay {
  kind: "complete"
}

interface PickOverlay {
  kind: "pick"
  title: string
  palette: Palette
  footer: string
  onSelect: (item: PaletteItem) => void
  onCancel?: () => void
  /** Free-form filter typed by the user (model/agent/skill pickers). */
  query: string
}

type Overlay = CompleteOverlay | PickOverlay

interface ConfirmModal {
  kind: "confirm"
  question: string
  hint: string
  resolve: (answer: string) => void
}

interface InputModal {
  kind: "input"
  question: string
  hint: string
  resolve: (value: string | null) => void
  saved: string
  savedCursor: number
}

type Modal = ConfirmModal | InputModal

const SPINNER_TICK_MS = 130
const RENDER_THROTTLE_MS = 40
/** The sidebar only appears when there is room for it and the chat. */
const SIDEBAR_MIN_COLUMNS = 96
const SIDEBAR_WIDTH = 26
/** How long the agent-change transition plays. */
const AGENT_SWITCH_MS = 700
/** Maximum input rows inside the prompt box. */
const MAX_INPUT_ROWS = 7

/** Commands that must work even while a turn is running. */
function isExitCommand(text: string): boolean {
  const name = text.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase()
  return name === "exit" || name === "quit" || name === "q"
}

/** File extension, used as the syntax label for a code preview. */
function languageOf(path: string | undefined): string | undefined {
  if (!path) return undefined
  const base = path.replace(/\\/g, "/").split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return ext.length > 0 && ext.length <= 10 ? ext : undefined
}

/**
 * A fixed-width elapsed time. `formatDuration` returns anything from "9s" to
 * "1h 23m"; on an animating status line that changing width drags everything
 * after it around, so the clock is padded to a constant.
 */
function padDuration(ms: number): string {
  return formatDuration(ms).padEnd(7, " ")
}

/**
 * The code a write/edit just put on disk, as a transcript block.
 *
 * The point of the tool call is the file; without this the chat only shows the
 * word "write". The block is capped — the file itself is on disk if the model
 * (or the user) wants all of it.
 */
function writtenCode(name: string, args: Record<string, unknown> | undefined): Block | undefined {
  if (!args || (name !== "write" && name !== "edit")) return undefined
  const content =
    typeof args.content === "string" ? args.content : typeof args.newString === "string" ? args.newString : undefined
  if (!content) return undefined
  const path = typeof args.path === "string" ? args.path : undefined
  const mode = typeof args.mode === "string" && args.mode !== "overwrite" ? args.mode : ""
  const label = `${name === "edit" ? "edited" : mode === "append" ? "appended to" : "wrote"} ${path ?? "file"}`
  return {
    kind: "code",
    text: content,
    lang: languageOf(path),
    title: label,
    maxLines: 40,
  }
}

export class TuiApp {
  readonly version: string
  config: ImurunConfig
  workingDir: string
  database: ImurunDatabase
  sessions: SessionStore
  providers: ProviderRegistry
  permissions: PermissionManager
  runtime: RuntimeManager
  /** Slash command registry (public so /help and completion can use it). */
  readonly commands: SlashRegistry

  agents: AgentDefinition[] = []
  agent: AgentDefinition = defaultAgent([])
  skills: SkillDefinition[] = []
  session!: Session
  modelRef?: string

  // ── rendering state ──
  private screen?: Screen
  private readonly parser = new KeyParser()
  private blocks: Block[] = []
  private transcriptCache?: { width: number; version: number; blink: number; anim: number; lines: string[] }
  private transcriptVersion = 0
  /**
   * Where the prompt box landed in the last frame, so a mouse click can be
   * turned into a caret position inside the input.
   */
  private frameLayout?: {
    promptTop: number
    promptRows: number
    promptTextRows: number
    promptLayout: Array<{ line: number; start: number }>
  }
  private renderTimer?: ReturnType<typeof setTimeout>
  private spinnerTimer?: ReturnType<typeof setInterval>
  private spinnerTick = 0
  private installLine?: string

  // ── input state ──
  private input = ""
  private inputCursor = 0
  private history: string[] = []
  private historyIndex = -1
  private historyDraft = ""
  /** Last message actually sent — the target of ctrl+z when nothing is queued. */
  private lastSent = ""
  private overlay?: Overlay
  private modal?: Modal
  private statusHint = ""
  /** Lines scrolled up from the bottom (derived from the view anchor each frame). */
  private scroll = 0
  /**
   * When set, the transcript is drawn from this absolute line rather than from
   * the bottom. Keeps the view pinned while a turn streams: new output lands
   * below the fold instead of shoving what the user is reading up and away.
   */
  private scrollAnchor?: number
  private lastViewportRows = 0

  // ── live panels ──
  private readonly queue = new MessageQueue()
  private agentSwitch?: { from: string; to: string; startedAt: number }
  private contextUsed = 0
  private contextMax = 32768
  private todos: string[] = []
  private transcriptLineCount = 0

  // ── session state ──
  private readonly baseTools: ToolRegistry
  private readonly subagentTools: ToolRegistry
  readonly memory = new MemoryStore()
  private localSession?: LocalSession
  private servingName?: string
  private abort?: AbortController
  private busy = false
  private closed = false
  private preloading = false
  private lastSigint = 0
  private lastActivity = 0
  private liveIndex?: number
  private readonly toolIndex = new Map<string, number>()
  /** Arguments of running tool calls, so the transcript can show what was written. */
  private readonly toolArgs = new Map<string, Record<string, unknown>>()
  /** Queue id → the transcript block echoing that queued message. */
  private readonly queuedBlocks = new Map<number, number>()
  /** Skill applied to the current request; shown as a chip, never as a message. */
  private skillChip?: { name: string; at: number }
  /** Set by /compact: run with a deliberately tighter history budget. */
  private compactBudget = false
  /** The tool currently running, so the status line can name the phase. */
  private runningTool?: { name: string; label: string; words: readonly string[]; startedAt: number }
  private readonly originalConsoleError: typeof console.error

  private readonly closePromise: Promise<number>
  private closeResolve!: (code: number) => void

  constructor(private readonly options: TuiOptions) {
    this.version = options.version
    this.workingDir = options.workingDir
    this.config = options.config
    this.database = options.database
    this.originalConsoleError = console.error

    this.sessions = new SessionStore(this.database)
    this.providers = new ProviderRegistry(this.config)
    this.runtime = new RuntimeManager(this.config)
    this.permissions = PermissionManager.withSavedRules(this.database, {
      rules: this.config.permissions.rules,
      disabledTools: this.config.disabledTools,
      mode: this.config.permissions.mode,
      projectPath: this.workingDir,
    })
    this.commands = createCommandRegistry()
    this.session = this.sessions.create({ workingDir: this.workingDir, model: this.config.model })
    this.modelRef = this.config.model ?? this.session.model

    this.subagentTools = ToolRegistry.default()
    this.baseTools = ToolRegistry.default()
    const runner: SubagentRunner = {
      listAgents: () => this.taskAgents(),
      run: (request) => this.runSubagent(request),
    }
    this.baseTools.register(createTaskTool(runner))

    this.closePromise = new Promise<number>((resolve) => {
      this.closeResolve = resolve
    })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<number> {
    await this.reloadAgents()
    this.agent = defaultAgent(this.agents)
    this.skills = await loadSkills({ workingDir: this.workingDir }).catch(() => [])

    // Keep stderr out of the frame: runtime logs would otherwise overwrite it.
    setLogLevel("warn")
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")
      this.pushNotice(text, "warn")
    }

    this.screen = new Screen(process.stdin, process.stdout)
    this.screen.onData((chunk) => this.handleInput(chunk))
    this.screen.onResize(() => this.render())
    this.screen.start()

    this.installSignalHandlers()
    this.pushWelcome()
    this.ensureTick()
    void this.refreshSidebar()
    this.render()

    // Bring the model up right away, in the background, so the first message
    // answers instantly instead of waiting on a cold load.
    void this.preload()
    // Build the project index in the background too: the first code_search
    // should be instant, not a pause while the tree is read.
    void this.warmIndex()

    return this.closePromise
  }

  /** Builds the project index off the critical path; never fails the startup. */
  private async warmIndex(): Promise<void> {
    try {
      await getRagIndex(this.workingDir).ensureFresh()
    } catch {
      /* the index is an optimisation — startup must not depend on it */
    }
  }

  async shutdown(code = 0): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopTick()
    if (this.renderTimer) clearTimeout(this.renderTimer)
    console.error = this.originalConsoleError
    this.screen?.stop()

    if (this.localSession) {
      await this.localSession.detach().catch(() => {})
      this.localSession = undefined
      // Free the model right now when we were the last client. Other clients
      // keep the runtime; the supervisor stops it when they leave too.
      try {
        const remaining = await activeHeartbeats(15_000)
        if (remaining.length === 0) await this.runtime.stop()
      } catch {
        /* best effort */
      }
    }

    try {
      this.database.close()
    } catch {
      /* already closed */
    }
    this.closeResolve(code)
  }

  // ── Transcript helpers ────────────────────────────────────────────────────

  private pushBlock(block: Block): void {
    this.blocks.push(block)
    this.transcriptVersion++
  }

  pushNotice(text: string, tone: Tone = "info"): void {
    this.pushBlock({ kind: "notice", text, tone })
    this.scheduleRender()
  }

  /** Command output: pre-formatted lines, styles preserved. */
  print(line = ""): void {
    this.pushBlock({ kind: "raw", text: line })
    this.scheduleRender()
  }

  printError(message: string): void {
    this.pushNotice(message, "error")
  }

  private pushWelcome(): void {
    const columns = this.screen?.size().columns ?? 80
    const contentWidth = Math.max(columns >= SIDEBAR_MIN_COLUMNS ? columns - SIDEBAR_WIDTH - 1 : columns, 20)
    const model = this.modelRef ?? this.config.model ?? "nothing yet \u2014 /model to choose one"
    for (const line of welcomeLines({ width: contentWidth, version: this.version, model, agent: this.agent.id, workingDir: this.workingDir })) {
      this.pushBlock({ kind: "raw", text: line })
    }
  }

  printCommands(): void {
    this.print()
    this.print(`  ${theme.bold("Commands")}`)
    for (const command of this.commands.unique()) {
      const names = [command.name, ...(command.aliases ?? [])].map((n) => `/${n}`).join(" ")
      this.print(`    ${theme.accent(names.padEnd(20))} ${theme.dim(command.summary)}`)
    }
    this.print()
  }

  clearScreen(): void {
    this.blocks = []
    this.liveIndex = undefined
    this.transcriptVersion++
    this.scheduleRender()
  }

  /** Reads a single line through an in-frame modal. */
  async ask(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.modal = {
        kind: "input",
        question,
        hint: "enter accepts \u00b7 esc cancels",
        saved: this.input,
        savedCursor: this.inputCursor,
        resolve: (value) => resolve(value ?? ""),
      }
      this.input = ""
      this.inputCursor = 0
      this.render()
    })
  }

  /** Yes/no (plus optional extra keys) through an in-frame modal. */
  private async confirm(question: string, hint = "[y/N]", allow: string[] = ["y", "n"]): Promise<string> {
    return new Promise<string>((resolve) => {
      this.modal = { kind: "confirm", question, hint, resolve }
      this.pendingAllowed = allow
      this.render()
    })
  }

  private pendingAllowed: string[] = ["y", "n"]

  // ── Input ─────────────────────────────────────────────────────────────────

  private handleInput(chunk: string): void {
    if (this.closed) return
    for (const key of this.parser.push(chunk)) {
      if (key.mouse) {
        this.handleMouse(key.mouse)
        if (this.closed) return
        continue
      }
      if (this.modal) this.handleModalKey(key)
      else if (this.overlay) this.handleOverlayKey(key)
      else this.handleChatKey(key)
      if (this.closed) return
    }
    this.render()
  }

  /**
   * Clicks and wheel. The wheel scrolls the transcript; a click inside the
   * prompt box places the caret on the character that was clicked, so the input
   * behaves like a normal text field rather than keyboard-only.
   */
  private handleMouse(event: MouseEvent): void {
    if (event.kind === "wheel-up") {
      this.scrollBy(3)
      this.render()
      return
    }
    if (event.kind === "wheel-down") {
      this.scrollBy(-3)
      this.render()
      return
    }
    if (event.kind !== "press") return
    if (this.modal || this.overlay) return
    if (this.placeCaretFromClick(event.x, event.y)) this.render()
  }

  /** Maps a click inside the prompt box to an offset in the input. */
  private placeCaretFromClick(x: number, y: number): boolean {
    const layout = this.frameLayout
    if (!layout) return false
    const rowInBox = y - layout.promptTop
    if (rowInBox < 0 || rowInBox >= layout.promptRows) return false
    // The box is: top border, `promptTextRows` text rows, bottom border.
    const textRow = rowInBox - 1
    if (textRow < 0 || textRow >= layout.promptTextRows) return false
    const entry = layout.promptLayout[textRow]
    if (!entry) return false

    const lines = this.input.split("\n")
    const line = lines[entry.line] ?? ""
    // A body line reads `│ ❯ text…`: border, one space, a two-cell marker, then
    // the text. Column 1 is the border, so the text starts at column 5.
    const visibleCol = Math.max(x - 5, 0)
    const ellipsis = entry.start > 0 ? 1 : 0
    const charInLine = Math.min(entry.start + Math.max(visibleCol - ellipsis, 0), line.length)

    let offset = 0
    for (let i = 0; i < entry.line; i++) offset += (lines[i]?.length ?? 0) + 1
    this.inputCursor = offset + charInLine
    this.historyIndex = -1
    this.syncCompletion()
    return true
  }

  private handleModalKey(key: KeyEvent): void {
    const modal = this.modal
    if (!modal) return

    if (key.ctrl && key.input === "c") {
      this.resolveModal(modal.kind === "confirm" ? "n" : null)
      return
    }

    if (modal.kind === "confirm") {
      if (key.name === "escape") return this.resolveModal("n")
      if (key.name === "enter") return this.resolveModal("y")
      const char = key.input?.toLowerCase()
      if (char && this.pendingAllowed.includes(char)) return this.resolveModal(char)
      return
    }

    // input modal — reuse the line editor
    if (key.name === "escape") return this.resolveModal(null)
    if (key.name === "enter") return this.resolveModal(this.input)
    if (this.applyEdit(key)) return
  }

  private resolveModal(value: string | null): void {
    const modal = this.modal
    if (!modal) return
    this.modal = undefined
    if (modal.kind === "input") {
      this.input = modal.saved
      this.inputCursor = modal.savedCursor
      modal.resolve(value)
    } else {
      modal.resolve(value ?? "n")
    }
    this.render()
  }

  private handleChatKey(key: KeyEvent): void {
    // control keys
    if (key.ctrl) {
      switch (key.input) {
        case "c":
          this.onSigint()
          return
        case "d":
          void this.shutdown(0)
          return
        case "l":
          this.clearScreen()
          return
        case "u":
          this.input = this.input.slice(0, this.inputCursor)
          this.syncCompletion()
          return
        case "j":
          // Shift+Enter usually arrives as Ctrl+J: a newline, not a send.
          this.insertText("\n")
          return
        case "z":
          // Undo: take the newest queued message back into the input box, or
          // restore the last thing sent when nothing is waiting.
          if (this.takeBackQueued()) return
          if (!this.input && this.lastSent) {
            this.input = this.lastSent
            this.inputCursor = this.input.length
            this.pushNotice("restored the last message you sent", "info")
          }
          return
        default:
          return
      }
    }

    if (key.name === "shift-tab") {
      this.cycleAgent()
      return
    }

    if (key.name === "pageup") {
      this.scrollBy(8)
      return
    }
    if (key.name === "pagedown") {
      this.scrollBy(-8)
      return
    }

    if (key.name === "enter") {
      this.submit()
      return
    }

    if (key.name === "tab") {
      if (!this.openCompletion()) this.completeInput()
      return
    }

    if (key.name === "escape") {
      if (this.input) {
        this.input = ""
        this.inputCursor = 0
        this.syncCompletion()
        return
      }
      if (this.busy) {
        this.interrupt()
        return
      }
      if (this.scroll > 0) {
        this.scroll = 0
        this.scrollAnchor = undefined
      }
      return
    }

    if (key.name === "up" || key.name === "down") {
      const delta = key.name === "up" ? -1 : 1
      // With an empty prompt the arrows are for reading back, not editing: they
      // walk the transcript a line at a time and never rewrite what is shown.
      if (!this.input.trim()) {
        this.scrollBy(-delta)
        return
      }
      // In a multi-line draft the arrows move the caret; otherwise they walk
      // back through what you have sent.
      if (this.input.includes("\n")) this.moveCaretVertical(delta)
      else this.moveHistory(delta)
      return
    }

    if (this.applyEdit(key)) return
  }

  /** Stops the turn in flight; anything queued still runs afterwards. */
  private interrupt(): void {
    if (!this.abort) return
    this.abort.abort()
    this.pushNotice("interrupted \u2014 say what you want changed, it will send next", "warn")
  }

  /**
   * Moves the transcript view. `delta` is in lines, positive = further back in
   * the log. The view is pinned by an absolute line index, so output that
   * arrives while the user is reading earlier text does not move it.
   */
  private scrollBy(delta: number): void {
    const rows = Math.max(this.lastViewportRows, 1)
    const maxTop = Math.max(this.transcriptLineCount - rows, 0)
    const currentTop = this.scrollAnchor ?? maxTop
    const next = Math.min(Math.max(currentTop - delta, 0), maxTop)
    this.scrollAnchor = next >= maxTop ? undefined : next
  }

  /** Moves the caret one display line up or down inside a multi-line draft. */
  private moveCaretVertical(delta: number): void {
    const lines = this.input.split("\n")
    const { row, col } = caretPosition(this.input, this.inputCursor)
    const target = row + delta
    if (target < 0) {
      this.inputCursor = 0
      return
    }
    if (target >= lines.length) {
      this.inputCursor = this.input.length
      return
    }
    let offset = 0
    for (let i = 0; i < target; i++) offset += lines[i]!.length + 1
    this.inputCursor = offset + Math.min(col, lines[target]!.length)
  }

  private insertText(text: string): void {
    this.input = this.input.slice(0, this.inputCursor) + text + this.input.slice(this.inputCursor)
    this.inputCursor += text.length
    this.historyIndex = -1
    this.syncCompletion()
  }

  /** Returns true when the key changed the input buffer. */
  private applyEdit(key: KeyEvent): boolean {
    switch (key.name) {
      case "left":
        this.inputCursor = Math.max(0, this.inputCursor - 1)
        return true
      case "right":
        this.inputCursor = Math.min(this.input.length, this.inputCursor + 1)
        return true
      case "home":
        this.inputCursor = 0
        return true
      case "end":
        this.inputCursor = this.input.length
        return true
      case "backspace":
        if (this.inputCursor > 0) {
          this.input = this.input.slice(0, this.inputCursor - 1) + this.input.slice(this.inputCursor)
          this.inputCursor--
          this.syncCompletion()
        }
        return true
      case "delete":
        if (this.inputCursor < this.input.length) {
          this.input = this.input.slice(0, this.inputCursor) + this.input.slice(this.inputCursor + 1)
          this.syncCompletion()
        }
        return true
      default:
        break
    }
    if (key.input) {
      this.insertText(key.input)
      return true
    }
    return false
  }

  private moveHistory(delta: number): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      this.historyDraft = this.input
      this.historyIndex = this.history.length
    }
    this.historyIndex = Math.min(Math.max(this.historyIndex + delta, 0), this.history.length)
    this.input = this.historyIndex === this.history.length ? this.historyDraft : (this.history[this.historyIndex] ?? "")
    this.inputCursor = this.input.length
  }

  // ── Command palette ───────────────────────────────────────────────────────

  /** Opens the suggestion menu when the input is a bare "/"-prefix. */
  private syncCompletion(): void {
    const openable = this.completionQuery() !== undefined
    if (openable) {
      // The filter changed, so start from the top suggestion again.
      this.completionSelection = 0
      if (!this.overlay || this.overlay.kind !== "complete") this.overlay = { kind: "complete" }
    } else if (this.overlay?.kind === "complete") {
      this.overlay = undefined
    }
  }

  private completionQuery(): string | undefined {
    if (!this.input.startsWith("/")) return undefined
    if (/\s/.test(this.input)) return undefined
    if (this.modal || (this.overlay && this.overlay.kind === "pick")) return undefined
    return this.input.slice(1)
  }

  private openCompletion(): boolean {
    if (this.completionQuery() === undefined) return false
    this.overlay = { kind: "complete" }
    return true
  }

  private completionMatches(): string[] {
    const query = this.completionQuery() ?? ""
    return this.commands.complete(query)
  }

  private completeInput(): void {
    const matches = this.completionMatches()
    if (matches.length === 0) return
    const first = matches[0]!
    this.setInput(`/${first}${this.commandTakesArgs(first) ? " " : ""}`)
  }

  private commandTakesArgs(name: string): boolean {
    const command = this.commands.find(name)
    return Boolean(command?.usage?.includes("<"))
  }

  private setInput(value: string): void {
    this.input = value
    this.inputCursor = value.length
    this.syncCompletion()
  }

  // ── Overlay handling ──────────────────────────────────────────────────────

  private handleOverlayKey(key: KeyEvent): void {
    const overlay = this.overlay
    if (!overlay) return

    if (overlay.kind === "complete") {
      if (key.name === "escape") {
        this.overlay = undefined
        return
      }
      if (key.name === "up") {
        this.moveCompletion(-1)
        return
      }
      if (key.name === "down") {
        this.moveCompletion(1)
        return
      }
      if (key.name === "tab") {
        this.completeInput()
        return
      }
      if (key.name === "enter") {
        const matches = this.completionMatches()
        const typed = this.input.slice(1).toLowerCase()
        // Enter runs an exactly-typed command; otherwise it accepts the
        // highlighted suggestion (running it when it takes no arguments).
        if (matches.includes(typed)) {
          this.overlay = undefined
          this.submit()
          return
        }
        const pick = matches[this.completionIndex()] ?? matches[0]
        if (pick) {
          this.overlay = undefined
          if (this.commandTakesArgs(pick)) this.setInput(`/${pick} `)
          else {
            this.setInput(`/${pick}`)
            this.submit()
          }
        }
        return
      }
      if (this.applyEdit(key)) this.syncCompletion()
      return
    }

    // pick overlay
    if (key.name === "escape") {
      this.closePick()
      return
    }
    if (key.name === "up") return void overlay.palette.move(-1)
    if (key.name === "down") return void overlay.palette.move(1)
    if (key.name === "pageup") return void overlay.palette.move(-5)
    if (key.name === "pagedown") return void overlay.palette.move(5)
    if (key.name === "enter") {
      const item = overlay.palette.selected()
      if (item) {
        this.closePick()
        overlay.onSelect(item)
      }
      return
    }
    if (key.name === "backspace") {
      overlay.query = overlay.query.slice(0, -1)
      overlay.palette.setQuery(overlay.query)
      return
    }
    if (key.name === "space" || key.input) {
      overlay.query += key.name === "space" ? " " : (key.input ?? "")
      overlay.palette.setQuery(overlay.query)
    }
  }

  /** Row the suggestion menu should highlight. */
  private completionIndex(): number {
    const matches = this.completionMatches()
    if (matches.length === 0) return -1
    const typed = this.input.slice(1).toLowerCase()
    const exact = matches.indexOf(typed)
    if (exact >= 0) return exact
    return Math.min(Math.max(this.completionSelection, 0), matches.length - 1)
  }

  private completionSelection = 0

  private moveCompletion(delta: number): void {
    const matches = this.completionMatches()
    if (matches.length === 0) return
    this.completionSelection = (this.completionSelection + delta + matches.length) % matches.length
  }

  private closePick(): void {
    const overlay = this.overlay
    this.overlay = undefined
    if (overlay && overlay.kind === "pick") overlay.onCancel?.()
  }

  private openPicker(
    title: string,
    items: PaletteItem[],
    onSelect: (item: PaletteItem) => void,
    footer = "enter selects \u00b7 esc closes",
  ): void {
    const palette = new Palette(items, { title, maxRows: 10 })
    this.overlay = { kind: "pick", title, palette, footer, onSelect, query: "" }
    this.render()
  }

  // ── Submitting ────────────────────────────────────────────────────────────

  private submit(): void {
    if (this.closed) return
    const text = this.input.trim()
    this.input = ""
    this.inputCursor = 0
    this.overlay = undefined
    this.completionSelection = 0
    if (!text) return
    // Sending always returns the log to live.
    this.scroll = 0
    this.scrollAnchor = undefined

    this.history.push(text)
    if (this.history.length > 500) this.history.shift()
    this.historyIndex = -1
    this.lastSent = text

    // While a turn is in flight, a plain message joins the queue. Anything and
    // everything else would either be lost or fight the running turn.
    if (this.busy) {
      if (isExitCommand(text)) {
        void this.shutdown(0)
        return
      }
      if (text.startsWith("/")) {
        const name = text.slice(1).split(/\s+/)[0]
        this.pushNotice(`the agent is working \u2014 esc interrupts, then run /${name}`, "warn")
        return
      }
      const item = this.queue.push(text)
      // Echo it straight away, marked as waiting, so the chat shows what was
      // sent even though the agent has not read it yet.
      this.pushBlock({ kind: "user", text, state: "pending" })
      this.queuedBlocks.set(item.id, this.blocks.length - 1)
      this.pushNotice(
        `queued #${this.queue.size} \u2014 ctrl+z takes it back, /queue drop ${this.queue.size} cancels it`,
        "info",
      )
      void this.refreshSidebar()
      return
    }

    const slash = parseSlash(text)
    if (slash) {
      this.busy = true
      this.ensureTick()
      void this.handleSlash(slash).finally(() => {
        this.busy = false
        void this.refreshSidebar()
        this.render()
      })
      return
    }

    // The message the user just sent belongs in the transcript, immediately.
    this.pushBlock({ kind: "user", text })
    void this.processChat(text)
  }

  /**
   * Takes the newest queued message back into the input box (ctrl+z), so it can
   * be edited before it runs. Returns false when there is nothing to undo.
   */
  takeBackQueued(): boolean {
    const last = this.queue.list().at(-1)
    if (!last) return false
    this.queue.remove(last.id)
    const index = this.queuedBlocks.get(last.id)
    this.queuedBlocks.delete(last.id)
    const block = index !== undefined ? this.blocks[index] : undefined
    if (block?.kind === "user") block.state = "undone"
    this.transcriptVersion++

    // Put the text back where it came from, without clobbering a draft.
    this.input = this.input.trim() ? `${last.text}\n${this.input}` : last.text
    this.inputCursor = this.input.length
    this.syncCompletion()
    this.pushNotice("took the queued message back \u2014 edit it and press enter", "info")
    this.render()
    return true
  }

  /**
   * Drops a queued message by its 1-based position (`/queue drop 2`) and marks
   * its echo as undone, so the transcript matches what will actually run.
   */
  dropQueued(position: number): "dropped" | "missing" | "editing" {
    const items = this.queue.list()
    const item = items[position - 1]
    if (!item) return "missing"
    if (this.input.trim()) return "editing"
    this.queue.remove(item.id)
    const index = this.queuedBlocks.get(item.id)
    this.queuedBlocks.delete(item.id)
    const block = index !== undefined ? this.blocks[index] : undefined
    if (block?.kind === "user") block.state = "undone"
    this.transcriptVersion++
    void this.refreshSidebar()
    this.render()
    return "dropped"
  }

  /** Softens the echo of a queued message once the agent starts reading it. */
  private releaseQueuedBlock(id: number): void {
    const index = this.queuedBlocks.get(id)
    this.queuedBlocks.delete(id)
    const block = index !== undefined ? this.blocks[index] : undefined
    if (block?.kind === "user") {
      block.state = undefined
      this.transcriptVersion++
    }
  }

  /**
   * Runs a chat turn, then anything queued while it was running — in order, so
   * an interruption never loses the user's words.
   */
  private async processChat(first: string): Promise<void> {
    if (this.busy) {
      this.queue.push(first)
      return
    }
    this.busy = true
    this.busySince = Date.now()
    this.ensureTick()
    try {
      let text: string | undefined = first
      while (text !== undefined && !this.closed) {
        await this.runTurn(text)
        const next = this.queue.shift()
        if (next) {
          this.releaseQueuedBlock(next.id)
          this.pushNotice(`sending queued message (${this.queue.size} still waiting)`, "info")
          text = next.text
        } else {
          text = undefined
        }
      }
    } finally {
      this.busy = false
      this.busySince = undefined
      // The view is deliberately left where the user put it: if they scrolled
      // back to read something, the end of the turn must not yank them forward.
      // With no anchor set the log keeps following the newest line anyway.
      this.stopTick()
      void this.refreshSidebar()
      this.render()
    }
  }

  private async handleSlash(parsed: ParsedSlash): Promise<void> {
    if (!parsed.name) {
      this.printCommands()
      return
    }
    const command = this.commands.find(parsed.name)
    if (!command) {
      this.printError(`Unknown command: /${parsed.name}`)
      const suggestions = this.commands.complete(parsed.name)
      if (suggestions.length > 0) {
        this.print(theme.dim(`  did you mean: ${suggestions.map((s) => `/${s}`).join(", ")}?`))
      } else {
        this.print(theme.dim("  type /help for the list"))
      }
      return
    }
    await command.run?.(this, parsed.args)
  }

  // ── The agent turn ────────────────────────────────────────────────────────

  private touchActivity(): void {
    if (!this.localSession) return
    const now = Date.now()
    if (now - this.lastActivity < 1500) return
    this.lastActivity = now
    void this.localSession.manager.activity(this.session.id).catch(() => {})
  }

  private async runTurn(input: string): Promise<void> {
    const ready = await this.ensureModel()
    if (!ready) return

    const controller = new AbortController()
    this.abort = controller
    let usage: TurnUsage = { inputTokens: 0, outputTokens: 0 }
    const started = Date.now()
    this.liveIndex = undefined
    // The chip belongs to the request in flight; clear the previous one so a
    // turn that selects no skill does not show a stale one.
    this.skillChip = undefined

    const tools = restrictToolRegistry(this.baseTools, this.agent)
    const extra = this.agent.prompt.trim() ? [this.agent.prompt] : undefined

    const onEvent = (event: AgentEvent): void => {
      this.touchActivity()
      switch (event.type) {
        case "text":
          this.appendAssistant(event.delta)
          break
        case "text-reset":
          // Text already on screen turned out to be part of a tool call; take it
          // back rather than leaving a half-written JSON blob in the transcript.
          this.resetAssistant(event.text)
          break
        case "tool-unrecognised":
          this.pushNotice(
            `the model asked for a tool that is not available \u2014 ${event.detail}`,
            "warn",
          )
          break
        case "skill":
          // A skill is a way of working that was applied to the request, not a
          // chat message. It shows up as a chip in the status bar and is fed to
          // the model as part of the prompt.
          this.skillChip = { name: event.name, at: Date.now() }
          this.scheduleRender()
          break
        case "compacted":
          if (event.droppedMessages > 0 || event.reason !== "budget") {
            this.pushNotice(
              `context full \u2014 folded ${event.droppedMessages} older message(s) into the session summary ` +
                `(${event.keptMessages} kept)`,
              "info",
            )
          }
          break
        case "continuation":
          this.pushNotice(`output limit reached \u2014 asking the model to continue where it stopped`, "warn")
          break
        case "verifying": {
          const shown = event.files.slice(0, 3).join(", ")
          const more = event.files.length > 3 ? ` +${event.files.length - 3} more` : ""
          this.pushNotice(
            `checking what changed before finishing \u2014 ${shown}${more}`,
            "info",
          )
          break
        }
        case "tool-start": {
          this.finalizeStreaming()
          const args = (typeof event.args === "object" && event.args !== null ? event.args : {}) as Record<string, unknown>
          this.toolArgs.set(event.callId, args)
          const label = event.title ?? event.name
          const words = progressWords(event.name, args)
          this.runningTool = { name: event.name, label, words, startedAt: Date.now() }
          this.pushBlock({
            kind: "tool",
            title: label,
            status: "running",
            startedAt: Date.now(),
            words,
            estimateMs: estimateToolMs(event.name),
          })
          this.toolIndex.set(event.callId, this.blocks.length - 1)
          this.liveIndex = undefined
          this.scheduleRender()
          break
        }
        case "tool-end": {
          const index = this.toolIndex.get(event.callId)
          const args = this.toolArgs.get(event.callId)
          this.runningTool = undefined
          const block: Block = {
            kind: "tool",
            title: event.title ?? event.name,
            status: event.ok ? "ok" : "fail",
            detail: firstLine(event.output, 160),
          }
          if (index !== undefined && this.blocks[index]) this.blocks[index] = block
          else this.pushBlock(block)
          this.transcriptVersion++
          this.toolIndex.delete(event.callId)
          this.toolArgs.delete(event.callId)

          // The file is on disk now, so show what went into it — the work should
          // be visible in the chat, not just the word "write".
          if (event.ok) {
            const preview = writtenCode(event.name, args)
            if (preview) this.pushBlock(preview)
          }
          this.scheduleRender()
          break
        }
        case "done":
          usage = event.usage
          break
        case "error":
          this.pushNotice(event.error.message, "error")
          break
        default:
          break
      }
    }

    try {
      const agent = new Agent({
        sessions: this.sessions,
        providers: this.providers,
        tools: this.baseTools,
        permissions: this.permissions,
        config: this.config,
        memory: this.memory,
        skills: this.skills,
        onPermission: (request, toolName) => this.handlePermission(request, toolName),
      })
      const result = await agent.run({
        sessionId: this.session.id,
        input,
        model: this.modelRef,
        workingDir: this.workingDir,
        agentId: this.agent.id,
        tools,
        extraSystemSections: extra,
        signal: controller.signal,
        contextWindow: this.contextMax,
        tightContext: this.compactBudget,
        onEvent,
      })
      this.finalizeStreaming()
      this.pushBlock({ kind: "gap" })
      this.pushBlock({
        kind: "meta",
        text:
          `${result.steps} step${result.steps === 1 ? "" : "s"} \u00b7 ` +
          `${usage.inputTokens}+${usage.outputTokens} tokens \u00b7 ${formatDuration(Date.now() - started)} \u00b7 ${result.model}`,
      })
    } catch (error) {
      const err = error as Error
      this.finalizeStreaming()
      if (err.name === "AbortError") {
        this.pushNotice("cancelled", "warn")
      } else {
        this.pushError(err)
      }
    } finally {
      this.abort = undefined
    }
  }

  private appendAssistant(delta: string): void {
    if (this.liveIndex === undefined || !this.blocks[this.liveIndex]) {
      this.pushBlock({ kind: "assistant", text: "", streaming: true })
      this.liveIndex = this.blocks.length - 1
    }
    const block = this.blocks[this.liveIndex]!
    if (block.kind === "assistant") {
      block.text += delta
      block.streaming = true
    }
    this.transcriptVersion++
    this.scheduleRender()
  }

  /**
   * Replaces the text of the message currently streaming. Used when the agent
   * discovers that what it had already sent was the payload of a tool call, not
   * an answer.
   */
  private resetAssistant(text: string): void {
    if (this.liveIndex !== undefined && this.blocks[this.liveIndex]?.kind === "assistant") {
      this.blocks[this.liveIndex] = { kind: "assistant", text, streaming: true }
    } else if (text) {
      this.pushBlock({ kind: "assistant", text, streaming: true })
      this.liveIndex = this.blocks.length - 1
    }
    this.transcriptVersion++
    this.scheduleRender()
  }

  /** Marks the message currently streaming as complete. */
  private finalizeStreaming(): void {
    if (this.liveIndex === undefined) return
    const block = this.blocks[this.liveIndex]
    if (block && block.kind === "assistant" && block.streaming) {
      block.streaming = false
      this.transcriptVersion++
    }
  }

  /** Turns SDK noise into a short, actionable message. */
  private pushError(error: Error): void {
    const message = error.message ?? String(error)
    this.pushNotice(message.split("\n")[0]!.slice(0, 300), "error")
  }

  private async handlePermission(request: PermissionRequest, toolName: string): Promise<boolean> {
    const answer = (
      await this.confirm(
        `${theme.bold(toolName)} ${theme.dim(request.detail ?? "")}`,
        "[Y]es / [n]o / [a]lways / [d]eny-always",
        ["y", "n", "a", "d"],
      )
    ).toLowerCase()

    if (answer === "a") {
      this.permissions.remember(request, "allow")
      return true
    }
    if (answer === "d") {
      this.permissions.remember(request, "deny")
      return false
    }
    return answer === "y"
  }

  // ── Model + runtime ───────────────────────────────────────────────────────

  private async ensureModel(): Promise<boolean> {
    let installed = await listInstalled()
    const requested = this.modelRef ?? this.agent.model ?? this.session.model ?? this.config.model

    if (installed.length === 0) {
      const ok = await this.autoInstall()
      if (!ok) return false
      installed = await listInstalled()
    }

    const resolution = resolveLocalTarget(requested, installed)
    if (resolution.error) {
      this.printError(resolution.error)
      return false
    }
    if (!resolution.modelRef) {
      this.printError("No model selected \u2014 /model to choose one.")
      return false
    }

    if (this.modelRef !== resolution.modelRef) {
      this.modelRef = resolution.modelRef
      if (this.session.model !== resolution.modelRef) {
        this.sessions.update(this.session.id, { model: resolution.modelRef })
      }
    }

    if (resolution.target) {
      if (resolution.target.contextLength && resolution.target.contextLength > 0) {
        this.contextMax = resolution.target.contextLength
      }
      if (this.servingName && this.servingName !== resolution.target.modelName) {
        await this.localSession?.detach().catch(() => {})
        this.localSession = undefined
        this.servingName = undefined
      }
      // Trust the recorded state only while the engine actually answers. If it
      // was stopped behind our back (another session, a crash), restart it
      // instead of letting the request fail with a connection error.
      if (this.localSession && !(await this.runtime.healthy())) {
        await this.localSession.detach().catch(() => {})
        this.localSession = undefined
        this.servingName = undefined
        this.pushNotice("the local runtime had stopped \u2014 bringing it back up", "warn")
      }
      if (!this.localSession) {
        try {
          this.localSession = await ensureLocalRuntime(this.config, resolution.target, this.session.id)
          this.servingName = resolution.target.modelName
        } catch (error) {
          this.printError(`could not start the local runtime: ${(error as Error).message}`)
          return false
        }
      } else {
        await this.localSession.manager.activity(this.session.id).catch(() => {})
      }
      // The engine decides the window it actually loads, and every request is
      // budgeted against it — so take the number from the runtime, not the
      // catalog, whenever the runtime can tell us.
      const state = await this.localSession.manager.status().catch(() => undefined)
      if (state?.state?.contextSize && state.state.contextSize > 0) {
        this.contextMax = state.state.contextSize
      }
    }

    return true
  }

  /** Loads the model as soon as the UI opens, without blocking input. */
  private async preload(): Promise<void> {
    if (this.preloading || this.closed) return
    this.preloading = true
    try {
      const installed = await listInstalled()
      if (installed.length === 0) {
        this.pushNotice("no local model yet \u2014 /model to pick one, or set this machine up now", "warn")
        this.openModelPicker()
        return
      }
      const ready = await this.ensureModel()
      if (ready) this.pushNotice(`model ready \u00b7 ${this.modelRef}`, "ok")
      void this.refreshSidebar()
      this.renderHeader()
    } catch (error) {
      this.pushNotice(`could not prepare the model: ${(error as Error).message}`, "warn")
    } finally {
      this.preloading = false
    }
  }

  private renderHeader(): void {
    this.transcriptVersion++
    this.scheduleRender()
  }

  private async autoInstall(): Promise<boolean> {
    const hardware = await loadHardware()
    const fitting = fittingModels(hardware, CATALOG)
    if (fitting.length === 0) {
      this.printError("No catalog model fits this machine's memory \u2014 /model to browse.")
      return false
    }

    const { model, recommendedQuant, reason } = fitting[0]!
    const variant = model.quantizations.find((q) => q.type === recommendedQuant)
    const size = variant ? ` \u00b7 ~${variant.sizeGB.toFixed(1)} GB` : ""

    this.pushNotice(
      `recommended for this machine: ${model.displayName} (${model.id} \u00b7 ${recommendedQuant}${size}) \u2014 ${reason}`,
      "ok",
    )
    const answer = (await this.confirm("set up this machine automatically?", "[Y/n]")).toLowerCase()
    if (answer === "n") {
      this.print(theme.dim("  skipped \u2014 /model to choose one"))
      return false
    }
    return this.install(model.id, recommendedQuant)
  }

  async install(modelId: string, quant?: QuantType): Promise<boolean> {
    const hardware = await loadHardware()
    const renderer = createInstallRenderer({
      onLine: (line) => {
        this.installLine = line
        this.scheduleRender()
      },
      onMessage: (line) => {
        this.installLine = undefined
        this.print(line)
      },
    })
    try {
      const installed = await installModel({
        modelId,
        quant,
        hardware,
        engineVariant: this.config.runtime.engineVariant,
        onEvent: (event) => renderer.onEvent(event),
      })
      renderer.dispose()
      this.installLine = undefined
      this.pushNotice(`installed ${installed.modelId} ${installed.quant}`, "ok")
      if (!this.modelRef) this.modelRef = `local/${installed.modelId}`
      return true
    } catch (error) {
      renderer.dispose()
      this.installLine = undefined
      this.printError(`install failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  // ── Pickers ───────────────────────────────────────────────────────────────

  private openModelPicker(): void {
    void this.buildModelPicker()
  }

  private async buildModelPicker(): Promise<void> {
    const installed = await listInstalled()
    const activeName = this.modelRef?.replace(/^local\//, "")
    const items: PaletteItem[] = installed.map((model) => ({
      id: model.id,
      label: model.modelId === activeName ? `${model.id}  \u25c0 active` : model.id,
      detail: `${model.quant} \u00b7 ${formatBytes(model.sizeBytes)}`,
      keywords: "local installed",
    }))

    items.push({ id: "__download__", label: "Download more models\u2026", detail: "browse the catalog", keywords: "install add" })
    if (installed.length > 0) {
      items.push({ id: "__remove__", label: "Delete an installed model\u2026", detail: "free disk space", keywords: "remove rm" })
    }

    this.openPicker("select a model", items, (item) => {
      if (item.id === "__download__") {
        this.openCatalogPicker()
        return
      }
      if (item.id === "__remove__") {
        void this.removeCommand([])
        return
      }
      void this.setModel(item.id)
    })
  }

  private openCatalogPicker(): void {
    void this.buildCatalogPicker()
  }

  private async buildCatalogPicker(): Promise<void> {
    const hardware = await loadHardware()
    const fitting = new Map(fittingModels(hardware, CATALOG).map((entry) => [entry.model.id, entry]))
    const items: PaletteItem[] = CATALOG.map((model) => {
      const fit = fitting.get(model.id)
      const tag = fit ? `fits \u00b7 ${fit.recommendedQuant}` : "may not fit this machine"
      return {
        id: model.id,
        label: model.displayName,
        detail: `${tag} \u00b7 ${model.paramsB}B \u00b7 ${model.description ?? ""}`.trim(),
        keywords: `${model.id} ${model.tags?.join(" ") ?? ""}`,
      }
    })
    items.sort((a, b) => (fitting.has(b.id) ? 1 : 0) - (fitting.has(a.id) ? 1 : 0))

    this.openPicker("download a model", items, (item) => {
      void this.installCommand([item.id])
    })
  }
  private openAgentPicker(): void {
    const items: PaletteItem[] = this.agents.map((agent) => ({
      id: agent.id,
      label: agent.id === this.agent.id ? `${agent.name}  \u25c0 active` : agent.name,
      detail: `${agent.mode === "subagent" ? "[subagent] " : ""}${agent.description}`,
      keywords: agent.id,
    }))
    this.openPicker("switch agent", items, (item) => this.setAgent(item.id), "enter switches \u00b7 shift+tab cycles \u00b7 esc closes")
  }

  private openSkillPicker(): void {
    const items: PaletteItem[] = this.skills.map((skill) => ({
      id: skill.id,
      label: skill.name,
      detail: skill.description,
      keywords: `${skill.id} ${skill.source}`,
      hint: skill.source === "builtin" ? undefined : skill.source,
    }))
    this.openPicker(
      "run a skill",
      items,
      (item) => {
        const skill = getSkill(this.skills, item.id)
        if (!skill) return
        this.setInput(skill.prompt)
        this.pushNotice(`skill "${skill.name}" loaded into the input \u2014 add any detail, then press enter`, "ok")
      },
      "enter loads the skill into the input \u00b7 esc closes",
    )
  }

  // ── Subagents ─────────────────────────────────────────────────────────────

  private taskAgents(): AgentDefinition[] {
    const subs = subagents(this.agents)
    return subs.length > 0 ? subs : [this.agent]
  }

  private async runSubagent(request: SubagentRequest): Promise<SubagentResult> {
    const def = (request.agentId ? getAgent(this.agents, request.agentId) : undefined) ?? this.taskAgents()[0]!
    const label = request.description ? ` ${theme.dim(request.description)}` : ""
    this.pushBlock({ kind: "notice", text: `${theme.accent(def.id)}${label}`, tone: "info" })

    const child = this.sessions.create({
      workingDir: request.workingDir,
      model: def.model ?? this.modelRef,
      parentSessionId: request.sessionId,
    })
    const tools = restrictToolRegistry(this.subagentTools, def)
    const extra = def.prompt.trim() ? [def.prompt] : undefined

    const agent = new Agent({
      sessions: this.sessions,
      providers: this.providers,
      tools: this.subagentTools,
      permissions: this.permissions,
      config: this.config,
      memory: this.memory,
      onPermission: (perm, name) => this.handlePermission(perm, name),
    })
    const result = await agent.run({
      sessionId: child.id,
      input: request.prompt,
      model: def.model ?? this.modelRef,
      workingDir: request.workingDir,
      agentId: def.id,
      tools,
      extraSystemSections: extra,
      signal: request.signal,
      contextWindow: this.contextMax,
      onEvent: request.onEvent
        ? (event: AgentEvent) => {
            if (event.type === "text") request.onEvent?.({ type: "text", delta: event.delta })
            else if (event.type === "text-reset") request.onEvent?.({ type: "reset", text: event.text })
            else if (event.type === "tool-start") request.onEvent?.({ type: "tool", name: event.name, title: event.title })
            else if (event.type === "step-start") request.onEvent?.({ type: "step", step: event.step })
          }
        : undefined,
    })

    return { text: result.text, agentId: def.id, sessionId: child.id }
  }

  // ── Command support (called by ./commands) ────────────────────────────────

  async reloadAgents(): Promise<void> {
    this.agents = await loadAgents({ workingDir: this.workingDir })
    this.skills = await loadSkills({ workingDir: this.workingDir }).catch(() => this.skills)
  }

  newSession(): void {
    this.session = this.sessions.create({
      workingDir: this.workingDir,
      model: this.modelRef ?? this.config.model,
    })
    this.pushNotice(`new session ${this.session.id.slice(0, 12)}\u2026`, "ok")
  }

  listSessions(): void {
    const list = this.sessions.list({ limit: 15, workingDir: this.workingDir })
    this.lastSessionList = list.map((s) => ({ id: s.id, title: s.title, model: s.model, updatedAt: s.updatedAt }))
    this.print()
    if (list.length === 0) {
      this.print(theme.dim("  no sessions yet"))
      this.print()
      return
    }
    this.print(`  ${theme.bold("Recent sessions")}`)
    list.forEach((s, index) => {
      const current = s.id === this.session.id ? theme.ok(` ${sym.bullet}`) : "  "
      this.print(
        `  ${theme.accent(String(index + 1).padStart(2))}.${current} ${s.title} ` +
          theme.dim(`\u00b7 ${s.id.slice(0, 12)}\u2026 \u00b7 ${s.model ?? "no model"} \u00b7 ${formatTimestamp(s.updatedAt)}`),
      )
    })
    this.print(theme.dim("  resume with /resume <number-or-id>"))
    this.print()
  }

  private lastSessionList: SessionListItem[] = []

  resumeSession(ref?: string): void {
    if (!ref) {
      this.listSessions()
      return
    }
    let id: string | undefined
    const index = Number(ref)
    if (Number.isInteger(index) && index >= 1 && index <= this.lastSessionList.length) {
      id = this.lastSessionList[index - 1]!.id
    } else {
      id = this.sessions
        .list({ limit: 200, workingDir: this.workingDir })
        .find((s) => s.id === ref || s.id.startsWith(ref))?.id
    }

    const session = id ? this.sessions.get(id) : undefined
    if (!session) {
      this.printError(`No session matches "${ref}" \u2014 /sessions to list them`)
      return
    }

    this.session = session
    this.modelRef = session.model ?? this.modelRef
    this.pushNotice(`resumed ${session.id.slice(0, 12)}\u2026 \u00b7 ${session.messageCount} messages`, "ok")

    const recent = this.sessions.getMessages(session.id).slice(-6)
    for (const message of recent) {
      const text = typeof message.content === "string" ? message.content : ""
      if (!text.trim()) continue
      if (message.role === "user") this.pushBlock({ kind: "user", text })
      else if (message.role === "assistant") this.pushBlock({ kind: "assistant", text: firstLine(text, 200) })
    }
  }

  async setModel(ref?: string): Promise<void> {
    const installed = await listInstalled()
    if (!ref) {
      if (installed.length === 0 && CATALOG.length > 0) {
        this.pushNotice("no model installed yet \u2014 pick one to download", "warn")
      }
      this.openModelPicker()
      return
    }

    const resolution = resolveLocalTarget(ref, installed)
    if (resolution.error) {
      this.printError(resolution.error)
      return
    }
    this.modelRef = resolution.modelRef
    if (resolution.target && this.servingName && this.servingName !== resolution.target.modelName) {
      await this.localSession?.detach().catch(() => {})
      this.localSession = undefined
      this.servingName = undefined
    }
    if (this.session.model !== resolution.modelRef) {
      this.sessions.update(this.session.id, { model: resolution.modelRef })
    }
    this.pushNotice(`model \u2192 ${resolution.modelRef ?? ref}`, "ok")
    void this.preload()
  }

  async showModels(): Promise<void> {
    const installed = await listInstalled()
    const activeName = this.modelRef?.replace(/^local\//, "")
    this.print()
    this.print(`  ${theme.bold("Installed models")}`)
    if (installed.length === 0) {
      this.print(theme.dim("  none \u2014 /model to download one"))
    } else {
      for (const model of installed) {
        const active = model.modelId === activeName ? theme.ok(` ${sym.bullet}`) : "  "
        this.print(`  ${active} ${model.id.padEnd(30)} ${theme.dim(`${model.quant} \u00b7 ${formatBytes(model.sizeBytes)}`)}`)
      }
    }

    const hardware = await loadHardware()
    const fitting = fittingModels(hardware, CATALOG).slice(0, 5)
    this.print()
    this.print(`  ${theme.bold("Recommended for this machine")}`)
    for (const rec of fitting) {
      const variant = rec.model.quantizations.find((q) => q.type === rec.recommendedQuant)
      const size = variant ? ` \u00b7 ~${variant.sizeGB.toFixed(1)} GB` : ""
      this.print(`    ${theme.accent(rec.model.id.padEnd(30))} ${theme.dim(`${rec.recommendedQuant}${size}`)}`)
    }
    this.print(theme.dim("  /model opens the picker \u00b7 /model <id> switches directly \u00b7 /remove <id> deletes"))
    this.print()
  }

  async installCommand(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) {
      this.openCatalogPicker()
      return
    }
    const quant = args[1] as QuantType | undefined
    const model = getCatalogModel(id)
    if (!model) {
      this.printError(`Unknown model "${id}" \u2014 /model to browse the catalog`)
      return
    }
    const variant = quant ? model.quantizations.find((q) => q.type === quant) : undefined
    const size = variant ? `\u00b7 ~${variant.sizeGB.toFixed(1)} GB` : ""
    const answer = (await this.confirm(`download ${model.displayName} ${size}?`, "[Y/n]")).toLowerCase()
    if (answer === "n") {
      this.print(theme.dim("  cancelled"))
      return
    }
    await this.install(id, quant)
  }

  async removeCommand(args: string[]): Promise<void> {
    const installed = await listInstalled()
    const ref = args[0]
    if (!ref) {
      if (installed.length === 0) {
        this.printError("no installed models to remove")
        return
      }
      this.openPicker(
        "delete a model",
        installed.map((model) => ({
          id: model.id,
          label: model.id,
          detail: `${model.quant} \u00b7 frees ${formatBytes(model.sizeBytes)}`,
        })),
        (item) => void this.removeCommand([item.id]),
      )
      return
    }

    const match = findInstalled(installed, ref)
    if (!match) {
      this.printError(`No installed model matches "${ref}" \u2014 /model to list them`)
      return
    }
    const answer = (await this.confirm(`delete ${match.id} and free ${formatBytes(match.sizeBytes)}?`, "[y/N]")).toLowerCase()
    if (answer !== "y") {
      this.print(theme.dim("  cancelled"))
      return
    }
    const removed = await removeInstalled(match.id)
    this.pushNotice(`removed ${match.id} \u00b7 freed ${formatBytes(removed?.sizeBytes ?? match.sizeBytes)}`, "ok")
    if (this.modelRef?.includes(match.modelId)) {
      this.modelRef = undefined
      this.servingName = undefined
    }
  }

  setAgent(id?: string): void {
    if (!id) {
      this.openAgentPicker()
      return
    }
    const agent = getAgent(this.agents, id)
    if (!agent) {
      this.printError(`Unknown agent "${id}" \u2014 /agents to list them`)
      return
    }
    if (agent.mode === "subagent") {
      this.pushNotice(`${agent.id} is a subagent \u2014 it normally runs inside \`task\`, but you can chat with it`, "warn")
    }
    this.applyAgent(agent)
  }

  /** Switches the active agent and plays the transition in the status line. */
  private applyAgent(next: AgentDefinition): void {
    const from = this.agent.id
    this.agent = next
    if (next.id !== from) {
      this.agentSwitch = { from, to: next.id, startedAt: Date.now() }
      this.ensureTick()
    }
    this.pushNotice(`agent \u2192 ${next.id} \u00b7 ${next.description}`, "ok")
  }

  /** Shift+Tab: cycle through the primary agents. */
  private cycleAgent(): void {
    const list = primaryAgents(this.agents)
    if (list.length === 0) return
    const index = list.findIndex((agent) => agent.id === this.agent.id)
    const next = list[(index + 1) % list.length]!
    this.applyAgent(next)
  }

  showAgents(): void {
    this.print()
    this.print(`  ${theme.bold("Agents")}`)
    for (const agent of this.agents) {
      const active = agent.id === this.agent.id ? theme.ok(` ${sym.bullet}`) : "  "
      const mode = agent.mode === "subagent" ? theme.dim(" [subagent]") : ""
      this.print(`  ${active} ${theme.accent(agent.id.padEnd(12))}${mode} ${theme.dim(agent.description)}`)
    }
    this.print(theme.dim("  /agent opens the picker \u00b7 shift+tab cycles \u00b7 add your own in ~/.imurun/agents/<id>.md"))
    this.print()
  }

  showSkills(): void {
    this.openSkillPicker()
  }

  async skillsCommand(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) {
      this.openSkillPicker()
      return
    }
    if (id === "sync" || id === "import" || id === "add") {
      await this.syncSkills(args[1])
      return
    }
    if (id === "list" || id === "all") {
      this.printSkills()
      return
    }
    const skill = getSkill(this.skills, id)
    if (!skill) {
      this.printError(`Unknown skill "${id}" \u2014 /skills to list them`)
      return
    }
    this.setInput(skill.prompt)
    this.pushNotice(`skill "${skill.name}" loaded into the input \u2014 add any detail, then press enter`, "ok")
  }

  /** `/skills list` — every skill, grouped by where it came from. */
  printSkills(): void {
    const groups: Array<{ label: string; source: SkillDefinition["source"] }> = [
      { label: "Built-in", source: "builtin" },
      { label: "Global (~/.imurun/skills)", source: "global" },
      { label: "Project (.imurun/skills)", source: "project" },
    ]
    this.print()
    for (const group of groups) {
      const skills = this.skills.filter((skill) => skill.source === group.source)
      if (skills.length === 0) continue
      this.print(`  ${theme.bold(`${group.label}  (${skills.length})`)}`)
      for (const skill of skills.slice(0, 60)) {
        this.print(`    ${theme.accent(skill.id.padEnd(24))} ${theme.dim(firstLine(skill.description, 60))}`)
      }
      this.print()
    }
    this.print(theme.dim(`  ${this.skills.length} skills \u00b7 /skills <id> loads one \u00b7 /skills sync [owner/repo] imports a pack`))
    this.print()
  }

  /**
   * Imports a published skill pack (default: Anthropic's public skills repo),
   * renaming anything that would shadow a built-in. Only freely licensed skills
   * are imported unless the caller opts in.
   */
  async syncSkills(source?: string): Promise<void> {
    this.ensureTick()
    this.pushNotice(`importing skill pack${source ? ` ${source}` : ""} \u2014 this needs a network connection\u2026`, "info")
    try {
      const result = await syncSkillPack({
        source,
        onStatus: (message) => {
          this.installLine = `  ${theme.accent(spinnerFrame(this.spinnerTick))} ${theme.dim(message)}`
          this.scheduleRender()
        },
      })
      this.installLine = undefined
      await this.reloadAgents()
      const names = result.imported.map((skill) => skill.id)
      const preview = names.slice(0, 5).join(", ")
      this.pushNotice(
        `imported ${names.length} skill(s) from ${result.source}${names.length > 5 ? ` (${preview}, \u2026)` : names.length ? ` (${preview})` : ""}`,
        "ok",
      )
      if (result.replaced.length > 0) this.print(theme.dim(`  renamed to avoid clashes: ${result.replaced.join(", ")}`))
      if (result.skipped.length > 0) {
        this.print(theme.dim(`  skipped ${result.skipped.length}: ${result.skipped.map((s) => s.id).join(", ")}`))
      }
      this.print(theme.dim(`  files written to ${result.dir}`))
    } catch (error) {
      this.installLine = undefined
      this.printError(`skill import failed: ${(error as Error).message}`)
    }
  }

  // ── Permissions ───────────────────────────────────────────────────────────

  private static readonly PERMISSION_MODES: Array<{ id: PermissionMode; label: string; detail: string }> = [
    { id: "auto", label: "Auto-approve", detail: "run every tool without asking (default) \u2014 fastest" },
    { id: "manual", label: "Manual", detail: "ask before writing files or running commands" },
    { id: "readonly", label: "Read-only", detail: "look, search and read \u2014 never change anything" },
  ]

  permissionCommand(mode?: string): void {
    const choices = TuiApp.PERMISSION_MODES
    if (!mode) {
      const current = this.permissions.getMode()
      this.openPicker(
        "tool approval",
        choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          detail: choice.detail,
          hint: choice.id === current ? "\u25c0 active" : undefined,
          keywords: `${choice.id} permission approval ${choice.id === "auto" ? "yolo allow everything" : ""}`,
        })),
        (item) => this.setPermissionMode(item.id as PermissionMode),
        "enter selects \u00b7 esc closes",
      )
      return
    }
    this.setPermissionMode(mode as PermissionMode)
  }

  setPermissionMode(mode: PermissionMode): void {
    if (!TuiApp.PERMISSION_MODES.some((choice) => choice.id === mode)) {
      this.printError(`Unknown permission mode "${mode}" \u2014 use auto, manual or readonly`)
      return
    }
    this.permissions.setMode(mode)
    const blurb =
      mode === "auto"
        ? "every tool runs without asking"
        : mode === "readonly"
          ? "IMURUN can look but not touch"
          : "IMURUN asks before changing anything"
    this.pushNotice(`permission mode \u2192 ${mode} \u00b7 ${blurb}`, mode === "auto" ? "warn" : "ok")
  }

  // ── Queue ─────────────────────────────────────────────────────────────────

  queueCommand(args: string[]): void {
    const verb = (args[0] ?? "").toLowerCase()
    if (verb === "clear" || verb === "drop-all") {
      const count = this.queue.size
      for (const item of this.queue.list()) {
        const index = this.queuedBlocks.get(item.id)
        this.queuedBlocks.delete(item.id)
        const block = index !== undefined ? this.blocks[index] : undefined
        if (block?.kind === "user") block.state = "undone"
      }
      this.transcriptVersion++
      this.queue.clear()
      this.pushNotice(count > 0 ? `cleared ${count} queued message(s)` : "nothing was queued", "ok")
      void this.refreshSidebar()
      return
    }
    if (verb === "drop" || verb === "remove") {
      const position = Number(args[1])
      if (!Number.isFinite(position) || position < 1) {
        this.printError("usage: /queue drop <n>")
        return
      }
      const outcome = this.dropQueued(position)
      if (outcome === "missing") this.printError(`no queued message at position ${position}`)
      else if (outcome === "editing") this.printError("clear the prompt first \u2014 /queue edit would overwrite what you typed")
      else this.pushNotice(`dropped queued message #${position}`, "ok")
      return
    }
    if (verb === "edit") {
      const position = Number(args[1])
      if (!Number.isFinite(position) || position < 1) {
        this.printError("usage: /queue edit <n>")
        return
      }
      if (this.input.trim()) {
        this.printError("clear the prompt first \u2014 editing would overwrite what you typed")
        return
      }
      const item = this.queue.list()[position - 1]
      if (!item) {
        this.printError(`no queued message at position ${position}`)
        return
      }
      this.queue.remove(item.id)
      const index = this.queuedBlocks.get(item.id)
      this.queuedBlocks.delete(item.id)
      const block = index !== undefined ? this.blocks[index] : undefined
      if (block?.kind === "user") block.state = "undone"
      this.transcriptVersion++
      this.input = item.text
      this.inputCursor = this.input.length
      this.syncCompletion()
      this.pushNotice(`editing queued message #${position} \u2014 press enter to send it`, "info")
      void this.refreshSidebar()
      this.render()
      return
    }
    this.print()
    if (this.queue.size === 0) {
      this.print(theme.dim("  nothing queued"))
    } else {
      for (const line of formatQueue(this.queue.list(), Math.max(this.screen?.size().columns ?? 80, 40))) this.print(theme.accent(line))
      this.print(
        theme.dim(
          "  /queue edit <n> pulls one back into the prompt \u00b7 /queue drop <n> cancels it \u00b7 ctrl+z undoes the last one",
        ),
      )
    }
    this.print()
  }

  showTools(): void {
    const tools = restrictToolRegistry(this.baseTools, this.agent).list()
    this.print()
    this.print(`  ${theme.bold(`Tools for agent "${this.agent.id}"`)}`)
    this.print(`    ${tools.map((tool) => theme.accent(tool.name)).join(theme.dim(", "))}`)
    this.print()
  }

  async changeDirectory(path?: string): Promise<void> {
    if (!path) {
      this.print(`  ${theme.dim("cwd")} ${this.workingDir}`)
      return
    }
    const next = resolvePath(this.workingDir, path)
    if (!existsSync(next)) {
      this.printError(`No such directory: ${next}`)
      return
    }

    await this.localSession?.detach().catch(() => {})
    this.localSession = undefined
    this.servingName = undefined

    this.workingDir = next
    this.database.close()
    this.database = await ImurunDatabase.openProject(this.workingDir)
    this.sessions = new SessionStore(this.database)
    this.permissions = PermissionManager.withSavedRules(this.database, {
      rules: this.config.permissions.rules,
      disabledTools: this.config.disabledTools,
      mode: this.config.permissions.mode,
      projectPath: this.workingDir,
    })

    const { loaded } = await loadConfigSafe(this.workingDir)
    this.config = loaded.config
    this.providers = new ProviderRegistry(this.config)
    this.runtime = new RuntimeManager(this.config)
    await this.reloadAgents()

    this.session = this.sessions.create({ workingDir: this.workingDir, model: this.modelRef })
    this.pushNotice(`cwd \u2192 ${this.workingDir}`, "ok")
  }

  /** `/memory` — what IMURUN remembers, plus an optional recall query. */
  async showMemory(query?: string): Promise<void> {
    const stats = await this.memory.stats()
    const kinds = Object.entries(stats.byKind)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ")

    this.print()
    this.print(`  ${theme.bold("Memory")}`)
    this.print(`    ${theme.dim("store")}    ${theme.muted(stats.path)}`)
    this.print(`    ${theme.dim("notes")}    ${stats.notes}${kinds ? theme.dim(` (${kinds})`) : ""}`)
    this.print(`    ${theme.dim("sessions")} ${stats.sessions} summarized`)

    const todos = await this.memory.openTodos(this.workingDir)
    if (todos.length > 0) {
      this.print(`  ${theme.bold("Open todos")}`)
      for (const todo of todos.slice(0, 12)) this.print(`    ${theme.warn(sym.bullet)} ${todo}`)
    }

    if (query) {
      const hits = await this.memory.search(query, { limit: 8, projectPath: this.workingDir })
      this.print(`  ${theme.bold(`Recall \u00b7 "${query}"`)}`)
      if (hits.length === 0) this.print(theme.dim("    nothing found"))
      else for (const line of formatHits(hits)) this.print(`    ${theme.dim(line)}`)
    } else {
      this.print(theme.dim("  /memory <query> searches it \u00b7 /compact folds older turns into the summary to free context"))
    }
    this.print()
  }

  /**
   * `/compact` — free room in the model's window, right now.
   *
   * This is not a report for the user. The older turns are folded into the
   * session digest, which is kept in the system prompt, so the model keeps the
   * thread of the conversation while the window it has to work in becomes
   * smaller. From here on the run uses a deliberately tighter history budget,
   * and anything that no longer fits is summarised rather than dropped.
   */
  async compactCommand(): Promise<void> {
    const messages = this.sessions.getMessages(this.session.id).filter((message) => message.role !== "system")
    if (messages.length === 0) {
      this.pushNotice("nothing to compact yet", "warn")
      return
    }
    const digest = await this.memory.summarize(this.session, messages)
    this.compactBudget = true
    this.pushNotice(
      `compacted ${digest.messageCount} message(s) into the session summary \u2014 the model keeps the record, ` +
        `the window is freed`,
      "ok",
    )
    if (digest.todos.length > 0) {
      this.print(`  ${theme.warn(sym.bullet)} ${theme.dim(`${digest.todos.length} open todo(s) carried forward`)}`)
    }
  }

  async showStatus(): Promise<void> {
    const status = await this.runtime.status().catch(() => undefined)
    const installed: InstalledModel[] = await listInstalled()
    const used = installed.reduce((sum, model) => sum + model.sizeBytes, 0)

    this.print()
    this.print(`  ${theme.bold("IMURUN status")}`)
    this.print(`    ${theme.dim("model")}    ${theme.accent(this.modelRef ?? "(none)")}`)
    this.print(`    ${theme.dim("agent")}    ${theme.accent(this.agent.id)}`)
    this.print(`    ${theme.dim("session")}  ${theme.muted(this.session.id)}`)
    this.print(`    ${theme.dim("cwd")}      ${theme.muted(this.workingDir)}`)
    if (status?.running && status.state) {
      this.print(
        `    ${theme.dim("runtime")}  ${theme.ok("running")} ${theme.dim(`${status.state.engine} \u00b7 ${status.state.model ?? "?"} \u00b7 port ${status.state.port}`)}`,
      )
      const context = describeContext(status.state)
      if (context) {
        this.print(
          `    ${theme.dim("context")}  ${theme.accent(context.window)}${context.detail ? theme.muted(`  ${context.detail}`) : ""}`,
        )
      }
    } else {
      this.print(`    ${theme.dim("runtime")}  ${theme.muted("stopped")}`)
    }
    this.print(`    ${theme.dim("storage")}  ${theme.muted(`${formatBytes(used)} in ${installed.length} model(s)`)}`)
    this.print()
  }

  async runtimeCommand(action?: string): Promise<void> {
    const verb = (action ?? "status").toLowerCase()
    if (verb === "status") {
      await this.showStatus()
      return
    }
    if (verb === "stop") {
      await this.runtime.stop()
      this.localSession = undefined
      this.servingName = undefined
      this.pushNotice("runtime stopped \u2014 memory freed", "ok")
      return
    }
    this.printError("usage: /runtime [status|stop]")
  }

  /**
   * /rag — the offline project index that backs the `code_search` tool.
   *
   * Exposed because "why didn't it find my file?" is a question the user will
   * ask, and the answer is usually "the index hasn't seen it yet".
   */
  async ragCommand(args: string[]): Promise<void> {
    const verb = (args[0] ?? "status").toLowerCase()
    const index = getRagIndex(this.workingDir)

    if (verb === "status" || verb === "info") {
      const stats = index.stats()
      this.print()
      this.print(`  ${theme.bold("Project index")}`)
      this.print(`    ${theme.dim("directory")}  ${theme.muted(stats.root)}`)
      if (stats.builtAt === 0) {
        this.print(`    ${theme.muted("not built yet \u2014 /rag index builds it, or just ask something that needs it")}`)
      } else {
        this.print(`    ${theme.dim("files")}      ${theme.accent(String(stats.files))}`)
        this.print(`    ${theme.dim("chunks")}     ${theme.accent(String(stats.chunks))}`)
        this.print(`    ${theme.dim("size")}       ${theme.muted(formatBytes(stats.characters))}`)
        this.print(`    ${theme.dim("updated")}    ${theme.muted(formatTimestamp(stats.builtAt))}`)
        this.print(`    ${theme.dim("snapshot")}   ${theme.muted(stats.persistPath)}`)
      }
      this.print()
      return
    }

    if (verb === "clear") {
      await index.clear()
      clearRagCache()
      this.pushNotice("project index cleared", "ok")
      return
    }

    if (verb === "index" || verb === "refresh") {
      this.pushNotice("indexing the project\u2026", "info")
      const result = await index.ensureFresh({ maxAgeMs: -1 })
      if (!result || !result.changedAnything) {
        this.pushNotice("index is already up to date", "ok")
        return
      }
      this.pushNotice(
        `indexed ${result.files} file(s) \u00b7 +${result.added} ~${result.changed} -${result.removed} \u00b7 ${result.chunks} chunks`,
        "ok",
      )
      return
    }

    if (verb === "help") {
      this.print(theme.muted("  usage: /rag [status|index|search <query>|clear]"))
      return
    }

    const query = (verb === "search" || verb === "find" ? args.slice(1) : args).join(" ").trim()
    if (!query) {
      this.printError("usage: /rag [status|index|search <query>|clear]")
      return
    }

    await index.ensureFresh()
    const hits = index.search(query, { limit: 6 })
    this.print()
    if (hits.length === 0) {
      this.print(`  ${theme.muted(`nothing in the project index matches "${query}"`)}`)
      this.print()
      return
    }
    for (const hit of hits) {
      this.print(`  ${theme.accent(`${hit.path}:${hit.start}-${hit.end}`)} ${theme.dim(`(score ${hit.score.toFixed(1)})`)}`)
      for (const line of hit.excerpt.split("\n").slice(0, 4)) this.print(`    ${theme.muted(line)}`)
    }
    this.print()
  }

  // ── Signals ───────────────────────────────────────────────────────────────

  private installSignalHandlers(): void {
    process.on("SIGINT", () => {
      // Raw mode usually delivers Ctrl+C as input, but a signal can still
      // arrive (e.g. from a supervisor); treat it the same way.
      this.onSigint()
    })
  }

  private onSigint(): void {
    if (this.overlay) {
      this.closePick()
      return
    }
    if (this.busy) {
      this.abort?.abort()
      return
    }
    const now = Date.now()
    if (now - this.lastSigint < 1500) {
      void this.shutdown(0)
      return
    }
    this.lastSigint = now
    this.pushNotice("press ctrl+c again to exit, or type /exit", "info")
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private scheduleRender(): void {
    if (this.closed || !this.screen) return
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      this.render()
    }, RENDER_THROTTLE_MS)
  }

  /** Keeps the animation clock running only while something is moving. */
  private ensureTick(): void {
    if (this.spinnerTimer) return
    this.spinnerTimer = setInterval(() => {
      this.spinnerTick++
      if (this.agentSwitch && Date.now() - this.agentSwitch.startedAt > AGENT_SWITCH_MS) this.agentSwitch = undefined
      if (!this.needsAnimation()) {
        this.stopTick()
        return
      }
      this.scheduleRender()
    }, SPINNER_TICK_MS)
    if (typeof this.spinnerTimer.unref === "function") this.spinnerTimer.unref()
  }

  private needsAnimation(): boolean {
    return this.busy || this.agentSwitch !== undefined || this.installLine !== undefined
  }

  private stopTick(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
  }

  private transcriptLines(width: number): string[] {
    const streaming = this.blocks.some((block) => block.kind === "assistant" && block.streaming)
    const running = this.blocks.some((block) => block.kind === "tool" && block.status === "running")
    const blink = streaming ? this.spinnerTick % 2 : 0
    // A running tool animates its phrase and bar, so its render is keyed on the
    // tick too; a still transcript keeps its cache.
    const anim = running ? this.spinnerTick : 0
    const cache = this.transcriptCache
    if (
      cache &&
      cache.width === width &&
      cache.version === this.transcriptVersion &&
      cache.blink === blink &&
      cache.anim === anim
    ) {
      return cache.lines
    }
    const lines = renderTranscript(this.blocks, width, {
      caret: caretGlyph(this.spinnerTick),
      tick: this.spinnerTick,
      now: Date.now(),
    })
    this.transcriptCache = { width, version: this.transcriptVersion, blink, anim, lines }
    return lines
  }

  render(): void {
    const screen = this.screen
    if (!screen || this.closed) return
    const { columns, rows } = screen.size()
    const width = columns
    const showSidebar = width >= SIDEBAR_MIN_COLUMNS
    const sidebarWidth = showSidebar ? SIDEBAR_WIDTH : 0
    const contentWidth = Math.max(width - sidebarWidth - (showSidebar ? 1 : 0), 20)

    const box = buildPromptBox({
      input: this.input,
      cursor: this.inputCursor,
      width,
      maxRows: promptRowCount(this.input, MAX_INPUT_ROWS),
      placeholder: this.statusHint || "ask anything \u2014 or type / for commands",
      hint: this.promptHint(),
      tone: this.modal?.kind === "input" ? "normal" : this.busy ? "busy" : this.queue.pending ? "queued" : "normal",
      paint: (text) => (this.input.startsWith("/") || this.modal?.kind === "input" ? theme.accent(text) : text),
    })

    const transcript = this.transcriptLines(contentWidth)
    this.transcriptLineCount = transcript.length

    const frame = composeFrame({
      width,
      height: rows,
      header: this.headerLines(width),
      sidebar: showSidebar ? { width: sidebarWidth, lines: sidebarLines(this.sidebarState(sidebarWidth)) } : undefined,
      transcript,
      overlay: this.overlayLines(contentWidth, rows),
      prompt: box.lines,
      promptCursor: box.cursor,
      status: this.statusLine(width),
      scroll: this.scroll,
      viewTop: this.scrollAnchor,
    })

    // Fold the resolved view back into state: `scroll` drives the hint and the
    // header, and the anchor is dropped once the view reaches the bottom, so
    // the log follows new output again.
    this.lastViewportRows = frame.viewportRows
    const maxTop = Math.max(transcript.length - frame.viewportRows, 0)
    this.scroll = Math.max(maxTop - frame.viewTop, 0)
    if (this.scrollAnchor !== undefined && this.scrollAnchor >= maxTop) this.scrollAnchor = undefined

    // Remember where the prompt box landed so a click can be mapped to a caret
    // position. The prompt is drawn full-width, so it always starts at column 1.
    this.frameLayout = {
      promptTop: frame.promptTop,
      promptRows: box.lines.length,
      promptTextRows: box.rows,
      promptLayout: box.layout,
    }

    screen.draw(frame.lines, frame.cursor)
  }

  private promptHint(): string | undefined {
    if (this.overlay) return undefined
    if (this.busy) return this.queue.pending ? `${this.queue.size} queued \u00b7 esc interrupts` : "esc interrupts"
    if (this.scroll > 0) return "pgdn to live"
    return undefined
  }

  private sidebarState(width: number): SidebarState {
    return {
      width,
      model: this.modelRef?.replace(/^local\//, ""),
      agent: this.agent.id,
      session: this.session.id.slice(0, 12),
      workingDir: this.workingDir,
      permissions: this.permissions.getMode(),
      context: { used: this.contextUsed, max: this.contextMax },
      todos: this.todos,
      queue: this.queue.size,
      busy: this.busy,
    }
  }

  /** Recomputes the sidebar's numbers: context use, todos, context window. */
  private async refreshSidebar(): Promise<void> {
    try {
      const messages = this.sessions.getMessages(this.session.id)
      let chars = 0
      for (const message of messages) {
        chars += typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length
      }
      this.contextUsed = Math.round(chars / 4)
      this.todos = (await this.memory.openTodos(this.workingDir)).slice(0, 8)
      const status = await this.runtime.status().catch(() => undefined)
      const runtimeContext = status?.running ? status.state?.contextSize : undefined
      if (runtimeContext && runtimeContext > 0) this.contextMax = runtimeContext
    } catch {
      /* the sidebar is cosmetic — never let it break a turn */
    }
    this.scheduleRender()
  }

  private headerLines(width: number): string[] {
    if (width < 40) return [fitVisible(` ${theme.brand("IMURUN")}`, width)]
    const model = this.modelRef?.replace(/^local\//, "") ?? this.config.model ?? "auto"
    const parts = [
      ` ${theme.brand("IMURUN")} ${theme.dim(`v${this.version}`)}`,
      `${theme.dim("model")} ${theme.accent(model)}`,
      `${theme.dim("agent")} ${theme.accent(this.agent.id)}`,
      theme.muted(this.workingDir),
    ]
    if (this.scroll > 0) parts.push(theme.warn("\u2191 reading back"))
    return [fitVisible(parts.join(theme.dim("  \u2502  ")), width)]
  }

  private overlayLines(width: number, rows: number): string[] {
    if (this.overlay?.kind === "complete") return this.completionLines(width, rows)
    if (this.overlay?.kind === "pick") return this.pickLines(this.overlay, width, rows)
    return []
  }

  private completionLines(width: number, rows: number): string[] {
    const matches = this.completionMatches()
    if (matches.length === 0) return []
    const maxRows = Math.max(1, Math.min(8, rows - 8))
    const selection = this.completionIndex()
    const window = matches.slice(0, maxRows)
    const items = window.map((name, index) => {
      const command = this.commands.find(name)
      return { label: `/${name}`, detail: command?.summary ?? "", selected: index === selection }
    })
    return this.boxLines("commands", items, width, `type to filter \u00b7 tab completes \u00b7 enter runs`, maxRows)
  }

  private pickLines(overlay: PickOverlay, width: number, rows: number): string[] {
    const maxRows = Math.max(1, Math.min(overlay.palette.maxRows, rows - 8))
    const visible = overlay.palette.window()
    const items = visible.items.map((item, index) => ({
      label: item.label,
      detail: item.detail ?? "",
      hint: item.hint,
      selected: visible.offset + index === overlay.palette.index,
    }))
    return this.boxLines(overlay.title, items, width, overlay.footer, maxRows)
  }

  private boxLines(
    title: string,
    items: Array<{ label: string; detail?: string; hint?: string; selected: boolean }>,
    width: number,
    footer: string,
    maxRows: number,
  ): string[] {
    const inner = Math.max(Math.min(width - 4, 80), 20)
    const lines: string[] = []
    const header = `${sym.diamond} ${title}`
    lines.push(theme.dim("\u256d\u2500 ") + theme.bold(header) + theme.dim(" " + "\u2500".repeat(Math.max(0, inner - visibleWidth(header) - 2))))
    const shown = items.slice(0, maxRows)
    for (const item of shown) {
      const marker = item.selected ? theme.accent(sym.arrow) : " "
      const label = item.selected ? theme.bold(item.label) : item.label
      const detail = item.detail ? theme.dim(`  ${item.detail}`) : ""
      const hint = item.hint ? theme.dim(`  ${item.hint}`) : ""
      lines.push(`${theme.dim("\u2502")} ${marker} ${fitVisible(label + detail + hint, inner)} ${theme.dim("\u2502")}`)
    }
    if (items.length > maxRows) lines.push(`${theme.dim("\u2502")} ${theme.dim(`  \u2026 ${items.length - maxRows} more`)}`)
    lines.push(theme.dim("\u2570\u2500 ") + theme.dim(footer))
    return lines
  }

  private statusLine(width: number): string {
    const modal = this.modal
    if (modal) {
      const tone = modal.kind === "confirm" ? "warn" : "info"
      const color = tone === "warn" ? theme.warn : theme.accent
      const question =
        modal.kind === "input" ? `${modal.question} ${theme.muted(this.input)}` : theme.bold(modal.question)
      return fitVisible(`  ${color("?")} ${question} ${theme.dim(modal.hint)}`, width)
    }

    if (this.installLine) return fitVisible(this.installLine, width)

    const spin = theme.accent(spinnerFrame(this.spinnerTick))

    if (this.agentSwitch) {
      const elapsed = Date.now() - this.agentSwitch.startedAt
      const line = agentSwitchLine({
        from: this.agentSwitch.from,
        to: this.agentSwitch.to,
        progress: animProgress(elapsed, AGENT_SWITCH_MS),
      })
      return fitVisible(`  ${spin} ${theme.muted(line)}`, width)
    }

    if (this.busy) {
      // Everything on this line is fixed-width, so the spinner and the clock
      // never shift the text around them (that jitter is very visible on a
      // terminal). The clock is padded; nothing animates except the spinner.
      const elapsed = padDuration(this.busySince ? Date.now() - this.busySince : 0)
      const tool = this.runningTool
      const label = tool ? tool.label : "working"
      const phase = tool && tool.words.length > 0 ? progressPhrase(tool.words, Date.now() - tool.startedAt) : ""
      const skill = this.skillChip ? `${theme.accent(this.skillChip.name)} ${theme.dim("\u00b7")} ` : ""
      const queued = this.queue.size > 0 ? `${theme.warn(`${this.queue.size} queued`)} ${theme.dim("\u00b7")} ` : ""
      const phasePart = phase ? ` ${theme.dim("\u00b7")} ${theme.muted(padVisible(phase, 22))}` : ""
      return fitVisible(
        `  ${spin} ${theme.dim(label)}${phasePart} ${theme.dim("\u00b7")} ${theme.dim(elapsed)} ${theme.dim("\u00b7")} ` +
          `${skill}${queued}${theme.dim("esc interrupts")}`,
        width,
      )
    }

    if (this.queue.pending) {
      return fitVisible(
        `  ${theme.warn(sym.bullet)} ${theme.dim(`${this.queue.size} message(s) queued \u2014 they send when a turn starts`)}`,
        width,
      )
    }

    if (this.statusHint) return fitVisible(`  ${theme.dim(this.statusHint)}`, width)

    // Keep the approval mode visible: the sidebar shows it too, but the sidebar
    // is hidden on narrow terminals and this is a setting worth never guessing.
    const mode = this.permissions.getMode()
    const modeText =
      mode === "auto" ? theme.warn("auto-approve") : mode === "readonly" ? theme.ok("read-only") : theme.dim("manual")
    return fitVisible(
      `  ${theme.dim("/")} commands ${theme.dim("\u00b7")} ${theme.dim("shift+tab")} agent ${theme.dim("\u00b7")} ` +
        `${theme.dim("pgup/pgdn")} scroll ${theme.dim("\u00b7")} approval ${modeText} ${theme.dim("\u00b7")} ` +
        `${theme.dim("ctrl+c")} twice to exit`,
      width,
    )
  }

  private busySince?: number
}

/** Boots the interactive TUI and resolves when the session ends. */
export async function startTui(options: TuiOptions): Promise<number> {
  const app = new TuiApp(options)
  return app.start()
}

/**
 * System prompt — assembles the agent's instructions.
 *
 * The prompt is built from stable sections in a fixed order. Local models
 * degrade quickly with sprawling prompts, so every section is terse, and
 * optional sections (memory, recalled context, compaction summary) only appear
 * when there is something real to say.
 *
 * Order matters: identity and rules first, then the environment, then anything
 * remembered, then the compacted history, then the agent-specific preamble and
 * project instructions (which should win on conflicts because they are closest
 * to the user's intent).
 */

export interface SystemPromptContext {
  workingDir: string
  model?: string
  /** Names of the tools available this run. */
  tools?: string[]
  /** What the agent can do here, in plain language (avoids over-promising). */
  capabilities?: string[]
  /** Active agent id, e.g. "build". */
  agent?: string
  /** Where the agent may write a new skill / agent the user asks for. */
  skillsDir?: string
  agentsDir?: string
  /** Learned user style profile. */
  userStyle?: string
  /** Relevant memories recalled from past sessions (formatted bullet lines). */
  memories?: string[]
  /** Durable notes the user asked IMURUN to keep. */
  notes?: string[]
  /** Unfinished work carried across sessions. */
  todos?: string[]
  /** Key/value facts about work in flight, from the project ledger. */
  inProgress?: string[]
  /** Summary of earlier turns that were compacted out of the window. */
  compactedSummary?: string
  /** Project instructions from config. */
  instructions?: string[]
  /** Extra sections appended for this run (agent preamble, skills). */
  extraSections?: string[]
}

function platformName(): string {
  switch (process.platform) {
    case "win32":
      return "Windows"
    case "darwin":
      return "macOS"
    default:
      return "Linux"
  }
}

const BASE = `You are IMURUN, a local-first coding agent working in the user's terminal.

You help with real software engineering: writing and editing code, finding and fixing bugs, refactoring, explaining code, and running commands.

How you work:
- Use the tools to look at the real files; never invent file contents or command output.
- Read a file before you edit it. Match the surrounding code style exactly.
- Prefer small, focused changes over rewrites, and keep unrelated refactors out of the way.
- Explain briefly what you are doing as you go — one or two sentences, not essays.
- Your output is rendered in a terminal, so avoid huge dumps and wall-of-text answers.
- If a request is ambiguous and getting it wrong would be costly, ask one short question instead of guessing.
- Admit uncertainty plainly rather than fabricating an answer.
- Stop when the task is done; do not keep going past what was asked.

Find things out before you answer:
- If the answer depends on something you do not already know — a library's current API, a version number, anything
  outside this project, anything recent — search for it first (web_search, then web_fetch to read the page).
  Never answer such a question from memory, and never guess.
- Trust what the code in this project actually says over what you assume a library does.

Writing files inside a small context window (a request that is too large is refused outright):
- Never emit a whole file in one call. Create it with mode "create", then extend it with mode "append" a few
  lines at a time — one to five — and keep every call small. Many small calls always beat one large one, and a
  call that runs past the output limit is cut off before it reaches the file.
- Whatever you have already written is on disk. Read it back (or its tail) instead of repeating it from memory.
- If the answer itself is long, write it into a file and summarise it in the chat.
- Record work in progress with the progress tool as you go, so a later step — or an interrupted run — resumes
  where you stopped instead of starting over.

Before you say you are done:
- Cross-check that every change actually landed: re-read the file you edited, or run the test or build you were
  asked about. Do not assume an edit worked because you asked for it.
- If a change did not land, or a command failed, do not simply repeat the same attempt. Work out what went
  wrong and try a different way.
- Then tell the user plainly what changed (with file paths), what you ran, and what the result was.

Keeping the user informed:
- Narrate the steps that matter as they happen: each file you change, each command you run and its outcome,
  each search you make, and anything you could not do.
- Never report success you have not checked, and never let a failure pass in silence.

What you can do from here (never claim more than this):
- Run anything through the shell: builds, tests, git, package managers, and CLIs.
- Open files, folders, applications and web links with the platform opener (start / open / xdg-open), and start
  long-running commands in the background rather than waiting on them.
- When the user asks for a new skill or agent, write it as a markdown file into the skills or agents directory
  shown in the environment section (frontmatter with a name and a description, then the instructions) and tell
  them it is ready. A skill describes how to do one kind of task; an agent is a working mode with its own prompt
  and tools.`

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n")
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const sections: string[] = [BASE]

  const environment = [
    "Environment:",
    `- Platform: ${platformName()}`,
    `- Project directory: ${ctx.workingDir}`,
    `- Today: ${new Date().toISOString().slice(0, 10)}`,
    ctx.model ? `- Model: ${ctx.model}` : "",
    ctx.agent ? `- Agent: ${ctx.agent}` : "",
    ctx.skillsDir ? `- Skills directory: ${ctx.skillsDir}` : "",
    ctx.agentsDir ? `- Agents directory: ${ctx.agentsDir}` : "",
  ].filter(Boolean)
  sections.push(environment.join("\n"))

  if (ctx.tools && ctx.tools.length > 0) {
    sections.push(
      `Available tools:\n${ctx.tools.join(", ")}\nUse them instead of describing what you would do. ` +
        `Relative paths resolve against the project directory.`,
    )
  }

  if (ctx.capabilities && ctx.capabilities.length > 0) {
    sections.push(`What you can do here (never claim more than this):\n${bullets(ctx.capabilities)}`)
  }

  if (ctx.userStyle) {
    sections.push(`The user's coding style (learned from their code):\n${ctx.userStyle}`)
  }

  if (ctx.notes && ctx.notes.length > 0) {
    sections.push(`Notes the user asked you to remember:\n${bullets(ctx.notes)}`)
  }

  if (ctx.memories && ctx.memories.length > 0) {
    sections.push(
      `Recalled from earlier sessions (may be incomplete — confirm before relying on it):\n${bullets(ctx.memories)}`,
    )
  }

  if (ctx.todos && ctx.todos.length > 0) {
    sections.push(
      "The current plan (the same list the user sees; tick each step off with the todo tool as soon as it is " +
        `really finished, and re-plan with action=plan when it changes):\n${bullets(ctx.todos)}`,
    )
  }

  if (ctx.compactedSummary) {
    sections.push(
      `Earlier in this session (older turns were compacted to save context; this is the full record of them):\n${ctx.compactedSummary}`,
    )
  }

  if (ctx.inProgress && ctx.inProgress.length > 0) {
    sections.push(
      "Work in progress recorded for this project (resume from here — check the files before assuming a line " +
        `above is still true, and mark entries done with the progress tool when you finish them):\n${bullets(ctx.inProgress)}`,
    )
  }

  for (const extra of ctx.extraSections ?? []) {
    if (extra.trim()) sections.push(extra.trim())
  }

  if (ctx.instructions && ctx.instructions.length > 0) {
    sections.push(`Project instructions (these take precedence):\n${bullets(ctx.instructions)}`)
  }

  return sections.join("\n\n")
}

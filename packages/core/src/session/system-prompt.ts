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
- Verify your work when you can: run the tests, the build, or re-read the file.
- If a request is ambiguous and getting it wrong would be costly, ask one short question instead of guessing.
- Admit uncertainty plainly rather than fabricating an answer.
- Stop when the task is done; do not keep going past what was asked.
- When the user asks you to create a new skill or agent, write it as a markdown file
  into the skills or agents directory shown in the environment section (frontmatter
  with a name and description, then the instructions), and tell them it is ready. A
  skill describes how to do one kind of task; an agent is a working mode with its own
  prompt and tools.

Working inside a small context window (this matters — a request that is too large is refused outright):
- Never try to emit a whole large file in one call. Create the file with write (mode "create" or "overwrite"),
  then add each following section with write mode "append", a few dozen lines at a time.
- Keep every tool call small. A call that runs past the output limit is cut off before it reaches the file.
- Whatever you already wrote is on disk. Read it back (or the tail of it) instead of repeating it from memory.
- If the answer itself is long, write it into a file and summarise it in the chat.
- Record work in progress with the progress tool as you go, so a later step — or an interrupted run — resumes
  exactly where you stopped instead of starting over.`

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
    sections.push(`Open todos carried over:\n${bullets(ctx.todos)}`)
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

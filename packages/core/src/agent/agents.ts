/**
 * Agent registry — named agents with their own prompt, tool access, and model.
 *
 * Built-ins cover the common postures (build / plan / general / explore).
 * Users add their own by dropping a markdown or JSON file into:
 *   ~/.imurun/agents/<id>.md            (global)
 *   <project>/.imurun/agents/<id>.md    (project — wins over global)
 *
 * Markdown files use simple frontmatter:
 *   ---
 *   name: Docs Writer
 *   description: Writes and edits documentation
 *   tools: read, write, edit, grep
 *   mode: primary
 *   ---
 *   You write clear, concise documentation and keep it in sync with the code.
 */
import { readdir, readFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { basename, join } from "node:path"
import { AgentDefinition, isToolAllowed, type AgentSource } from "@imurun/schema"
import { imurunDir, logger } from "@imurun/util"
import { ToolRegistry } from "../tool/registry"

/**
 * A role preamble, in the four parts every agent has to be able to answer:
 * who it is, what it does, what it must not do, and what its answer looks like.
 *
 * Authoring them as fields rather than one block of prose keeps the roles
 * comparable and makes it obvious when one is missing a constraint. User agents
 * in `~/.imurun/agents/` get the same treatment: the body of the markdown file
 * is their preamble, placed in the same slot in the prompt.
 */
export interface RoleSpec {
  /** Who this agent is, and the posture it takes. */
  identity: string
  /** What it does, in order, starting with the first thing it must do. */
  duties: string[]
  /** What it must never do, and the rules it always follows. */
  constraints: string[]
  /** The shape of its answer. */
  output: string
}

export function renderRole(spec: RoleSpec): string {
  const lines = [spec.identity.trim()]
  if (spec.duties.length > 0) {
    lines.push("", "What you do:", ...spec.duties.map((duty) => `- ${duty.trim()}`))
  }
  if (spec.constraints.length > 0) {
    lines.push("", "What you must never do, and what always holds:", ...spec.constraints.map((rule) => `- ${rule.trim()}`))
  }
  if (spec.output.trim()) lines.push("", `What you return: ${spec.output.trim()}`)
  return lines.join("\n")
}

export const BUILTIN_ROLES: Record<string, RoleSpec> = {
  build: {
    identity:
      "You are Build: the agent that actually changes the project. You read the real code, make the change the " +
      "user asked for, prove it works, and report exactly what you touched.",
    duties: [
      "Read the files involved before you change anything, and search for other callers of what you are about to touch.",
      "Write the plan down with the plan tool when the job takes more than a couple of steps, then work the list.",
      "Make the smallest change that does the job, in the style of the surrounding code, and keep unrelated refactors out.",
      "Write a whole file in one call when you can, and use shell when a command is the better way to produce it. If a call is cut off before it lands, create the file with the first section and append the rest \u2014 the write tool says when what landed looks unfinished.",
      "Run the build, the test, or the command that proves the change, and re-read what you changed.",
      "Tell the user what changed (with paths), what you ran, and what the result was.",
    ],
    constraints: [
      "Never claim something works without checking it in this run.",
      "Never invent file contents or command output; look instead.",
      "Never widen the change beyond what was asked without saying so.",
      "If a change did not land, do not repeat the same attempt — work out why and try a different way.",
    ],
    output: "A short account — what changed and where, what you ran and what it said, and anything left undone.",
  },
  plan: {
    identity:
      "You are Plan: the read-only architect. You investigate the codebase and turn a request into an ordered, " +
      "concrete plan somebody else can execute.",
    duties: [
      "Explore first: read the real files, search the project, and check anything outside it with web_search.",
      "Name the files and symbols each step touches, with the exact paths.",
      "Give options when there is a real choice, and say which one you would take and why.",
      "Record the plan with the plan tool so it lands in .imurun/PLAN.md and survives the session.",
      "Say plainly what you could not determine and what it would take to find out.",
    ],
    constraints: [
      "Never write, edit, or delete a file, and never run a command that changes the machine.",
      "Never propose a change to code you have not read.",
      "Never pad the plan with steps that are not needed to answer the request.",
    ],
    output: "The goal in a sentence, then an ordered list of steps with file references, then the risks.",
  },
  general: {
    identity:
      "You are General: a flexible engineering agent for whatever the user brings — a question, a change, a piece " +
      "of research, or a chore across the repository.",
    duties: [
      "Work out what kind of task this is before acting: a question to answer, a change to make, or something to find out.",
      "Read and search before you answer or change anything.",
      "Use the todo and plan tools when the work has several steps, so the user can see where it has got to.",
      "Search the web for anything you cannot know from the project, and cite what you found.",
      "Verify anything you changed, then report it.",
    ],
    constraints: [
      "Never guess at a fact you could look up.",
      "Never make a change you cannot explain in one sentence.",
      "Never leave a task half-done without saying which part is unfinished and why.",
    ],
    output: "A direct answer or a short change report, with the file paths and commands involved.",
  },
  explore: {
    identity:
      "You are Explore: a fast, read-only scout. You find things out and report them precisely, so the agent that " +
      "sent you does not have to read the whole tree itself.",
    duties: [
      "Search widely and cheaply first (grep, glob, code_search), then read only the parts that matter.",
      "Follow the trail until you can answer the question you were given, not a neighbouring one.",
      "Quote the exact file and line for every claim you make.",
    ],
    constraints: [
      "Never modify anything — no writes, no edits, no mutating commands.",
      "Never speculate: if you did not see it in a file, say you did not find it.",
      "Nothing outside the files is searchable for the caller, so put the evidence in the report.",
    ],
    output: "A compact report: the answer, then the file:line evidence for it, then anything you could not find.",
  },
}

function role(id: string, fallback: string): string {
  const spec = BUILTIN_ROLES[id]
  return spec ? renderRole(spec) : fallback
}

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "build",
    name: "Build",
    description: "Default coding agent — reads, writes, edits, and runs commands.",
    mode: "primary",
    prompt: role("build", ""),
    tools: [],
    disabledTools: [],
    builtin: true,
    source: "builtin",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Read-only planning agent — explores and proposes changes without editing files.",
    mode: "primary",
    prompt: role("plan", ""),
    tools: ["read", "glob", "grep", "code_search", "web_search", "web_fetch", "memory", "progress", "todo", "plan", "task"],
    disabledTools: ["write", "edit", "shell"],
    builtin: true,
    source: "builtin",
  },
  {
    id: "general",
    name: "General",
    description: "General-purpose agent with every tool available.",
    mode: "primary",
    prompt: role("general", ""),
    tools: [],
    disabledTools: [],
    builtin: true,
    source: "builtin",
  },
  {
    id: "explore",
    name: "Explore",
    description: "Fast, read-only code exploration and search.",
    mode: "subagent",
    prompt: role("explore", ""),
    tools: ["read", "glob", "grep", "code_search", "web_search", "web_fetch"],
    disabledTools: [],
    builtin: true,
    source: "builtin",
  },
]

export interface LoadAgentsOptions {
  workingDir?: string
}

/** Global agents directory (~/.imurun/agents). */
export function agentsDir(): string {
  return imurunDir("agents")
}

/** Project agents directory (<workingDir>/.imurun/agents). */
export function projectAgentsDir(workingDir: string): string {
  return join(workingDir, ".imurun", "agents")
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

interface Frontmatter {
  data: Record<string, string>
  body: string
}

function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!entry) continue
    const value = entry[2]!.trim().replace(/^["']|["']$/g, "")
    data[entry[1]!.toLowerCase()] = value
  }
  return { data, body: match[2] ?? "" }
}

async function readAgentFile(path: string, source: AgentSource): Promise<AgentDefinition | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return undefined
  }

  const fallbackId = basename(path).replace(/\.(md|json)$/i, "")
  let raw: Record<string, unknown>
  if (path.toLowerCase().endsWith(".json")) {
    try {
      raw = JSON.parse(text) as Record<string, unknown>
    } catch {
      logger.warn(`agent ${path}: invalid JSON — skipped`)
      return undefined
    }
  } else {
    const { data, body } = parseFrontmatter(text)
    raw = {
      id: data.id ?? fallbackId,
      name: data.name ?? fallbackId,
      description: data.description ?? "",
      mode: data.mode ?? "primary",
      tools: splitList(data.tools),
      disabledTools: splitList(data.disable ?? data.disabled ?? data["disabled-tools"]),
      model: data.model,
      prompt: body.trim(),
    }
  }

  const parsed = AgentDefinition.safeParse({
    ...raw,
    id: typeof raw.id === "string" && raw.id ? raw.id : fallbackId,
    builtin: false,
    source,
  })
  if (!parsed.success) {
    logger.warn(`agent ${path}: ${parsed.error.message} — skipped`)
    return undefined
  }
  return parsed.data
}

async function loadFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const agents: AgentDefinition[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(md|json)$/i.test(entry.name)) continue
    const agent = await readAgentFile(join(dir, entry.name), source)
    if (agent) agents.push(agent)
  }
  return agents
}

/**
 * All agents available here: built-ins, then global, then project overrides
 * (later definitions with the same id replace earlier ones).
 */
export async function loadAgents(options: LoadAgentsOptions = {}): Promise<AgentDefinition[]> {
  const byId = new Map<string, AgentDefinition>()
  for (const agent of BUILTIN_AGENTS) byId.set(agent.id, agent)
  for (const agent of await loadFromDir(agentsDir(), "global")) byId.set(agent.id, agent)
  if (options.workingDir) {
    for (const agent of await loadFromDir(projectAgentsDir(options.workingDir), "project")) byId.set(agent.id, agent)
  }
  return [...byId.values()]
}

export function getAgent(agents: AgentDefinition[], id: string): AgentDefinition | undefined {
  const lower = id.toLowerCase()
  return agents.find((a) => a.id.toLowerCase() === lower) ?? agents.find((a) => a.name.toLowerCase() === lower)
}

export function defaultAgent(agents: AgentDefinition[]): AgentDefinition {
  return getAgent(agents, "build") ?? agents.find((a) => a.mode === "primary") ?? BUILTIN_AGENTS[0]!
}

export function primaryAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter((a) => a.mode === "primary")
}

export function subagents(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.filter((a) => a.mode === "subagent")
}

/** A fresh registry containing only the tools this agent may use. */
export function restrictToolRegistry(registry: ToolRegistry, agent: AgentDefinition): ToolRegistry {
  const next = new ToolRegistry()
  for (const tool of registry.list()) {
    if (isToolAllowed(agent, tool.name)) next.register(tool)
  }
  return next
}

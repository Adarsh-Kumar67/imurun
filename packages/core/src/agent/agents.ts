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

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: "build",
    name: "Build",
    description: "Default coding agent — reads, writes, edits, and runs commands.",
    mode: "primary",
    prompt: "",
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
    prompt:
      "You are in PLANNING mode. Investigate the codebase and produce a clear, ordered plan with " +
      "concrete file references. Do NOT modify files or run mutating commands; you may read files, " +
      "search, and run read-only commands.",
    tools: ["read", "glob", "grep", "code_search", "web_search", "web_fetch", "memory", "task"],
    disabledTools: ["write", "edit", "shell"],
    builtin: true,
    source: "builtin",
  },
  {
    id: "general",
    name: "General",
    description: "General-purpose agent with every tool available.",
    mode: "primary",
    prompt: "",
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
    prompt:
      "You explore codebases and answer questions with precise file references. " +
      "Do not modify anything; return a concise, well-structured report.",
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

/**
 * Agent schemas — named agents with their own prompt, tool access, and model.
 *
 * Agents let the same machine behave differently: a read-only "plan" agent, a
 * full "build" agent, a fast "explore" subagent, and anything the user defines
 * under ~/.imurun/agents/ or <project>/.imurun/agents/.
 */
import { z } from "zod"

export const AgentMode = z.enum(["primary", "subagent"])
export type AgentMode = z.infer<typeof AgentMode>

export const AgentSource = z.enum(["builtin", "global", "project"])
export type AgentSource = z.infer<typeof AgentSource>

export const AgentDefinition = z.object({
  /** Stable identifier used on the command line and in `/agent <id>`. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  /** primary agents are selectable in the UI; subagents are invoked via `task`. */
  mode: AgentMode.default("primary"),
  /** Extra instructions appended to the base system prompt. */
  prompt: z.string().default(""),
  /** Tool allow-list. Empty means "every tool"; "*" is also accepted. */
  tools: z.array(z.string()).default([]),
  /** Tools removed even when otherwise allowed. */
  disabledTools: z.array(z.string()).default([]),
  /** Optional model override (e.g. a smaller model for subagents). */
  model: z.string().optional(),
  /** Built-in agents ship with IMURUN and are replaced by same-id user agents. */
  builtin: z.boolean().default(false),
  source: AgentSource.default("builtin"),
})
export type AgentDefinition = z.infer<typeof AgentDefinition>

/** True when `toolName` may run under this agent. */
export function isToolAllowed(agent: AgentDefinition, toolName: string): boolean {
  if (agent.disabledTools.includes(toolName)) return false
  if (agent.tools.length === 0) return true
  return agent.tools.includes("*") || agent.tools.includes(toolName)
}

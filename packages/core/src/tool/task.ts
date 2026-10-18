/**
 * task tool — delegates a focused sub-task to a subagent.
 *
 * The subagent runs in its own session (its own context window) and returns a
 * single text report, keeping the main conversation transcript clean. The host
 * provides the runner, so this tool stays free of provider/session wiring.
 */
import { optionalString, requireString, ok, type ImurunTool, type SubagentRunner } from "./types"

export function createTaskTool(runner: SubagentRunner): ImurunTool {
  const agentIds = runner.listAgents().map((agent) => agent.id)
  const agentList = agentIds.length > 0 ? agentIds.join(", ") : "general"

  return {
    name: "task",
    description:
      "Delegate a focused sub-task to a subagent that works in its own context window and " +
      "returns a concise text report. Use it for broad exploration, research, or independent " +
      "work so the main conversation stays uncluttered.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Short (3-5 word) description of the task, shown to the user.",
        },
        prompt: {
          type: "string",
          description: "The full, self-contained instructions for the subagent.",
        },
        agent: {
          type: "string",
          description: `Subagent to use. One of: ${agentList}. Defaults to the first available.`,
        },
      },
      required: ["prompt"],
    },
    title(args) {
      const description = optionalString(args, "description")
      return description ? `task ${description}` : "task"
    },
    async execute(args, ctx) {
      const prompt = requireString(args, "prompt")
      const description = optionalString(args, "description")
      const agent = optionalString(args, "agent")

      const result = await runner.run({
        prompt,
        description,
        agentId: agent,
        workingDir: ctx.workingDir,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      })

      const header = `[subagent ${result.agentId}]`
      const body = result.text.trim() || "(the subagent returned no output)"
      return ok(`${header}\n${body}`, { title: `task ${description ?? result.agentId}` })
    },
  }
}

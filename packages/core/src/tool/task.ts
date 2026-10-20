/**
 * task tool — delegates focused sub-tasks to subagents.
 *
 * A subagent runs in its own session, with its own context window, and returns
 * a single text report, so the main conversation stays clean and the details do
 * not crowd out the window.
 *
 * The brief is asked for as separate fields rather than one blob of prose: a
 * small model reliably fills in "aim / look at / approach / rules / tools /
 * return", and each part ends up in the child prompt in a predictable place.
 * Several sub-tasks can be sent in one call as a batch; they run one after
 * another, so each is finished before the next starts. `parallel: true` runs
 * them at the same time when the briefs are genuinely independent.
 */
import {
  optionalString,
  ok,
  fail,
  type ImurunTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
} from "./types"

/** The parts of a brief, in the order they are laid out for the child. */
export interface SubagentBrief {
  aim: string
  files?: string
  approach?: string
  rules?: string
  tools?: string
  expect?: string
}

/** Renders a brief into the self-contained prompt the child receives. */
export function renderBrief(brief: SubagentBrief, extraPrompt?: string): string {
  const parts: string[] = [`Aim: ${brief.aim.trim()}`]
  if (brief.files?.trim()) parts.push(`Look at: ${brief.files.trim()}`)
  if (brief.approach?.trim()) parts.push(`Which part / how far: ${brief.approach.trim()}`)
  if (brief.rules?.trim()) parts.push(`Rules: ${brief.rules.trim()}`)
  if (brief.tools?.trim()) parts.push(`Tools you may use: ${brief.tools.trim()}`)
  parts.push(`Return: ${brief.expect?.trim() || "a short, concrete report — findings, file paths, and anything you could not do."}`)
  if (extraPrompt?.trim()) parts.push("", extraPrompt.trim())
  return parts.join("\n")
}

/**
 * Checks that a brief is usable and returns the reason it is not, or undefined.
 * A subagent cannot see the conversation, so a brief with no aim — or one that
 * is just "look at the code" — is a wasted run.
 */
export function validateBrief(brief: Partial<SubagentBrief>): string | undefined {
  const aim = brief.aim?.trim() ?? ""
  if (!aim) return "the brief needs an aim — what should the subagent achieve?"
  if (aim.split(/\s+/).length < 3) return `the aim "${aim}" is too short to work from; say what to do and why`
  return undefined
}

function asBriefs(args: Record<string, unknown>): SubagentBrief[] {
  const raw = args.tasks
  if (!Array.isArray(raw)) return []
  const briefs: SubagentBrief[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const item = entry as Record<string, unknown>
    const aim = typeof item.aim === "string" ? item.aim : typeof item.prompt === "string" ? item.prompt : ""
    if (!aim.trim()) continue
    briefs.push({
      aim,
      files: typeof item.files === "string" ? item.files : undefined,
      approach: typeof item.approach === "string" ? item.approach : undefined,
      rules: typeof item.rules === "string" ? item.rules : undefined,
      tools: typeof item.tools === "string" ? item.tools : undefined,
      expect: typeof item.expect === "string" ? item.expect : undefined,
    })
  }
  return briefs
}

const BRIEF_FIELDS = {
  aim: { type: "string", description: "What the subagent must achieve. One or two sentences, specific." },
  files: { type: "string", description: "The files, directories or symbols it should look at (comma separated)." },
  approach: { type: "string", description: "How far to go: read only, or change X; which layer or abstraction." },
  rules: { type: "string", description: "Constraints it must respect (style, what not to touch)." },
  tools: { type: "string", description: "Tools it may use." },
  expect: { type: "string", description: "Exactly what to return — the shape of the report you want." },
}

export function createTaskTool(runner: SubagentRunner): ImurunTool {
  const agentIds = runner.listAgents().map((agent) => agent.id)
  const agentList = agentIds.length > 0 ? agentIds.join(", ") : "general"

  return {
    name: "task",
    description:
      "Delegate a focused sub-task to a subagent working in its own context window, which returns a concise " +
      "report. Use it for broad exploration, research, or a chunk of work that stands on its own. The subagent " +
      "cannot see this conversation, so fill the brief in properly: aim, the files to look at, how far to go, the " +
      "rules, and what to return. Set agent only to pick a different working mode; by default the subagent uses " +
      `yours. One of: ${agentList}. To run several chunks one after another, send them together in ` +
      "action=batch — each is finished before the next starts. Add parallel=true only when the briefs are " +
      "independent and can safely run at the same time.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["one", "batch"], description: "One sub-task, or several at once." },
        description: { type: "string", description: "Short (3-5 word) description, shown to the user." },
        aim: { type: "string", description: `For action=one. ${BRIEF_FIELDS.aim.description}` },
        files: { type: "string", description: BRIEF_FIELDS.files.description },
        approach: { type: "string", description: BRIEF_FIELDS.approach.description },
        rules: { type: "string", description: BRIEF_FIELDS.rules.description },
        tools: { type: "string", description: BRIEF_FIELDS.tools.description },
        expect: { type: "string", description: BRIEF_FIELDS.expect.description },
        prompt: {
          type: "string",
          description: "Only when the brief fields do not fit: the full instructions, used as-is.",
        },
        agent: {
          type: "string",
          description: `Subagent to use. One of: ${agentList}. Defaults to the agent making this call.`,
        },
        tasks: {
          type: "array",
          description: "For action=batch: the briefs, each with aim (required) and the other fields optional.",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              ...BRIEF_FIELDS,
            },
            required: ["aim"],
          },
        },
        parallel: {
          type: "string",
          enum: ["true", "false"],
          description:
            "For action=batch: run the briefs at the same time. Off by default - one task is finished before the next starts.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    title(args) {
      const description = optionalString(args, "description")
      const batch = Array.isArray(args.tasks) ? (args.tasks as unknown[]).length : 0
      if (batch > 0) {
        const parallel = optionalString(args, "parallel") === "true"
        return `task \u00b7 ${batch} ${parallel ? "in parallel" : "in sequence"}`
      }
      return description ? `task ${description}` : "task"
    },
    async execute(args, ctx) {
      const agent = optionalString(args, "agent")
      // The caller's own agent, so a subagent is the same kind of worker as the
      // one that spawned it unless the model asks for something else.
      const agentId = agent ?? ctx.agentId
      const shared = { workingDir: ctx.workingDir, sessionId: ctx.sessionId, signal: ctx.signal }

      const batch = asBriefs(args)
      const runOne = (request: Omit<SubagentRequest, "workingDir" | "sessionId" | "signal">) =>
        runner.run({ ...request, ...shared })

      if (batch.length > 1) {
        const problems = batch.map((brief) => validateBrief(brief)).filter(Boolean)
        if (problems.length > 0) return fail(`Each sub-task needs a usable brief: ${problems[0]}`)
        // Sequential by default: one task is finished, and its result is in
        // hand, before the next one starts. Two subagents editing the same
        // files at once is a race, and a subagent that is still working cannot
        // be consulted by the next one. `parallel: true` opts out of that
        // when the briefs are genuinely independent.
        const parallel = optionalString(args, "parallel") === "true"
        const results: SubagentResult[] = []
        if (parallel) {
          results.push(
            ...(await Promise.all(
              batch.map((brief, index) =>
                runOne({
                  prompt: renderBrief(brief),
                  description: `task ${index + 1}/${batch.length}`,
                  agentId,
                }),
              ),
            )),
          )
        } else {
          for (const [index, brief] of batch.entries()) {
            results.push(
              await runOne({
                prompt: renderBrief(brief),
                description: `task ${index + 1}/${batch.length}`,
                agentId,
              }),
            )
          }
        }
        const merged = results
          .map((result, index) => {
            const brief = batch[index]!
            return `## ${index + 1}. ${brief.aim.slice(0, 80)}\n${result.text.trim() || "(no output)"}`
          })
          .join("\n\n")
        return ok(
          `${batch.length} subagent${batch.length === 1 ? "" : "s"} finished ${parallel ? "in parallel" : "one after another"} ` +
            `(${results.map((result) => result.agentId).join(", ")}):\n\n${merged}`,
          { title: `task \u00b7 ${batch.length} ${parallel ? "in parallel" : "in sequence"}` },
        )
      }

      const prompt = optionalString(args, "prompt")
      const aim = optionalString(args, "aim")
      // A batch of one, or the top-level brief, is the same thing.
      const single: Partial<SubagentBrief> = batch[0] ?? {
        aim: aim?.trim() ?? "",
        files: optionalString(args, "files"),
        approach: optionalString(args, "approach"),
        rules: optionalString(args, "rules"),
        tools: optionalString(args, "tools"),
        expect: optionalString(args, "expect"),
      }
      if (!single.aim?.trim() && !prompt?.trim()) {
        return fail(
          "Give the subagent an aim (or a full prompt). It cannot see this conversation, so it needs its own instructions.",
        )
      }

      const brief: SubagentBrief = {
        aim: single.aim?.trim() || prompt!.trim().split("\n")[0]!,
        files: single.files,
        approach: single.approach,
        rules: single.rules,
        tools: single.tools,
        expect: single.expect,
      }
      if (!prompt) {
        const problem = validateBrief(brief)
        if (problem) return fail(problem)
      }

      const result = await runOne({
        prompt: prompt ?? renderBrief(brief),
        description: optionalString(args, "description"),
        agentId,
      })

      const header = `[subagent ${result.agentId}]`
      const body = result.text.trim() || "(the subagent returned no output)"
      return ok(`${header}\n${body}`, { title: `task ${optionalString(args, "description") ?? result.agentId}` })
    },
  }
}

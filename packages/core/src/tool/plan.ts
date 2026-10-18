/**
 * plan — the written shape of a piece of work, at `.imurun/PLAN.md`.
 *
 * A todo list says how far along a task is. A plan says what the task is: the
 * goal, the approach, and the ordered steps with the files each one touches.
 * For anything bigger than a couple of steps the model should write the plan
 * first, then work it, then mark it done — the file outlives the session, so a
 * later run (or the user) can see what was intended and where it got to.
 */
import { planCounts, planStoreFor } from "../todo/plan"
import type { PlanStepStatus } from "../todo/plan"
import { asArgs, fail, ok, optionalString, requireString } from "./types"
import type { ImurunTool } from "./types"

function asSteps(args: Record<string, unknown>): Array<{ title: string; files?: string[]; status?: PlanStepStatus }> {
  const raw = args.steps
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error("`steps` must be an array")
  const steps: Array<{ title: string; files?: string[]; status?: PlanStepStatus }> = []
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) steps.push({ title: entry })
      continue
    }
    if (typeof entry !== "object" || entry === null) continue
    const item = entry as Record<string, unknown>
    const title = typeof item.title === "string" ? item.title : typeof item.step === "string" ? item.step : ""
    if (!title.trim()) continue
    const files = Array.isArray(item.files) ? item.files.filter((file): file is string => typeof file === "string") : undefined
    const status = item.status === "done" ? ("done" as const) : item.status === "open" ? ("open" as const) : undefined
    steps.push({ title, files, status })
  }
  return steps
}

function render(steps: { title: string; files: string[]; status: PlanStepStatus }[]): string {
  return steps
    .map((step, index) => {
      const mark = step.status === "done" ? "x" : " "
      const refs = step.files.length > 0 ? ` \u2014 ${step.files.join(", ")}` : ""
      return `${index + 1}. [${mark}] ${step.title}${refs}`
    })
    .join("\n")
}

export const planTool: ImurunTool = {
  name: "plan",
  description:
    "Write down what you are about to do, in `.imurun/PLAN.md` in the project, before starting anything that " +
    "needs more than a couple of steps. action=write records the goal, the approach and the ordered steps (list " +
    "the files each step touches); action=show reads it back — do that first when you resume work or when the " +
    "user asks what the plan is. action=step ticks a step off (status=done) or reopens it; action=add-step " +
    "appends one; action=note adds a line of context or a decision; action=clear removes the file. Keep the plan " +
    "current as the work changes, and mark a step done only when it really is.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["write", "show", "step", "add-step", "note", "clear"],
        description: "What to do.",
      },
      goal: { type: "string", description: "For action=write: what the user is asking for, in one or two sentences." },
      approach: { type: "string", description: "For action=write: how you intend to get there." },
      steps: {
        type: "array",
        description:
          "For action=write: the ordered steps. Each entry is either a string, or " +
          '{ "title": "…", "files": ["src/a.ts"], "status": "open|done" }.',
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                title: { type: "string" },
                files: { type: "array", items: { type: "string" } },
                status: { type: "string", enum: ["open", "done"] },
              },
              required: ["title"],
            },
          ],
        },
      },
      ref: { type: "string", description: "For action=step: the step's number, id, or part of its title." },
      status: { type: "string", enum: ["open", "done"], description: "For action=step: the state to set." },
      title: { type: "string", description: "For action=add-step: the step." },
      files: { type: "array", items: { type: "string" }, description: "For action=add-step: files it touches." },
      text: { type: "string", description: "For action=note: the line to record." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  title(args) {
    const action = typeof args.action === "string" ? args.action : "plan"
    if (action === "write" && typeof args.goal === "string") return `plan \u00b7 ${args.goal.slice(0, 48)}`
    const ref = typeof args.ref === "string" ? ` ${args.ref}` : ""
    return `plan ${action}${ref}`
  },
  async execute(rawArgs, ctx) {
    try {
      const args = asArgs(rawArgs)
      const action = typeof args.action === "string" ? args.action : "show"
      const store = planStoreFor(ctx.workingDir)

      switch (action) {
        case "write": {
          const goal = requireString(args, "goal")
          const plan = await store.write({
            goal,
            approach: optionalString(args, "approach"),
            steps: asSteps(args),
          })
          const counts = planCounts(plan.steps)
          const body = plan.steps.length > 0 ? `\n${render(plan.steps)}` : ""
          return ok(`Plan written to .imurun/PLAN.md (${counts.done}/${counts.total} done):\n${plan.goal}${body}`, {
            title: `plan \u00b7 ${counts.total} steps`,
            data: plan,
          })
        }

        case "show": {
          const plan = await store.read()
          if (!plan) return ok("There is no plan for this project yet.")
          const counts = planCounts(plan.steps)
          const parts = [`Goal: ${plan.goal}`]
          if (plan.approach) parts.push(`Approach: ${plan.approach}`)
          parts.push(`${counts.done}/${counts.total} steps done:`)
          parts.push(render(plan.steps))
          if (plan.notes.length > 0) parts.push(`Notes:\n${plan.notes.map((note) => `- ${note}`).join("\n")}`)
          return ok(parts.join("\n"), { title: "plan", data: plan })
        }

        case "step": {
          const ref = optionalString(args, "ref")
          if (!ref?.trim()) return fail("action=step needs a ref (number, id, or part of the title).")
          const status: PlanStepStatus = args.status === "open" ? "open" : "done"
          const step = await store.setStepStatus(ref, status)
          if (!step) return fail(`No plan step matched "${ref}".`)
          const plan = await store.read()
          const counts = plan ? planCounts(plan.steps) : { done: 0, total: 0 }
          return ok(`[${status === "done" ? "x" : " "}] ${step.title} \u2014 ${counts.done}/${counts.total} done`, {
            title: `plan step ${status}`,
            data: step,
          })
        }

        case "add-step": {
          const title = optionalString(args, "title")
          if (!title?.trim()) return fail("action=add-step needs a title.")
          const files = Array.isArray(args.files) ? args.files.filter((file): file is string => typeof file === "string") : []
          const plan = await store.addStep(title, files)
          if (!plan) return fail("There is no plan yet — write one first with action=write.")
          return ok(`Step added: ${title.trim()}`, { title: "plan add-step", data: plan })
        }

        case "note": {
          const text = optionalString(args, "text")
          if (!text?.trim()) return fail("action=note needs text.")
          const plan = await store.addNote(text)
          if (!plan) return fail("There is no plan yet — write one first with action=write.")
          return ok("Recorded in the plan's notes.")
        }

        case "clear": {
          const had = await store.read()
          await store.clear()
          return ok(had ? "Plan cleared." : "There was no plan to clear.")
        }

        default:
          return fail(`Unknown action "${action}". Use write, show, step, add-step, note or clear.`)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  },
}

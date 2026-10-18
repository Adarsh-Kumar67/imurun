/**
 * Plans — the written-down shape of a task, at `.imurun/PLAN.md` in the project.
 *
 * A todo list answers "how far along am I". A plan answers "what are we doing
 * and why", which is the part a fresh session — or the user a week later — has
 * no way to reconstruct from the transcript. So when a task is bigger than a
 * couple of steps the agent writes the goal, the approach, and the ordered
 * steps down first, works the list, and updates it as the shape of the work
 * changes.
 *
 * The file is plain markdown and is the source of truth, so it can be read and
 * edited by hand, it diffs in git, and it is still there when the session is
 * gone. Step ids are derived from their text, so the file carries no metadata.
 */
import { join } from "node:path"
import { readText, removeIfExists, shortHash, writeFileAtomic } from "@imurun/util"

export type PlanStepStatus = "open" | "done"

export interface PlanStep {
  /** Stable across restarts: derived from the text. */
  id: string
  title: string
  /** Files the step touches, shown as `code` after the title. */
  files: string[]
  status: PlanStepStatus
}

export interface Plan {
  goal: string
  approach?: string
  steps: PlanStep[]
  /** Anything appended with the note action, in order. */
  notes: string[]
}

/** Rows of a plan handed to the model in the system prompt. */
export const PLAN_PROMPT_STEP_LIMIT = 15

export function planPath(projectPath: string): string {
  return join(projectPath, ".imurun", "PLAN.md")
}

export function planIdFor(title: string): string {
  return `pl_${shortHash(title.replace(/\s+/g, " ").trim().toLowerCase(), 8)}`
}

function normalise(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase()
}

const STEP = /^\s*(?:\d+[.)]|[-*+])\s*\[(.)\]\s*(.*)$/
/** A step line ends with its file references: `… — \`src/a.ts\`, \`src/b.ts\``. */
const FILE_REF = /`([^`]+)`/g

/** Reads PLAN.md. Returns undefined when there is no plan. */
export function parsePlan(markdown: string): Plan | undefined {
  const lines = markdown.split(/\r?\n/)
  let goal: string | undefined
  let approach: string | undefined
  const steps: PlanStep[] = []
  const notes: string[] = []
  let section = ""

  for (const raw of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw)
    if (heading) {
      section = heading[1]!.toLowerCase()
      continue
    }
    if (/^#\s+/.test(raw)) continue

    if (section === "goal") {
      if (!raw.trim()) continue
      goal = goal ? `${goal} ${raw.trim()}` : raw.trim()
      continue
    }
    if (section === "approach") {
      if (!raw.trim()) continue
      approach = approach ? `${approach} ${raw.trim()}` : raw.trim()
      continue
    }
    if (section === "steps") {
      const match = STEP.exec(raw)
      if (!match) continue
      const status: PlanStepStatus = /[xX]/.test(match[1]!) ? "done" : "open"
      const body = match[2]!.trim()
      if (!body) continue
      const files: string[] = []
      for (const ref of body.matchAll(FILE_REF)) files.push(ref[1]!.trim())
      const dash = body.search(/\s*[\u2014-]\s*`/)
      const title = (dash >= 0 ? body.slice(0, dash) : body).replace(FILE_REF, "").trim()
      if (!title) continue
      steps.push({ id: planIdFor(title), title, files, status })
      continue
    }
    if (section === "notes") {
      const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw)
      if (bullet && bullet[1]!.trim()) notes.push(bullet[1]!.trim())
      continue
    }
  }

  if (goal === undefined && steps.length === 0 && notes.length === 0) return undefined
  return { goal: goal ?? "(no goal recorded)", approach, steps, notes }
}

export function renderPlan(plan: Plan): string {
  const lines = ["# Plan", "", "## Goal", "", plan.goal.trim() || "(no goal recorded)", ""]
  if (plan.approach?.trim()) lines.push("## Approach", "", plan.approach.trim(), "")
  lines.push("## Steps", "")
  plan.steps.forEach((step, index) => {
    const mark = step.status === "done" ? "x" : " "
    const refs = step.files.length > 0 ? ` \u2014 ${step.files.map((file) => `\`${file}\``).join(", ")}` : ""
    lines.push(`${index + 1}. [${mark}] ${step.title.trim()}${refs}`)
  })
  if (plan.steps.length === 0) lines.push("_No steps recorded yet._")
  if (plan.notes.length > 0) {
    lines.push("", "## Notes", "")
    for (const note of plan.notes) lines.push(`- ${note.trim()}`)
  }
  return `${lines.join("\n")}\n`
}

/** Counts for the panel and `/plan`. */
export function planCounts(steps: PlanStep[]): { done: number; total: number } {
  return { done: steps.filter((step) => step.status === "done").length, total: steps.length }
}

/**
 * The plan as lines for the system prompt: the goal, then the steps with their
 * state. Deliberately short — the file has the detail when the model needs it.
 */
export function formatPlan(plan: Plan, limit = PLAN_PROMPT_STEP_LIMIT): string[] {
  const lines = [`goal: ${plan.goal}`]
  if (plan.approach) lines.push(`approach: ${plan.approach}`)
  for (const [index, step] of plan.steps.slice(0, limit).entries()) {
    const mark = step.status === "done" ? "x" : " "
    const refs = step.files.length > 0 ? ` (${step.files.join(", ")})` : ""
    lines.push(`${index + 1}. [${mark}] ${step.title}${refs}`)
  }
  if (plan.steps.length > limit) lines.push(`\u2026 ${plan.steps.length - limit} more step(s)`)
  return lines
}

export class PlanStore {
  constructor(readonly projectPath: string) {}

  async read(): Promise<Plan | undefined> {
    try {
      return parsePlan(await readText(planPath(this.projectPath)))
    } catch {
      return undefined
    }
  }

  private async save(plan: Plan): Promise<Plan> {
    await writeFileAtomic(planPath(this.projectPath), renderPlan(plan))
    return plan
  }

  /** Creates or replaces the plan. Steps may be plain strings or {title, files}. */
  async write(input: {
    goal: string
    approach?: string
    steps?: Array<string | { title: string; files?: string[]; status?: PlanStepStatus }>
  }): Promise<Plan> {
    const goal = input.goal.replace(/\s+/g, " ").trim()
    if (!goal) throw new Error("a plan needs a goal")
    const steps: PlanStep[] = []
    for (const entry of input.steps ?? []) {
      const raw = typeof entry === "string" ? { title: entry } : entry
      const title = raw.title.replace(/\s+/g, " ").trim()
      if (!title) continue
      steps.push({
        id: planIdFor(title),
        title,
        files: raw.files ?? [],
        status: raw.status ?? "open",
      })
    }
    const existing = await this.read()
    return this.save({ goal, approach: input.approach?.trim(), steps, notes: existing?.notes ?? [] })
  }

  /** Updates the goal (or the approach) without touching the steps. */
  async setGoal(goal: string, approach?: string): Promise<Plan> {
    const plan = (await this.read()) ?? { goal: "", steps: [], notes: [] }
    return this.save({
      ...plan,
      goal: goal.replace(/\s+/g, " ").trim() || plan.goal,
      approach: approach?.trim() ?? plan.approach,
    })
  }

  async addStep(title: string, files: string[] = []): Promise<Plan | undefined> {
    const plan = await this.read()
    if (!plan) return undefined
    const clean = title.replace(/\s+/g, " ").trim()
    if (!clean) return plan
    if (plan.steps.some((step) => normalise(step.title) === normalise(clean))) return plan
    plan.steps.push({ id: planIdFor(clean), title: clean, files, status: "open" })
    return this.save(plan)
  }

  /** Appends a line of reasoning or context to the plan's notes. */
  async addNote(text: string): Promise<Plan | undefined> {
    const plan = await this.read()
    if (!plan) return undefined
    const clean = text.replace(/\s+/g, " ").trim()
    if (!clean) return plan
    plan.notes.push(clean)
    return this.save(plan)
  }

  /** Resolves a step by number, id, id prefix, or a fragment of its title. */
  async resolveStep(ref: string): Promise<PlanStep | undefined> {
    const plan = await this.read()
    if (!plan) return undefined
    const needle = ref.trim()
    if (!needle) return undefined
    const index = Number(needle.replace(/^#/, ""))
    if (Number.isInteger(index) && index >= 1 && index <= plan.steps.length) return plan.steps[index - 1]
    const byId =
      plan.steps.find((step) => step.id === needle) ?? plan.steps.find((step) => step.id.startsWith(needle))
    if (byId) return byId
    const lower = normalise(needle)
    return (
      plan.steps.find((step) => normalise(step.title) === lower) ??
      plan.steps.find((step) => normalise(step.title).includes(lower))
    )
  }

  async setStepStatus(ref: string, status: PlanStepStatus): Promise<PlanStep | undefined> {
    const plan = await this.read()
    if (!plan) return undefined
    const found = await this.resolveStep(ref)
    if (!found) return undefined
    const step = plan.steps.find((item) => item.id === found.id)
    if (!step) return undefined
    step.status = status
    await this.save(plan)
    return step
  }

  /** Marks every step done — a finished plan. */
  async completeAll(): Promise<number> {
    const plan = await this.read()
    if (!plan) return 0
    let changed = 0
    for (const step of plan.steps) {
      if (step.status === "done") continue
      step.status = "done"
      changed++
    }
    if (changed > 0) await this.save(plan)
    return changed
  }

  async removeStep(ref: string): Promise<boolean> {
    const plan = await this.read()
    if (!plan) return false
    const found = await this.resolveStep(ref)
    if (!found) return false
    plan.steps = plan.steps.filter((step) => step.id !== found.id)
    await this.save(plan)
    return true
  }

  async clear(): Promise<boolean> {
    try {
      await removeIfExists(planPath(this.projectPath))
      return true
    } catch {
      return false
    }
  }
}

const stores = new Map<string, PlanStore>()

/** One store per project, cached. */
export function planStoreFor(projectPath: string): PlanStore {
  const key = projectPath.toLowerCase()
  let store = stores.get(key)
  if (!store) {
    store = new PlanStore(projectPath)
    stores.set(key, store)
  }
  return store
}

export function clearPlanCache(): void {
  stores.clear()
}

/** The plan as prompt lines, or an empty array when there is none. */
export async function planPromptLines(projectPath: string, limit = PLAN_PROMPT_STEP_LIMIT): Promise<string[]> {
  const plan = await planStoreFor(projectPath).read()
  return plan ? formatPlan(plan, limit) : []
}

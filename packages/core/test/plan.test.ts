/**
 * Plans — `.imurun/PLAN.md`, the written shape of a piece of work.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PlanStore,
  formatPlan,
  parsePlan,
  planCounts,
  planIdFor,
  planPath,
  planStoreFor,
  renderPlan,
} from "../src/todo/plan"
import { planTool } from "../src/tool/plan"
import { buildSystemPrompt } from "../src/session/system-prompt"
import type { ToolContext } from "../src/tool/types"

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "imurun-plan-"))
})

function toolContext(): ToolContext {
  return {
    workingDir: project,
    sessionId: "ses_test",
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
  } as ToolContext
}

describe("the plan file", () => {
  test("round-trips the goal, the approach, the steps and their files", () => {
    const markdown = renderPlan({
      goal: "Add a /plan command",
      approach: "Reuse the todo plumbing",
      steps: [
        { id: "a", title: "write the store", files: ["src/plan.ts"], status: "done" },
        { id: "b", title: "wire the tool", files: [], status: "open" },
      ],
      notes: ["keep it offline"],
    })

    const back = parsePlan(markdown)!
    expect(back.goal).toBe("Add a /plan command")
    expect(back.approach).toBe("Reuse the todo plumbing")
    expect(back.steps.map((step) => [step.title, step.status])).toEqual([
      ["write the store", "done"],
      ["wire the tool", "open"],
    ])
    expect(back.steps[0]!.files).toEqual(["src/plan.ts"])
    expect(back.steps[1]!.files).toEqual([])
    expect(back.notes).toEqual(["keep it offline"])
  })

  test("reads a hand-written plan with bullet steps and an unknown section", () => {
    const parsed = parsePlan(
      [
        "# My plan",
        "",
        "## Goal",
        "ship it",
        "",
        "## Steps",
        "- [ ] first thing",
        "* [x] second thing",
        "",
        "## Random",
        "ignored prose",
      ].join("\n"),
    )!
    expect(parsed.goal).toBe("ship it")
    expect(parsed.steps.map((step) => [step.title, step.status])).toEqual([
      ["first thing", "open"],
      ["second thing", "done"],
    ])
  })

  test("no plan file at all means no plan", () => {
    expect(parsePlan("")).toBeUndefined()
    expect(parsePlan("# Notes\n\nnothing structured here")).toBeUndefined()
  })

  test("step ids follow the text, so nothing has to be stored", () => {
    expect(planIdFor("Write the store")).toBe(planIdFor("write  the store"))
  })

  test("lives at .imurun/PLAN.md inside the project", () => {
    expect(planPath("C:/work/app").replace(/\\/g, "/")).toBe("C:/work/app/.imurun/PLAN.md")
  })

  test("counts steps and renders them for the prompt", () => {
    const plan = { goal: "do the thing", steps: [{ id: "a", title: "one", files: [], status: "done" as const }], notes: [] }
    expect(planCounts(plan.steps)).toEqual({ done: 1, total: 1 })
    expect(formatPlan(plan, 5)[0]).toBe("goal: do the thing")
    expect(formatPlan(plan, 5)).toContain("1. [x] one")
  })
})

describe("PlanStore", () => {
  test("writes the plan to the project", async () => {
    const store = new PlanStore(project)
    const plan = await store.write({
      goal: "add a plan tool",
      approach: "one file, one tool",
      steps: ["write the store", { title: "wire it", files: ["src/tool/plan.ts"] }],
    })
    expect(plan.steps).toHaveLength(2)

    const onDisk = readFileSync(planPath(project), "utf8")
    expect(onDisk).toContain("## Goal")
    expect(onDisk).toContain("add a plan tool")
    expect(onDisk).toContain("2. [ ] wire it \u2014 `src/tool/plan.ts`")
    expect((await new PlanStore(project).read())!.steps[1]!.files).toEqual(["src/tool/plan.ts"])
  })

  test("refuses a plan with no goal", async () => {
    await expect(new PlanStore(project).write({ goal: "   " })).rejects.toThrow(/goal/)
  })

  test("keeps the notes when the steps are rewritten", async () => {
    const store = new PlanStore(project)
    await store.write({ goal: "first", steps: ["one"] })
    await store.addNote("decided to keep it offline")
    await store.write({ goal: "second", steps: ["one", "two"] })
    expect((await store.read())!.notes).toEqual(["decided to keep it offline"])
  })

  test("adds a step without duplicating one that is already there", async () => {
    const store = new PlanStore(project)
    await store.write({ goal: "g", steps: ["one"] })
    await store.addStep("one")
    await store.addStep("two", ["src/two.ts"])
    const plan = (await store.read())!
    expect(plan.steps.map((step) => step.title)).toEqual(["one", "two"])
    expect(plan.steps[1]!.files).toEqual(["src/two.ts"])
  })

  test("add-step on a project with no plan does nothing", async () => {
    expect(await new PlanStore(project).addStep("one")).toBeUndefined()
  })

  test("ticks a step by number, title or id", async () => {
    const store = new PlanStore(project)
    const plan = await store.write({ goal: "g", steps: ["one", "two", "three"] })

    expect((await store.setStepStatus("#2", "done"))!.title).toBe("two")
    expect((await store.setStepStatus("three", "done"))!.status).toBe("done")
    expect((await store.setStepStatus(plan.steps[0]!.id.slice(0, 6), "done"))!.title).toBe("one")
    expect(await store.setStepStatus("nope", "done")).toBeUndefined()

    expect(planCounts((await store.read())!.steps)).toEqual({ done: 3, total: 3 })
  })

  test("reopening a step and removing one", async () => {
    const store = new PlanStore(project)
    await store.write({ goal: "g", steps: [{ title: "one", status: "done" }, "two"] })

    expect((await store.setStepStatus("one", "open"))!.status).toBe("open")
    expect(await store.removeStep("two")).toBe(true)
    expect(await store.removeStep("two")).toBe(false)
    expect((await store.read())!.steps.map((step) => step.title)).toEqual(["one"])
  })

  test("completeAll finishes the plan; clear removes the file", async () => {
    const store = new PlanStore(project)
    await store.write({ goal: "g", steps: ["one", "two"] })
    expect(await store.completeAll()).toBe(2)
    expect(planCounts((await store.read())!.steps)).toEqual({ done: 2, total: 2 })
    expect(await store.clear()).toBe(true)
    expect(await store.read()).toBeUndefined()
  })

  test("keeps one store per project", () => {
    expect(planStoreFor(project)).toBe(planStoreFor(project.toUpperCase()))
  })
})

describe("plan tool", () => {
  test("writes a plan and reports its shape", async () => {
    const result = await planTool.execute(
      {
        action: "write",
        goal: "add dark mode",
        approach: "a theme toggle",
        steps: [{ title: "add the flag", files: ["src/theme.ts"] }, "wire the toggle"],
      },
      toolContext(),
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("0/2 done")
    expect(result.output).toContain("1. [ ] add the flag \u2014 src/theme.ts")
  })

  test("show reads it back", async () => {
    const ctx = toolContext()
    await planTool.execute({ action: "write", goal: "g", steps: ["one"] }, ctx)
    const shown = await planTool.execute({ action: "show" }, ctx)
    expect(shown.output).toContain("Goal: g")
    expect(shown.output).toContain("0/1 steps done")
  })

  test("show on a project with no plan says so", async () => {
    expect((await planTool.execute({ action: "show" }, toolContext())).output).toContain("no plan")
  })

  test("step, add-step and note act on the plan", async () => {
    const ctx = toolContext()
    await planTool.execute({ action: "write", goal: "g", steps: ["one"] }, ctx)

    expect((await planTool.execute({ action: "step", ref: "1", status: "done" }, ctx)).output).toContain("1/1 done")
    expect((await planTool.execute({ action: "add-step", title: "two" }, ctx)).ok).toBe(true)
    expect((await planTool.execute({ action: "note", text: "a decision" }, ctx)).ok).toBe(true)

    const plan = (await new PlanStore(project).read())!
    expect(plan.steps.map((step) => step.title)).toEqual(["one", "two"])
    expect(plan.notes).toEqual(["a decision"])
  })

  test("errors are clear", async () => {
    const ctx = toolContext()
    expect((await planTool.execute({ action: "step", ref: "1" }, ctx)).ok).toBe(false)
    expect((await planTool.execute({ action: "write", goal: "" }, ctx)).ok).toBe(false)
    expect((await planTool.execute({ action: "add-step", title: "x" }, ctx)).ok).toBe(false)
    expect((await planTool.execute({ action: "nonsense" }, ctx)).ok).toBe(false)
  })

  test("clear removes the file", async () => {
    const ctx = toolContext()
    await planTool.execute({ action: "write", goal: "g", steps: ["one"] }, ctx)
    expect((await planTool.execute({ action: "clear" }, ctx)).ok).toBe(true)
    expect((await new PlanStore(project).read())).toBeUndefined()
  })
})

describe("the prompt", () => {
  test("includes the plan when there is one", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      plan: ["goal: ship it", "1. [ ] write the tests"],
    })
    expect(prompt).toContain(".imurun/PLAN.md")
    expect(prompt).toContain("goal: ship it")
    expect(prompt).toContain("1. [ ] write the tests")
  })

  test("says nothing about a plan when there is none", () => {
    expect(buildSystemPrompt({ workingDir: "C:/work" })).not.toContain("The plan already written")
  })
})

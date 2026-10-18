/**
 * The task tool — how work is handed to a subagent.
 *
 * The brief is structured on purpose: a subagent cannot see the conversation,
 * so the parts have to arrive in a predictable place, and several independent
 * briefs should run at the same time rather than in a queue.
 */
import { describe, expect, test } from "bun:test"
import { createTaskTool, renderBrief, validateBrief } from "../src/tool/task"
import type { SubagentRequest, SubagentRunner, ToolContext } from "../src/tool/types"

function context(agentId?: string): ToolContext {
  return {
    workingDir: "C:/work",
    sessionId: "ses_parent",
    agentId,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
  } as ToolContext
}

/** A runner that records every request and answers with a canned report. */
function recordingRunner(reply = "found it"): {
  runner: SubagentRunner
  calls: SubagentRequest[]
  release: () => void
} {
  const calls: SubagentRequest[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const runner: SubagentRunner = {
    listAgents: () => [
      { id: "build", name: "Build", mode: "primary", tools: [], disabledTools: [], prompt: "" } as never,
      { id: "explore", name: "Explore", mode: "subagent", tools: [], disabledTools: [], prompt: "" } as never,
    ],
    async run(request) {
      calls.push(request)
      await gate
      return { text: `${reply} for ${request.description ?? "task"}`, agentId: request.agentId ?? "general", sessionId: "ses_child" }
    },
  }
  return { runner, calls, release }
}

describe("renderBrief", () => {
  test("lays the parts out in a predictable order", () => {
    const prompt = renderBrief({
      aim: "Find every place that reads the config",
      files: "src/config/*.ts",
      approach: "read only, do not change anything",
      rules: "cite line numbers",
      tools: "grep, read",
      expect: "a list of file:line",
    })
    expect(prompt).toContain("Aim: Find every place that reads the config")
    expect(prompt).toContain("Look at: src/config/*.ts")
    expect(prompt).toContain("Which part / how far: read only, do not change anything")
    expect(prompt).toContain("Rules: cite line numbers")
    expect(prompt).toContain("Tools you may use: grep, read")
    expect(prompt).toContain("Return: a list of file:line")
    expect(prompt.indexOf("Aim:")).toBeLessThan(prompt.indexOf("Return:"))
  })

  test("asks for a short report when the brief does not say what to return", () => {
    expect(renderBrief({ aim: "do the thing" })).toContain("Return: a short, concrete report")
  })

  test("carries a free-form prompt at the end", () => {
    const prompt = renderBrief({ aim: "check the logs" }, "The log file is at tmp/run.log.")
    expect(prompt.endsWith("The log file is at tmp/run.log.")).toBe(true)
  })
})

describe("validateBrief", () => {
  test("needs an aim", () => {
    expect(validateBrief({})).toMatch(/aim/)
    expect(validateBrief({ aim: "   " })).toMatch(/aim/)
  })

  test("an aim that is one word is not workable", () => {
    expect(validateBrief({ aim: "explore" })).toMatch(/too short/)
  })

  test("a real aim passes", () => {
    expect(validateBrief({ aim: "explore the parser for recursion bugs" })).toBeUndefined()
  })
})

describe("task tool", () => {
  test("runs the caller's own agent by default", async () => {
    const { runner, calls, release } = recordingRunner()
    const tool = createTaskTool(runner)
    const promise = tool.execute({ aim: "look at the parser and report" }, context("plan"))
    release()
    await promise
    expect(calls[0]!.agentId).toBe("plan")
  })

  test("an explicit agent wins", async () => {
    const { runner, calls, release } = recordingRunner()
    const tool = createTaskTool(runner)
    const promise = tool.execute({ aim: "look at the parser and report", agent: "explore" }, context("build"))
    release()
    await promise
    expect(calls[0]!.agentId).toBe("explore")
  })

  test("no agent anywhere leaves it to the runner", async () => {
    const { runner, calls, release } = recordingRunner()
    const tool = createTaskTool(runner)
    const promise = tool.execute({ aim: "look at the parser and report" }, context())
    release()
    await promise
    expect(calls[0]!.agentId).toBeUndefined()
  })

  test("the brief reaches the child as a self-contained prompt", async () => {
    const { runner, calls, release } = recordingRunner()
    const tool = createTaskTool(runner)
    const promise = tool.execute({ aim: "count the callers of parse()", files: "src/parser.ts" }, context("build"))
    release()
    await promise
    expect(calls[0]!.prompt).toContain("Aim: count the callers of parse()")
    expect(calls[0]!.prompt).toContain("Look at: src/parser.ts")
  })

  test("a missing aim is refused, not run", async () => {
    const { runner, calls } = recordingRunner()
    const tool = createTaskTool(runner)
    const result = await tool.execute({}, context("build"))
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/aim/)
    expect(calls).toHaveLength(0)
  })

  test("a full prompt is used verbatim", async () => {
    const { runner, calls, release } = recordingRunner()
    const tool = createTaskTool(runner)
    const promise = tool.execute({ prompt: "Read tmp/run.log and summarise the errors." }, context("build"))
    release()
    await promise
    expect(calls[0]!.prompt).toBe("Read tmp/run.log and summarise the errors.")
  })

  test("a batch runs its briefs at the same time", async () => {
    const { runner, calls, release } = recordingRunner("done")
    const tool = createTaskTool(runner)
    const promise = tool.execute(
      {
        action: "batch",
        tasks: [
          { aim: "compare library A against the current one" },
          { aim: "compare library B against the current one" },
          { aim: "compare library C against the current one" },
        ],
      },
      context("plan"),
    )

    // All three are in flight before any of them is allowed to finish: a queue
    // would stall at one.
    await Bun.sleep(5)
    expect(calls).toHaveLength(3)
    release()
    const result = await promise

    expect(result.ok).toBe(true)
    expect(result.output).toContain("3 subagents finished in parallel")
    expect(result.output).toContain("## 1. compare library A")
    expect(result.output).toContain("## 3. compare library C")
    expect(calls.every((call) => call.agentId === "plan")).toBe(true)
    expect(new Set(calls.map((call) => call.description))).toEqual(
      new Set(["task 1/3", "task 2/3", "task 3/3"]),
    )
  })

  test("a batch with an unusable brief is refused before anything runs", async () => {
    const { runner, calls } = recordingRunner()
    const tool = createTaskTool(runner)
    const result = await tool.execute({ action: "batch", tasks: [{ aim: "one" }, { aim: "" }] }, context("build"))
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("one brief in action=batch is just a task", async () => {
    const { runner, calls, release } = recordingRunner()
    const tool = createTaskTool(runner)
    const promise = tool.execute({ action: "batch", tasks: [{ aim: "read src/index.ts and report" }] }, context("build"))
    release()
    const result = await promise
    expect(calls).toHaveLength(1)
    expect(result.output).toContain("[subagent")
  })
})

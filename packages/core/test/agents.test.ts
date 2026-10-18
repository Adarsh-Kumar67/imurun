import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolAllowed } from "@imurun/schema"
import {
  BUILTIN_AGENTS,
  ToolRegistry,
  defaultAgent,
  getAgent,
  loadAgents,
  primaryAgents,
  renderRole,
  restrictToolRegistry,
  subagents,
} from "../src"

describe("agent definitions", () => {
  test("ships the expected built-ins", () => {
    const ids = BUILTIN_AGENTS.map((a) => a.id)
    expect(ids).toContain("build")
    expect(ids).toContain("plan")
    expect(ids).toContain("general")
    expect(ids).toContain("explore")
  })

  test("every built-in has a full, distinct role preamble", () => {
    const prompts = new Set<string>()
    for (const agent of BUILTIN_AGENTS) {
      const prompt = agent.prompt.trim()
      expect(prompt.length).toBeGreaterThan(200)
      expect(prompt).toContain("What you do:")
      expect(prompt).toContain("What you must never do")
      expect(prompt).toContain("What you return:")
      prompts.add(prompt)
    }
    // no two roles are the same text
    expect(prompts.size).toBe(BUILTIN_AGENTS.length)
  })

  test("renderRole keeps the four parts in order", () => {
    const rendered = renderRole({
      identity: "You are Test.",
      duties: ["do this"],
      constraints: ["never that"],
      output: "a report",
    })
    expect(rendered.indexOf("You are Test.")).toBeLessThan(rendered.indexOf("What you do:"))
    expect(rendered.indexOf("What you do:")).toBeLessThan(rendered.indexOf("What you must never do"))
    expect(rendered.indexOf("What you must never do")).toBeLessThan(rendered.indexOf("What you return:"))
    expect(rendered).toContain("- do this")
    expect(rendered).toContain("- never that")
  })

  test("a role with no constraints still renders", () => {
    const rendered = renderRole({ identity: "You are Test.", duties: [], constraints: [], output: "" })
    expect(rendered).toBe("You are Test.")
  })

  test("read-only roles say so in their own words", () => {
    const plan = getAgent(BUILTIN_AGENTS, "plan")!.prompt
    const explore = getAgent(BUILTIN_AGENTS, "explore")!.prompt
    expect(plan).toContain("read-only")
    expect(plan).toContain("Never write, edit, or delete a file")
    expect(explore).toContain("Never modify anything")
  })

  test("isToolAllowed honors allow-lists and deny-lists", () => {
    const build = getAgent(BUILTIN_AGENTS, "build")!
    expect(isToolAllowed(build, "shell")).toBe(true)
    expect(isToolAllowed(build, "anything-new")).toBe(true)

    const plan = getAgent(BUILTIN_AGENTS, "plan")!
    expect(isToolAllowed(plan, "read")).toBe(true)
    expect(isToolAllowed(plan, "write")).toBe(false)
    expect(isToolAllowed(plan, "shell")).toBe(false)

    // read-only agents still get to look things up: code search and the web
    const explore = getAgent(BUILTIN_AGENTS, "explore")!
    expect(isToolAllowed(plan, "code_search")).toBe(true)
    expect(isToolAllowed(plan, "web_search")).toBe(true)
    expect(isToolAllowed(plan, "web_fetch")).toBe(true)
    expect(isToolAllowed(explore, "web_search")).toBe(true)
    expect(isToolAllowed(explore, "code_search")).toBe(true)
    // the old name matched no registered tool, so it granted nothing
    expect(ToolRegistry.default().get("rag_search")).toBeUndefined()

    const custom = { ...build, tools: ["read", "grep"], disabledTools: [] }
    expect(isToolAllowed(custom, "read")).toBe(true)
    expect(isToolAllowed(custom, "glob")).toBe(false)
  })

  test("getAgent is case-insensitive and also matches by name", () => {
    expect(getAgent(BUILTIN_AGENTS, "BUILD")?.id).toBe("build")
    expect(getAgent(BUILTIN_AGENTS, "Plan")?.id).toBe("plan")
    expect(getAgent(BUILTIN_AGENTS, "nope")).toBeUndefined()
  })

  test("defaultAgent prefers build", () => {
    expect(defaultAgent(BUILTIN_AGENTS).id).toBe("build")
    expect(primaryAgents(BUILTIN_AGENTS).every((a) => a.mode === "primary")).toBe(true)
    expect(subagents(BUILTIN_AGENTS).some((a) => a.id === "explore")).toBe(true)
  })

  test("restrictToolRegistry keeps only allowed tools", () => {
    const base = ToolRegistry.default()
    const plan = getAgent(BUILTIN_AGENTS, "plan")!
    const names = restrictToolRegistry(base, plan)
      .list()
      .map((t) => t.name)
    expect(names).toContain("read")
    expect(names).toContain("glob")
    expect(names).toContain("grep")
    expect(names).not.toContain("write")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("shell")
  })
})

describe("loading user agents", () => {
  test("reads markdown frontmatter from the project directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imurun-agent-"))
    const agentsDir = join(dir, ".imurun", "agents")
    await mkdir(agentsDir, { recursive: true })
    await writeFile(
      join(agentsDir, "docs.md"),
      ["---", "name: Docs Writer", "description: Writes docs", "tools: read, write, grep", "---", "You write tidy docs."].join(
        "\n",
      ),
      "utf8",
    )
    await writeFile(
      join(agentsDir, "reviewer.json"),
      JSON.stringify({ id: "reviewer", name: "Reviewer", description: "Reviews code", tools: ["read", "grep"] }),
      "utf8",
    )

    const agents = await loadAgents({ workingDir: dir })
    const docs = getAgent(agents, "docs")
    expect(docs?.name).toBe("Docs Writer")
    expect(docs?.prompt).toContain("tidy docs")
    expect(docs?.tools).toEqual(["read", "write", "grep"])
    expect(docs?.source).toBe("project")
    expect(docs?.builtin).toBe(false)

    const reviewer = getAgent(agents, "reviewer")
    expect(reviewer?.description).toBe("Reviews code")
    expect(reviewer?.tools).toEqual(["read", "grep"])

    // built-ins are still present alongside user agents
    expect(getAgent(agents, "build")).toBeDefined()
  })
})

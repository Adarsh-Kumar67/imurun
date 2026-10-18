import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../src/session/system-prompt"

describe("buildSystemPrompt", () => {
  test("names the agent and sets the small-context rules", () => {
    const prompt = buildSystemPrompt({ workingDir: "C:/work" })
    expect(prompt).toContain("IMURUN")
    expect(prompt).toContain("local-first coding agent")
    // the discipline that keeps a small model usable
    expect(prompt).toMatch(/mode "create"/)
    expect(prompt).toMatch(/mode "append"/)
    expect(prompt).toContain("progress tool")
  })

  test("tells the model to search first and to verify before claiming success", () => {
    const prompt = buildSystemPrompt({ workingDir: "C:/work" })
    // search-first: never answer unknown/current things from memory
    expect(prompt).toContain("web_search")
    expect(prompt).toContain("never guess")
    // verify the change landed, and retry differently if it did not
    expect(prompt).toContain("Cross-check that every change actually landed")
    expect(prompt).toContain("try a different way")
    // keep the user informed of the things that matter
    expect(prompt).toContain("Narrate the steps that matter")
    // and it may open apps/links and run background commands
    expect(prompt).toContain("xdg-open")
    expect(prompt).toContain("background")
  })

  test("includes the environment, and today's date", () => {
    const prompt = buildSystemPrompt({ workingDir: "C:/work/project", model: "qwen2.5-coder-7b", agent: "build" })
    expect(prompt).toContain("Project directory: C:/work/project")
    expect(prompt).toContain("Model: qwen2.5-coder-7b")
    expect(prompt).toContain("Agent: build")
    expect(prompt).toContain(new Date().toISOString().slice(0, 10))
  })

  test("lists the tools and what the agent can do", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      tools: ["read", "write", "shell"],
      capabilities: ["read, create and edit files, and run shell commands"],
    })
    expect(prompt).toContain("Available tools:")
    expect(prompt).toContain("read, write, shell")
    expect(prompt).toContain("What you can do here (never claim more than this):")
  })

  test("names where a requested skill or agent should be written", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      skillsDir: "C:/Users/me/.imurun/skills",
      agentsDir: "C:/Users/me/.imurun/agents",
    })
    expect(prompt).toContain("Skills directory: C:/Users/me/.imurun/skills")
    expect(prompt).toContain("Agents directory: C:/Users/me/.imurun/agents")
  })

  test("omits every optional section when there is nothing to say", () => {
    const prompt = buildSystemPrompt({ workingDir: "C:/work" })
    expect(prompt).not.toContain("Recalled from earlier sessions")
    expect(prompt).not.toContain("Open todos carried over")
    expect(prompt).not.toContain("Work in progress recorded")
    expect(prompt).not.toContain("Earlier in this session")
    expect(prompt).not.toContain("Notes the user asked you to remember")
  })

  test("includes remembered things only when present", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      memories: ["the API base is /v2"],
      notes: ["always use tabs"],
      userStyle: "prefers small functions",
    })
    expect(prompt).toContain("Recalled from earlier sessions")
    expect(prompt).toContain("the API base is /v2")
    expect(prompt).toContain("Notes the user asked you to remember")
    expect(prompt).toContain("always use tabs")
    expect(prompt).toContain("prefers small functions")
  })

  test("a compacted summary replaces the carried-over todos", () => {
    const withTodos = buildSystemPrompt({ workingDir: "C:/work", todos: ["finish the parser"] })
    expect(withTodos).toContain("The current plan")
    expect(withTodos).toContain("finish the parser")

    const compacted = buildSystemPrompt({
      workingDir: "C:/work",
      todos: [],
      compactedSummary: "We finished the parser and started the lexer.",
    })
    expect(compacted).toContain("Earlier in this session")
    expect(compacted).toContain("We finished the parser")
    expect(compacted).not.toContain("The current plan")
  })

  test("work in progress is labelled as resumable state", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      inProgress: ["file:src/app.ts — 120 bytes, 6 lines"],
    })
    expect(prompt).toContain("Work in progress recorded for this project")
    expect(prompt).toContain("file:src/app.ts")
    expect(prompt).toContain("progress tool")
  })

  test("project instructions come last, so they win on conflict", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      capabilities: ["edit files"],
      instructions: ["never touch the vendor directory"],
    })
    const instructionsAt = prompt.indexOf("Project instructions")
    const capabilitiesAt = prompt.indexOf("What you can do here")
    expect(instructionsAt).toBeGreaterThan(capabilitiesAt)
    expect(prompt).toContain("never touch the vendor directory")
  })

  test("extra sections are appended as-is", () => {
    const prompt = buildSystemPrompt({
      workingDir: "C:/work",
      extraSections: ["Skill: build-website\n- plan the pages before writing them"],
    })
    expect(prompt).toContain("Skill: build-website")
    expect(prompt).toContain("plan the pages before writing them")
  })

  test("blank extra sections are ignored", () => {
    const bare = buildSystemPrompt({ workingDir: "C:/work" })
    const padded = buildSystemPrompt({ workingDir: "C:/work", extraSections: ["   ", ""] })
    expect(padded).toBe(bare)
  })
})

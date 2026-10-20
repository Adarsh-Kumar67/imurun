/**
 * Capability-refusal recovery — the guard that stops a small model from
 * answering a shell request with "I cannot execute shell commands".
 */
import { describe, expect, test } from "bun:test"
import { capabilityNudge, detectCapabilityRefusal } from "../src/agent/capability"

describe("detectCapabilityRefusal", () => {
  test("catches the classic chat-assistant refusals", () => {
    expect(detectCapabilityRefusal("I'm sorry, but I cannot execute shell commands or interact with external programs.")).toBe(true)
    expect(detectCapabilityRefusal("I do not have access to files on your machine.")).toBe(true)
    expect(detectCapabilityRefusal("I am unable to run commands in this environment.")).toBe(true)
    expect(detectCapabilityRefusal("As an AI language model, I cannot access your filesystem.")).toBe(true)
    expect(detectCapabilityRefusal("I don't have a terminal available to me.")).toBe(true)
    expect(detectCapabilityRefusal("I cannot directly access your system.")).toBe(true)
  })

  test("does not fire on ordinary answers, declines, or failures", () => {
    // A tool genuinely failed and the model says so — that is honesty, not a
    // claim that the ability is missing.
    expect(detectCapabilityRefusal("The shell command failed: npm not found. Let me check the PATH.")).toBe(false)
    expect(detectCapabilityRefusal("I can't find that symbol in the codebase — it may have been renamed.")).toBe(false)
    expect(detectCapabilityRefusal("I would not recommend deleting node_modules. Here is a safer cleanup:")).toBe(false)
    expect(detectCapabilityRefusal("Fixed. The guard now runs before the session lookup in src/auth.ts.")).toBe(false)
    expect(detectCapabilityRefusal("")).toBe(false)
  })

  test("ignores very long text: a real answer is not a refusal", () => {
    const long = "I cannot execute shell commands. " + "padding ".repeat(600)
    expect(detectCapabilityRefusal(long)).toBe(false)
  })
})

describe("capabilityNudge", () => {
  test("names the real tools and tells the model to act", () => {
    const nudge = capabilityNudge(["read", "shell", "edit", "write", "web_search"])
    expect(nudge).toContain("shell")
    expect(nudge).toContain("web_search")
    expect(nudge).toContain("Never claim you cannot")
    // The model is told to do the task, not to apologise again.
    expect(nudge).toContain("Do the task now")
  })

  test("survives an empty tool list without producing a dangling list", () => {
    const nudge = capabilityNudge([])
    expect(nudge).toContain("These tools are real")
    expect(nudge.trim().length).toBeGreaterThan(80)
  })
})

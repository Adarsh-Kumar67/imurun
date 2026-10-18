/**
 * The shipped slash command table. These assertions guard the user-facing
 * surface: which commands exist, and that the older names still resolve.
 */
import { describe, expect, test } from "bun:test"
import { createCommandRegistry } from "../src"

describe("command registry", () => {
  const registry = createCommandRegistry()

  test("every command has a summary", () => {
    for (const command of registry.unique()) {
      expect(command.summary.length).toBeGreaterThan(0)
    }
  })

  test("/session owns the session entry points", () => {
    const session = registry.find("session")
    expect(session?.name).toBe("session")
    // the historic spellings are aliases of the same command
    expect(registry.find("sessions")?.name).toBe("session")
    expect(registry.find("resume")?.name).toBe("session")
  })

  test("core commands are present", () => {
    const names = registry.unique().map((command) => command.name)
    for (const expected of ["help", "session", "model", "agent", "permission", "skills", "exit"]) {
      expect(names).toContain(expected)
    }
  })

  test("aliases appear in completion but only once in the help list", () => {
    expect(registry.complete("res")).toContain("resume")
    expect(registry.unique().filter((command) => command.name === "session")).toHaveLength(1)
  })
})

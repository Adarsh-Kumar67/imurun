import { describe, expect, test } from "bun:test"
import { THEME_NAMES, setTheme, theme } from "../src/theme"

describe("setTheme", () => {
  test("the names the docs list are all real", () => {
    for (const name of THEME_NAMES) {
      expect(setTheme(name)).toBe(name)
    }
  })

  test("short forms are accepted", () => {
    expect(setTheme("dark")).toBe("imurun-dark")
    expect(setTheme("light")).toBe("imurun-light")
    expect(setTheme("plain")).toBe("none")
  })

  test("an unknown name falls back to the default instead of half-applying", () => {
    setTheme("none")
    expect(setTheme("chartreuse")).toBe("imurun-dark")
  })

  test("call sites see the new palette without being told about it", () => {
    setTheme("imurun-dark")
    const darkAccent = theme.accent
    setTheme("none")
    expect(theme.accent).not.toBe(darkAccent)
    setTheme("imurun-dark")
    expect(theme.accent).toBe(darkAccent)
  })

  test("no color really means no escapes", () => {
    setTheme("none")
    expect(theme.accent("plain text")).toBe("plain text")
    expect(theme.bold("plain text")).toBe("plain text")
    expect(theme.error("plain text")).toBe("plain text")
  })
})

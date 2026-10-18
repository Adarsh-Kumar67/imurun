import { describe, expect, test } from "bun:test"
import { SlashRegistry, parseSlash, tokenize } from "../src"

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("model local/qwen")).toEqual(["model", "local/qwen"])
  })

  test("honors quotes for paths with spaces", () => {
    expect(tokenize('cwd "C:/my projects/app"')).toEqual(["cwd", "C:/my projects/app"])
    expect(tokenize("install 'some model' Q4_K_M")).toEqual(["install", "some model", "Q4_K_M"])
  })
})

describe("parseSlash", () => {
  test("returns undefined for normal input", () => {
    expect(parseSlash("fix the bug")).toBeUndefined()
  })

  test("parses a bare slash as empty", () => {
    expect(parseSlash("/")).toEqual({ name: "", args: [] })
  })

  test("lower-cases the command and keeps args", () => {
    expect(parseSlash("/Model local/x")).toEqual({ name: "model", args: ["local/x"] })
    expect(parseSlash("  /install qwen  ")).toEqual({ name: "install", args: ["qwen"] })
  })
})

describe("SlashRegistry", () => {
  function registry(): SlashRegistry {
    return new SlashRegistry()
      .register({ name: "help", summary: "help" })
      .register({ name: "exit", aliases: ["quit", "q"], summary: "exit" })
      .register({ name: "model", summary: "model", run() {} })
  }

  test("finds by name and alias", () => {
    const r = registry()
    expect(r.find("help")?.name).toBe("help")
    expect(r.find("QUIT")?.name).toBe("exit")
    expect(r.find("nope")).toBeUndefined()
  })

  test("unique collapses aliases", () => {
    const names = registry()
      .unique()
      .map((c) => c.name)
    expect(names).toEqual(["help", "exit", "model"])
  })

  test("complete matches prefixes", () => {
    expect(registry().complete("m")).toEqual(["model"])
    expect(registry().complete("ex")).toEqual(["exit"])
    expect(registry().complete("zzz")).toEqual([])
  })
})

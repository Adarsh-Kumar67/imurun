import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LanguageModel } from "ai"
import type { Message } from "@imurun/schema"
import {
  ResponseEngine,
  emptyProfile,
  extractJsonObject,
  loadResponseProfile,
  mergeProfile,
  observeTurn,
  redactSecrets,
  refineResponseProfile,
  resetResponseProfile,
  responseDirective,
  saveResponseProfile,
  shouldRefine,
  responseProfilePath,
} from "../src"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-response-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
})

/**
 * Credential-shaped strings, built at runtime.
 *
 * Writing them literally would make a secret scan flag this test file forever;
 * the redactor only cares about the shape, not about where the characters came
 * from.
 */
const FAKE_NPM = "npm_" + "a1".repeat(12)
const FAKE_SK = "sk-" + "b2".repeat(12)
const FAKE_GHP = "ghp_" + "c3".repeat(9)

describe("redaction", () => {
  test("drops the value of a named key and keeps the name", () => {
    const text = redactSecrets(`always export NPM_TOKEN=${FAKE_NPM} before publishing`)
    expect(text).toContain("NPM_TOKEN=<redacted>")
    expect(text).not.toContain(FAKE_NPM)
  })

  test("drops well-known token shapes wherever they appear", () => {
    const text = redactSecrets(`use ${FAKE_SK} and ${FAKE_GHP} when calling the API`)
    expect(text).not.toContain(FAKE_SK)
    expect(text).not.toContain(FAKE_GHP)
  })
})

describe("learning from a turn", () => {
  test("a correction after an answer moves brevity up and depth down", () => {
    const before = emptyProfile()
    const { profile, corrected } = observeTurn(before, { userText: "shorter, please", afterAssistant: true })
    expect(corrected).toBe(true)
    expect(profile.brevity).toBeGreaterThan(before.brevity)
    expect(profile.depth).toBeLessThan(before.depth)
    expect(profile.evidence.corrections).toBe(1)
  })

  test("the same words before any answer are a request, not a correction", () => {
    const before = emptyProfile()
    const { profile, corrected } = observeTurn(before, { userText: "shorter, please", afterAssistant: false })
    expect(corrected).toBe(false)
    expect(profile.evidence.corrections).toBe(0)
    // The length prior may drift a little; a correction would move it far more.
    expect(profile.brevity - before.brevity).toBeLessThan(0.05)
  })

  test("a long message mentioned in passing is not a correction", () => {
    const before = emptyProfile()
    const long = "Here is the whole design. ".repeat(20) + "Also, explain why the cache exists."
    const { corrected } = observeTurn(before, { userText: long, afterAssistant: true })
    expect(corrected).toBe(false)
  })

  test("numbering, code-first and verification are learned separately", () => {
    const first = observeTurn(emptyProfile(), { userText: "step by step, numbered steps", afterAssistant: true })
    expect(first.profile.stepwise).toBeGreaterThan(0.5)
    const second = observeTurn(first.profile, { userText: "just the command", afterAssistant: true })
    expect(second.profile.codeFirst).toBeGreaterThan(0.5)
    const third = observeTurn(second.profile, { userText: "check it first before you answer", afterAssistant: true })
    expect(third.profile.verification).toBeGreaterThan(0.5)
  })

  test("a standing instruction is kept, redacted, and deduped", () => {
    const turn = { userText: "always run the tests before you say it works", afterAssistant: true }
    const once = observeTurn(emptyProfile(), turn)
    expect(once.profile.instructions).toHaveLength(1)
    const twice = observeTurn(once.profile, turn)
    expect(twice.profile.instructions).toHaveLength(1)
  })

  test("an instruction containing a key keeps the name and never the value", () => {
    const { profile } = observeTurn(emptyProfile(), {
      userText: `always set GITHUB_PAT=${FAKE_GHP} before pushing`,
      afterAssistant: true,
    })
    expect(profile.instructions[0]).toContain("GITHUB_PAT=<redacted>")
    expect(profile.instructions[0]).not.toContain(FAKE_GHP)
  })

  test("empty input changes nothing", () => {
    const before = emptyProfile()
    const { profile } = observeTurn(before, { userText: "   ", afterAssistant: true })
    expect(profile).toEqual(before)
  })
})

describe("the profile", () => {
  test("merging blends rather than assigns, and clamps", () => {
    const before = emptyProfile()
    const merged = mergeProfile(before, { brevity: 9, depth: -3 }, { fromModel: true })
    expect(merged.brevity).toBeGreaterThan(before.brevity)
    expect(merged.brevity).toBeLessThan(1)
    expect(merged.depth).toBeGreaterThanOrEqual(0)
    expect(merged.evidence.refinements).toBe(1)
  })

  test("instructions are capped, newest kept", () => {
    let profile = emptyProfile()
    for (let index = 0; index < 10; index++) {
      profile = mergeProfile(profile, { instructions: [`rule ${index}`] })
    }
    expect(profile.instructions).toHaveLength(6)
    expect(profile.instructions.at(-1)).toBe("rule 9")
  })

  test("a neutral profile says nothing", () => {
    expect(responseDirective(emptyProfile())).toBeUndefined()
  })

  test("the directive states the strong preferences and the instructions", () => {
    const profile = mergeProfile(
      emptyProfile(),
      {
        brevity: 0.9,
        codeFirst: 0.9,
        verification: 0.9,
        instructions: ["always run the tests"],
      },
      { alpha: 1 },
    )
    const directive = responseDirective(profile)!
    expect(directive).toContain("Be brief")
    expect(directive).toContain("command, the diff, or the code first")
    expect(directive).toContain("Check what you claim")
    expect(directive).toContain("always run the tests")
  })

  test("refinement is due only after enough evidence", () => {
    const fresh = emptyProfile()
    expect(shouldRefine(fresh, 10)).toBe(false)
    const used = { ...fresh, evidence: { ...fresh.evidence, turns: 6 } }
    expect(shouldRefine(used, 6)).toBe(true)
    expect(shouldRefine(used, 1)).toBe(false)
  })
})

describe("the background reader", () => {
  test("finds JSON inside prose and fences", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"brevity":0.8}\n```')?.brevity).toBe(0.8)
    expect(extractJsonObject("no object here")).toBeUndefined()
    expect(extractJsonObject("{not json}")).toBeUndefined()
  })

  test("a model that cannot be reached returns nothing and does not throw", async () => {
    const result = await refineResponseProfile({
      model: {} as LanguageModel,
      profile: emptyProfile(),
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    })
    expect(result).toBeUndefined()
  })

  test("too short a conversation is not worth a model call", async () => {
    const result = await refineResponseProfile({
      model: {} as LanguageModel,
      profile: emptyProfile(),
      turns: [{ role: "user", text: "hi" }],
    })
    expect(result).toBeUndefined()
  })
})

describe("the profile store", () => {
  test("a fresh machine has a neutral profile", async () => {
    const profile = await loadResponseProfile()
    expect(profile.turns).toBe(0)
    expect(profile.instructions).toEqual([])
  })

  test("saving and loading round-trips", async () => {
    const profile = mergeProfile(emptyProfile(), { brevity: 0.8, instructions: ["be direct"] })
    await saveResponseProfile(profile)
    const loaded = await loadResponseProfile()
    expect(loaded.brevity).toBeCloseTo(profile.brevity, 5)
    expect(loaded.instructions).toEqual(["be direct"])
  })

  test("a corrupt file is repaired into a neutral profile", async () => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(home, "models"), { recursive: true })
    await writeFile(responseProfilePath(), "{ this is not json", "utf8")
    const profile = await loadResponseProfile()
    expect(profile.turns).toBe(0)
    expect(profile.brevity).toBe(emptyProfile().brevity)
  })

  test("reset forgets everything", async () => {
    await saveResponseProfile(mergeProfile(emptyProfile(), { brevity: 0.9, instructions: ["x"] }))
    const fresh = await resetResponseProfile()
    expect(fresh.instructions).toEqual([])
    expect((await loadResponseProfile()).brevity).toBe(emptyProfile().brevity)
  })
})

describe("ResponseEngine", () => {
  test("observing a turn updates the directive and notifies once", () => {
    let changes = 0
    const engine = new ResponseEngine({
      profile: emptyProfile(),
      model: {} as LanguageModel,
      onChange: () => {
        changes++
      },
    })
    expect(engine.directive).toBeUndefined()
    for (let index = 0; index < 4; index++) {
      engine.observe({ userText: "shorter", afterAssistant: true })
    }
    expect(changes).toBe(4)
    expect(engine.current.brevity).toBeGreaterThan(0.5)
    expect(engine.directive).toContain("Be brief")
  })

  test("replacing the profile resets the refinement clock", () => {
    const engine = new ResponseEngine({ profile: emptyProfile(), model: {} as LanguageModel })
    engine.replace({ ...emptyProfile(), brevity: 0.9, evidence: { turns: 10, corrections: 0, explicit: 0, refinements: 0 } })
    expect(engine.current.brevity).toBe(0.9)
    expect(engine.due).toBe(false)
  })
})

describe("the digest keeps what compaction must not lose", () => {
  function message(role: Message["role"], content: string): Message {
    return {
      id: `msg_${Math.random().toString(36).slice(2, 10)}`,
      sessionId: "ses_test",
      role,
      content,
      createdAt: Date.now(),
    } as Message
  }

  test("facts, key names and topics survive the fold", async () => {
    const { buildDigest, digestToPrompt } = await import("../src/memory/summarize")
    const digest = buildDigest({
      sessionId: "ses_test",
      title: "Release",
      workingDir: "C:/work",
      messages: [
        message("user", "NOTE: the API listens on port 8080"),
        message("assistant", `Set NPM_TOKEN=${FAKE_NPM} before publishing.\n## Release steps`),
      ],
    })
    expect(digest.facts?.join(" ")).toContain("port 8080")
    expect(digest.keys).toContain("NPM_TOKEN")
    expect(digest.topics?.join(" ")).toContain("Release steps")
    const prompt = digestToPrompt(digest)
    expect(prompt).toContain("Facts established")
    expect(prompt).toContain("NPM_TOKEN")
    // The value must never be written down, even inside a fact.
    expect(prompt).not.toContain(FAKE_NPM)
    expect(JSON.stringify(digest)).not.toContain(FAKE_NPM)
  })

  test("a key name is only matched when it is a key", async () => {
    const { extractKeyNames } = await import("../src/memory/summarize")
    expect(extractKeyNames("the NPM_TOKEN and GITHUB_PAT are set")).toEqual(["NPM_TOKEN", "GITHUB_PAT"])
    expect(extractKeyNames("a token of appreciation")).toEqual([])
  })
})

/**
 * The research engine, tested without a network.
 *
 * The backend is faked, the pages are faked, and the clock is real. What is
 * being proved here is the behaviour the model cannot be trusted to provide:
 * the search happens without the model asking for it, the evidence is
 * numbered and traceable, and a claim the sources do not support is caught
 * rather than shipped.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LinearModel,
  ResearchEngine,
  ResearchNeedEngine,
  CROSS_CHECK_CONFIDENCE,
  answerConfidence,
  claimCheckPrompt,
  claimQueries,
  extractClaims,
  needsCrossCheck,
  unsupportedClaims,
  type ResearchBundle,
  type ResearchSource,
} from "../src"
import type { WebConfig } from "@imurun/schema"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-research-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
})

const CONFIG: WebConfig = {
  searchBackend: "duckduckgo",
  searxngURL: "",
  braveApiKey: "",
  cacheFetches: false,
  research: "auto",
  researchMaxQueries: 2,
  researchMaxPages: 3,
  researchVerify: true,
  researchModel: "",
} as unknown as WebConfig

/** A page of text, as the fetcher would return it. */
function page(text: string, title = "A page"): Response {
  return new Response(`<!doctype html><html><head><title>${title}</title></head><body><p>${text}</p></body></html>`, {
    headers: { "content-type": "text/html" },
  })
}

/** A fake backend: search returns these results, fetch returns these pages. */
function fakeFetch(
  results: Array<{ title: string; url: string; snippet?: string }>,
  pages: Record<string, string> = {},
): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as { url?: string })?.url)
    if (url.includes("duckduckgo.com") || url.includes("html.duckduckgo.com")) {
      const items = results
        .map(
          (result) =>
            `<a class="result__a" href="${result.url}">${result.title}</a>` +
            `<a class="result__snippet">${result.snippet ?? ""}</a>`,
        )
        .join("")
      return new Response(
        `<!doctype html><html><body><div class="results">${items}</div></body></html>`,
        { headers: { "content-type": "text/html" } },
      )
    }
    for (const [match, body] of Object.entries(pages)) {
      if (url.startsWith(match)) return page(body, match)
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
}

describe("the need engine", () => {
  test("a question about the world is flagged; a request about the code is not", () => {
    const engine = new ResearchNeedEngine()
    const current = engine.assess("what is the latest version of node.js right now?")
    const local = engine.assess("rename the function in src/auth.ts and fix the import")
    expect(current.needed).toBe(true)
    expect(local.needed).toBe(false)
  })

  test("the reason names the features, not a keyword list", () => {
    const engine = new ResearchNeedEngine()
    const assessment = engine.assess("what is the latest version of node.js right now?")
    expect(assessment.reasons.length).toBeGreaterThan(0)
    expect(assessment.reasons.join(" ")).toContain("probability")
  })

  test("learning moves the decision, and the state file survives a restart", async () => {
    const path = join(home, "research-need.json")
    const engine = new ResearchNeedEngine({ path })
    const message = "what is the current price of the thing"

    // A few negative labels teach it that this phrasing is not a question
    // about the world.
    for (let index = 0; index < 6; index++) engine.learn(message, false, 0.8)
    expect(engine.assess(message).needed).toBe(false)

    await engine.save()
    const reloaded = await ResearchNeedEngine.load(path)
    expect(reloaded.assess(message).needed).toBe(false)
  })

  test("a corrupt state file falls back to the priors instead of crashing", async () => {
    const path = join(home, "research-need.json")
    await Bun.write(path, "{ this is not json")
    const engine = await ResearchNeedEngine.load(path)
    expect(engine.assess("what is the latest version of node.js?").needed).toBe(true)
  })

  test("a state file from another version is ignored", async () => {
    const path = join(home, "research-need.json")
    await Bun.write(path, JSON.stringify({ version: 999, trained: 5, weights: { bias: 50 } }))
    const engine = await ResearchNeedEngine.load(path)
    expect(engine.assess("what is the latest version of node.js?").needed).toBe(true)
  })
})

describe("gathering evidence", () => {
  test("a dead backend degrades to no sources, not to a crash", async () => {
    const failing = (async () => {
      throw new Error("network is down")
    }) as unknown as typeof fetch
    const engine = new ResearchEngine(new ResearchNeedEngine(), { config: CONFIG, fetchImpl: failing })
    const bundle = await engine.gather("what is the latest version of node?")
    expect(bundle.sources).toHaveLength(0)
    expect(bundle.notes.length).toBeGreaterThan(0)
  })

  test("results are deduped, ranked and turned into numbered passages", async () => {
    const fetchImpl = fakeFetch(
      [
        { title: "Node.js releases", url: "https://nodejs.org/en/download", snippet: "current node release" },
        { title: "Node.js releases", url: "https://nodejs.org/en/download/", snippet: "current node release" },
        { title: "A blog post", url: "https://example.com/blog/node", snippet: "node version news" },
      ],
      {
        "https://nodejs.org": "The current release of Node.js is version 24. It ships with V8 13.6 and npm 11.",
        "https://example.com": "A blog post about node version 24 and what changed in it.",
      },
    )
    const engine = new ResearchEngine(new ResearchNeedEngine(), { config: CONFIG, fetchImpl })
    const bundle = await engine.gather("what is the current node.js version?")

    // The duplicate URL is gone.
    const urls = bundle.sources.map((source) => source.url)
    expect(new Set(urls).size).toBe(urls.length)
    expect(bundle.passages.length).toBeGreaterThan(0)

    // The prompt carries the sources, numbered, and the evidence under them.
    const prompt = engine.format(bundle)
    expect(prompt).toContain("### Sources")
    expect(prompt).toContain("[1]")
    expect(prompt).toContain("24")
  })

  test("the search runs even when the model never asked for it", async () => {
    // The engine gathers on its own; nothing here calls a model.
    let searched = 0
    const counting = (async (input: unknown) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String((input as { url?: string })?.url)
      if (url.includes("duckduckgo")) searched++
      return fakeFetch(
        [{ title: "Node.js downloads", url: "https://nodejs.org/en/download", snippet: "download" }],
        { "https://nodejs.org": "Download Node.js 24, the current release with npm 11." },
      )(input as string)
    }) as unknown as typeof fetch

    const engine = new ResearchEngine(new ResearchNeedEngine(), { config: CONFIG, fetchImpl: counting })
    const assessment = engine.assess("what is the latest node.js version?")
    expect(assessment.needed).toBe(true)
    await engine.gather("what is the latest node.js version?")
    expect(searched).toBeGreaterThan(0)
  })
})

describe("checking the answer", () => {
  const bundle: ResearchBundle = {
    query: "what is the node version",
    queries: ["node version"],
    sources: [
      { title: "Node.js", url: "https://nodejs.org/" },
      { title: "Release notes", url: "https://nodejs.org/en/blog" },
    ] satisfies ResearchSource[],
    passages: [
      {
        url: "https://nodejs.org/",
        title: "Node.js",
        text: "The current release of Node.js is version 24, released in May, and it ships with npm 11.",
        score: 1,
      },
    ],
    notes: [],
    searchedAt: Date.now(),
  }

  test("factual sentences are found, and questions are not", () => {
    const claims = extractClaims(
      "Node.js 24 is the current release of the runtime. It ships with npm 11. What should I install?",
    )
    expect(claims.some((claim) => claim.includes("Node.js 24"))).toBe(true)
    expect(claims.some((claim) => claim.includes("What should I install"))).toBe(false)
  })

  test("a claim the sources support passes", () => {
    const claims = unsupportedClaims("The current release of Node.js is version 24, released in May.", bundle)
    expect(claims).toHaveLength(0)
  })

  test("a claim the sources do not support is caught", () => {
    const claims = unsupportedClaims("Node.js 27 was released last week with npm 13.", bundle)
    expect(claims.length).toBeGreaterThan(0)
    expect(claims[0]!.reason).toContain("do not mention")
  })

  test("a wrong number is caught even when the rest of the sentence matches", () => {
    // The sentence is nearly word-for-word the evidence — except the version.
    const claims = unsupportedClaims(
      "The current release of Node.js is version 27 and it ships with npm 13.",
      bundle,
    )
    expect(claims.length).toBeGreaterThan(0)
    expect(claims[0]!.reason).toContain("do not mention")
  })

  test("an invented citation is caught", () => {
    const claims = unsupportedClaims("The current release is version 24 [1], according to the manual [7].", bundle)
    expect(claims.some((claim) => claim.text.includes("citation [7]"))).toBe(true)
  })

  test("one follow-up query is built from the claim, and the prompt names it", () => {
    const claims = unsupportedClaims("Node.js 27 was released last week with npm 13.", bundle)
    const queries = claimQueries(claims)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain("Node.js 27")
    const prompt = claimCheckPrompt(claims)
    expect(prompt).toContain("Node.js 27")
    expect(prompt).toContain("Do not invent numbers, versions, dates or citations")
  })

  test("a well-supported answer is not searched again", () => {
    const answer = "The current release of Node.js is version 24, released in May, and it ships with npm 11."
    expect(answerConfidence(answer, bundle)).toBeGreaterThanOrEqual(CROSS_CHECK_CONFIDENCE)
    expect(needsCrossCheck(answer, bundle)).toBe(false)
  })

  test("an invented citation needs a check", () => {
    expect(needsCrossCheck("The current release is version 24 [1], according to the manual [7].", bundle)).toBe(true)
  })

  test("a number no source mentions needs a check, even in a fluent sentence", () => {
    expect(
      needsCrossCheck("The current release of Node.js is version 24, released in June 2026.", bundle),
    ).toBe(true)
  })

  test("with no evidence gathered there is nothing to check against", () => {
    expect(needsCrossCheck("Anything at all.", { ...bundle, passages: [] })).toBe(false)
  })
})

describe("the shared classifier", () => {
  test("it learns, and its state is versioned and atomic", async () => {
    const model = new LinearModel({ priors: { bias: -1 } })
    // The bias is a feature like any other: the caller includes it, so a
    // model can be given a different intercept per use.
    const features: Array<readonly [string, number]> = [["bias", 1], ["w:hello", 1]]
    expect(model.probability(features)).toBeLessThan(0.5)
    for (let index = 0; index < 8; index++) model.learn(features, true)
    expect(model.probability(features)).toBeGreaterThan(0.5)

    const path = join(home, "model.json")
    await model.save(path)
    const state = await Bun.file(path).json()
    expect(state.version).toBe(1)
    expect(Object.keys(state.weights).length).toBeGreaterThan(0)
  })

  test("a corrupt or foreign state file is refused", () => {
    expect(LinearModel.fromJson({ version: 99, trained: 1, weights: { a: 1 } }, { priors: {} })).toBeUndefined()
    expect(LinearModel.fromJson({ version: 1, trained: 1, weights: { a: "x" } }, { priors: {} })).toBeUndefined()
    expect(LinearModel.fromJson({ version: 1, trained: 1, weights: {} }, { priors: {} })).toBeUndefined()
  })

  test("the vocabulary stays bounded", () => {
    const model = new LinearModel({ priors: {}, maxFeatures: 50 })
    for (let index = 0; index < 500; index++) model.learn([["bias", 1], [`w:word${index}`, 1]], true)
    expect(model.vocabularySize()).toBeLessThanOrEqual(50)
  })
})

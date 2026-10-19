import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImurunConfig } from "@imurun/schema"
import { createLogger } from "@imurun/util"
import type { ToolContext } from "../src/tool/types"
import {
  cacheFetchedPage,
  decodeEntities,
  extractTitle,
  fetchPage,
  htmlToText,
  parseBrave,
  parseDuckDuckGo,
  parseSearxng,
  searchWeb,
  unwrapDuckDuckGoUrl,
  webCachePath,
  webFetchTool,
  webSearchTool,
} from "../src/tool/web"

const RESULTS_HTML = `
<html><head><title>duck</title></head><body>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example &amp; Docs</a>
  <a class="result__snippet">The <b>official</b> docs for the thing.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://second.example/page">Second result</a>
  <a class="result__snippet">Another snippet.</a>
</div>
</body></html>`

describe("decodeEntities", () => {
  test("handles named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &lt;3 &#65; &#x42;")).toBe("Tom & Jerry <3 A B")
    expect(decodeEntities("&unknown;")).toBe("&unknown;")
  })
})

describe("htmlToText", () => {
  test("drops scripts and styles and keeps prose", () => {
    const text = htmlToText("<html><head><style>p{color:red}</style></head><body><h1>Title</h1><script>alert(1)</script><p>Hello <b>world</b></p></body></html>")
    expect(text).toContain("Title")
    expect(text).toContain("Hello world")
    expect(text).not.toContain("alert")
    expect(text).not.toContain("color:red")
  })

  test("keeps list items and paragraph breaks", () => {
    const text = htmlToText("<ul><li>one</li><li>two</li></ul>")
    expect(text).toBe("- one\n\n- two")
  })
})

describe("extractTitle", () => {
  test("reads and cleans the title", () => {
    expect(extractTitle("<title>  Hi &amp; bye </title>")).toBe("Hi & bye")
    expect(extractTitle("<p>no title</p>")).toBeUndefined()
  })
})

describe("unwrapDuckDuckGoUrl", () => {
  test("decodes the redirect parameter", () => {
    expect(unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.dev%2Fx&rut=1")).toBe("https://a.dev/x")
    expect(unwrapDuckDuckGoUrl("//example.org/a")).toBe("https://example.org/a")
    expect(unwrapDuckDuckGoUrl("https://plain.example")).toBe("https://plain.example")
  })
})

describe("parseDuckDuckGo", () => {
  test("extracts titled, deduplicated results with snippets", () => {
    const results = parseDuckDuckGo(RESULTS_HTML)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ title: "Example & Docs", url: "https://example.com/docs", snippet: "The official docs for the thing." })
    expect(results[1]?.url).toBe("https://second.example/page")
  })

  test("ignores non-http links", () => {
    expect(parseDuckDuckGo('<a class="result__a" href="javascript:void(0)">nope</a>')).toEqual([])
  })
})

describe("searchWeb", () => {
  test("uses the injected fetch and returns results", async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return { ok: true, status: 200, text: async () => RESULTS_HTML } as unknown as Response
    }) as unknown as typeof fetch

    const results = await searchWeb("example docs", { fetchImpl: fake, limit: 1 })
    expect(results).toHaveLength(1)
    expect(calls[0]).toContain("html.duckduckgo.com")
    expect(calls[0]).toContain(encodeURIComponent("example docs"))
  })

  test("reports a bad status", async () => {
    const fake = (async () => ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch
    await expect(searchWeb("x", { fetchImpl: fake })).rejects.toThrow("503")
  })
})

describe("fetchPage", () => {
  test("reduces a page to text and reports its title", async () => {
    const html = "<html><head><title>Doc</title></head><body><p>Body text here</p></body></html>"
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: async () => html,
        body: undefined,
      }) as unknown as Response) as unknown as typeof fetch

    const page = await fetchPage("https://example.com/doc", { fetchImpl: fake })
    expect(page.title).toBe("Doc")
    expect(page.text).toContain("Body text here")
    expect(page.truncated).toBe(false)
    expect(page.url).toBe("https://example.com/doc")
  })

  test("refuses non-http schemes", async () => {
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow("Only http")
    await expect(fetchPage("not a url")).rejects.toThrow("Not a valid URL")
  })

  test("reads plain text without mangling it", async () => {
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: async () => "line one\nline two",
        body: undefined,
      }) as unknown as Response) as unknown as typeof fetch
    const page = await fetchPage("https://example.com/raw.txt", { fetchImpl: fake })
    expect(page.text).toBe("line one\nline two")
  })
})

describe("web tools", () => {
  test("describe themselves to the model", () => {
    expect(webSearchTool.name).toBe("web_search")
    expect(webFetchTool.name).toBe("web_fetch")
    expect(webSearchTool.description.length).toBeGreaterThan(40)
    expect(webSearchTool.parameters).toMatchObject({ required: ["query"] })
    expect(webFetchTool.parameters).toMatchObject({ required: ["url"] })
  })

  test("fail cleanly when the network is unavailable", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch
    const ctx: ToolContext = { sessionId: "s", workingDir: ".", log: createLogger("test") }
    try {
      const searched = await webSearchTool.execute({ query: "anything" }, ctx)
      expect(searched.ok).toBe(false)
      expect(searched.output).toContain("offline")

      const fetched = await webFetchTool.execute({ url: "https://example.com" }, ctx)
      expect(fetched.ok).toBe(false)
      expect(fetched.output).toContain("offline")
    } finally {
      globalThis.fetch = original
    }
  })

  test("titles a search call for the permission prompt", () => {
    expect(webSearchTool.title?.({ query: "hello" })).toContain("hello")
    expect(webFetchTool.title?.({ url: "https://x.dev" })).toContain("https://x.dev")
  })
})

describe("search backends", () => {
  test("searxng is asked in JSON and its results are read", async () => {
    const body = JSON.stringify({
      results: [
        { title: "One", url: "https://one.example", content: "first snippet" },
        { title: "", url: "https://two.example" },
      ],
    })
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return { ok: true, status: 200, headers: new Headers({}), text: async () => body } as unknown as Response
    }) as unknown as typeof fetch

    const results = await searchWeb("how to x", {
      fetchImpl: fake,
      backend: "searxng",
      searxngURL: "https://searx.example/",
    })

    expect(calls[0]).toBe(`https://searx.example/search?q=${encodeURIComponent("how to x")}&format=json`)
    expect(results[0]).toEqual({ title: "One", url: "https://one.example", snippet: "first snippet" })
    // A result with no title falls back to its URL rather than showing blank.
    expect(results[1]!.title).toBe("https://two.example")
  })

  test("a missing SearXNG instance explains itself", async () => {
    await expect(searchWeb("q", { backend: "searxng" })).rejects.toThrow("web.searxngURL")
  })

  test("brave sends its key and reads its response shape", async () => {
    const body = JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example", description: "desc" }] } })
    let headers: Record<string, string> = {}
    let called = ""
    const fake = (async (url: string, init?: RequestInit) => {
      called = url
      headers = (init?.headers ?? {}) as Record<string, string>
      return { ok: true, status: 200, headers: new Headers({}), text: async () => body } as unknown as Response
    }) as unknown as typeof fetch

    const results = await searchWeb("q", { fetchImpl: fake, backend: "brave", apiKey: "k123" })

    expect(called).toContain("api.search.brave.com")
    expect(headers["x-subscription-token"]).toBe("k123")
    expect(results[0]).toEqual({ title: "B", url: "https://b.example", snippet: "desc" })
  })

  test("brave without a key explains itself", async () => {
    await expect(searchWeb("q", { backend: "brave" })).rejects.toThrow("API key")
  })

  test("a malformed body is empty, not a crash", () => {
    expect(parseSearxng("<html>nope</html>")).toEqual([])
    expect(parseBrave("{}")).toEqual([])
    expect(parseSearxng(JSON.stringify({ results: "not an array" }))).toEqual([])
  })
})

describe("caching fetched pages", () => {
  test("the cache path is recognisable and unique per URL", () => {
    const a = webCachePath("C:/proj", "https://example.com/docs/intro")
    const again = webCachePath("C:/proj", "https://example.com/docs/intro")
    const other = webCachePath("C:/proj", "https://example.com/other/intro")
    const posix = a.replace(/\\/g, "/")

    expect(a).toBe(again)
    expect(a).not.toBe(other)
    expect(posix).toContain(".imurun/web-cache/example-com-docs-intro-")
    expect(posix).toMatch(/\.md$/)
  })

  test("caching writes a readable markdown file inside the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imurun-web-"))
    const saved = await cacheFetchedPage(dir, {
      url: "https://example.com/doc",
      title: "Doc",
      text: "The body text.",
      truncated: false,
    })

    expect(saved.replace(/\\/g, "/")).toContain(".imurun/web-cache/")
    const written = readFileSync(join(dir, saved), "utf8")
    expect(written).toContain("# Doc")
    expect(written).toContain("https://example.com/doc")
    expect(written).toContain("The body text.")
  })

  test("the fetch tool caches only when the setting asks for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imurun-web-"))
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: undefined,
        text: async () => "page body",
      }) as unknown as Response) as unknown as typeof fetch

    try {
      const off: ToolContext = {
        sessionId: "s",
        workingDir: dir,
        log: createLogger("test"),
        config: ImurunConfig.parse({}),
      }
      await webFetchTool.execute({ url: "https://example.com/a.txt" }, off)
      expect(existsSync(join(dir, ".imurun", "web-cache"))).toBe(false)

      const on: ToolContext = { ...off, config: ImurunConfig.parse({ web: { cacheFetches: true } }) }
      const result = await webFetchTool.execute({ url: "https://example.com/b.txt" }, on)
      expect(result.output).toContain("cached at")
      expect(existsSync(join(dir, ".imurun", "web-cache"))).toBe(true)
    } finally {
      globalThis.fetch = original
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a page is read only up to the configured byte ceiling", async () => {
    const encoder = new TextEncoder()
    const chunks = [encoder.encode("x".repeat(100_000)), encoder.encode("y".repeat(100_000))]
    let read = 0
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: {
          getReader: () => ({
            read: async () => (read < chunks.length ? { done: false, value: chunks[read++] } : { done: true, value: undefined }),
            cancel: async () => {},
          }),
        },
        text: async () => "unused",
      }) as unknown as Response) as unknown as typeof fetch

    const page = await fetchPage("https://example.com/big.txt", { fetchImpl: fake, maxBytes: 64 * 1024, maxChars: 500 })
    // The ceiling was passed by the first chunk, so the second was never read.
    expect(read).toBe(1)
    expect(page.text.length).toBeLessThanOrEqual(500)
  })
})

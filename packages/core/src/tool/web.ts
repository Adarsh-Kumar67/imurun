/**
 * Web tools — search and read pages from the internet.
 *
 * The default path is deliberately dependency-free and key-free: search goes
 * through DuckDuckGo's HTML endpoint, and fetch downloads the page and reduces
 * it to readable text. `config.web.searchBackend` can point search at a SearXNG
 * instance or at Brave instead, for people who prefer them or need a
 * key-backed, terms-of-service-clean source.
 *
 * Everything is capped (bytes, characters, time) so a hostile or enormous page
 * cannot stall a run, and non-HTTP schemes are refused outright.
 *
 * When the machine is offline the tools fail with a plain message rather than
 * hanging, which matters for a local-first agent.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { sha256 } from "@imurun/util"
import type { ImurunTool } from "./types"
import { fail, ok, optionalNumber, optionalString, requireString } from "./types"

const USER_AGENT =
  "Mozilla/5.0 (compatible; IMURUN/0.1; +https://imutechz.in) local-first coding agent"
const MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_FETCH_CHARS = 12_000
const MAX_FETCH_CHARS = 60_000
const DEFAULT_RESULTS = 6
const MAX_RESULTS = 15
const TIMEOUT_MS = 20_000

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  middot: "\u00b7",
  bull: "\u2022",
  times: "\u00d7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  euro: "\u20ac",
  pound: "\u00a3",
  deg: "\u00b0",
}

/** Decodes the HTML entities that actually show up in page text. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** Reduces an HTML document to plain, readable text. */
export function htmlToText(html: string): string {
  let text = html
    // drop anything that is not prose
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "\n")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "\n")
    .replace(/<head[\s\S]*?<\/head>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")

  // make block boundaries explicit so paragraphs stay separate
  text = text
    .replace(/<\s*(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n")
    .replace(/<\s*(li)\b[^>]*>/gi, "\n- ")

  text = text.replace(/<[^>]+>/g, " ")
  text = decodeEntities(text)
  return text
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Title of an HTML document, when it has one. */
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return undefined
  const title = decodeEntities(match[1]!).replace(/\s+/g, " ").trim()
  return title || undefined
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Turns DuckDuckGo's redirect wrapper into the real destination URL. */
export function unwrapDuckDuckGoUrl(href: string): string {
  const decoded = decodeEntities(href)
  const match = /[?&]uddg=([^&]+)/.exec(decoded)
  if (match) {
    try {
      return decodeURIComponent(match[1]!)
    } catch {
      return decoded
    }
  }
  if (decoded.startsWith("//")) return `https:${decoded}`
  return decoded
}

/** Parses a DuckDuckGo HTML/Lite results page. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi

  const snippets: string[] = []
  let snippetMatch: RegExpExecArray | null
  while ((snippetMatch = snippetPattern.exec(html)) !== null) {
    snippets.push(htmlToText(snippetMatch[1]!).replace(/\n+/g, " ").trim())
  }

  let match: RegExpExecArray | null
  let index = 0
  while ((match = linkPattern.exec(html)) !== null) {
    const url = unwrapDuckDuckGoUrl(match[1]!)
    const title = htmlToText(match[2]!).replace(/\n+/g, " ").trim()
    if (!url.startsWith("http") || seen.has(url)) {
      index++
      continue
    }
    seen.add(url)
    results.push({ title: title || url, url, snippet: snippets[index] ?? "" })
    index++
  }

  return results
}

async function readCapped(response: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      chunks.push(value)
      if (total >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged)
}

async function timedFetch(url: string, fetchImpl: typeof fetch, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

function networkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(message)) return "The request timed out. The site may be slow or unreachable."
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(message)) {
    return "No network connection (this machine is offline, or DNS failed)."
  }
  return `Request failed: ${message}`
}

/** The search engines IMURUN can ask. */
export type SearchBackend = "duckduckgo" | "brave" | "searxng"

export interface WebSearchOptions {
  limit?: number
  fetchImpl?: typeof fetch
  /** Which engine to ask; defaults to DuckDuckGo, which needs no key. */
  backend?: SearchBackend
  /** Base URL of the SearXNG instance, when the backend is searxng. */
  searxngURL?: string
  /** Brave Search API key, when the backend is brave. */
  apiKey?: string
}

/** Reads a JSON search response into results, ignoring anything malformed. */
function parseJsonResults(body: string, pick: (data: unknown) => unknown): SearchResult[] {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return []
  }
  const list = pick(data)
  if (!Array.isArray(list)) return []

  const results: SearchResult[] = []
  for (const item of list) {
    const entry = item as { title?: unknown; url?: unknown; content?: unknown; description?: unknown }
    if (typeof entry.url !== "string" || !entry.url) continue
    const snippet = typeof entry.content === "string" ? entry.content : typeof entry.description === "string" ? entry.description : ""
    results.push({
      title: typeof entry.title === "string" && entry.title ? entry.title : entry.url,
      url: entry.url,
      snippet,
    })
  }
  return results
}

/** Parses a SearXNG JSON response (`format=json`). */
export function parseSearxng(body: string): SearchResult[] {
  return parseJsonResults(body, (data) => (data as { results?: unknown }).results)
}

/** Parses a Brave Web Search API response. */
export function parseBrave(body: string): SearchResult[] {
  return parseJsonResults(body, (data) => (data as { web?: { results?: unknown } }).web?.results)
}

/** Searches the web and returns ranked results. Exported for tests and reuse. */
export async function searchWeb(query: string, options: WebSearchOptions = {}): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RESULTS, 1), MAX_RESULTS)
  const doFetch = options.fetchImpl ?? fetch
  const backend = options.backend ?? "duckduckgo"

  if (backend === "searxng") {
    if (!options.searxngURL) throw new Error("No SearXNG instance is configured — set web.searxngURL, or use the default backend.")
    const base = options.searxngURL.replace(/\/+$/, "")
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
    const response = await timedFetch(url, doFetch, { accept: "application/json" })
    if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}.`)
    return parseSearxng(await response.text()).slice(0, limit)
  }

  if (backend === "brave") {
    if (!options.apiKey) throw new Error("Brave Search needs an API key — set web.braveApiKey (or BRAVE_API_KEY).")
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const response = await timedFetch(url, doFetch, {
      accept: "application/json",
      "x-subscription-token": options.apiKey,
    })
    if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}.`)
    return parseBrave(await response.text()).slice(0, limit)
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await timedFetch(url, doFetch)
  if (!response.ok) throw new Error(`Search service returned HTTP ${response.status}.`)
  const html = await readCapped(response)
  return parseDuckDuckGo(html).slice(0, limit)
}

export interface FetchedPage {
  url: string
  title?: string
  text: string
  truncated: boolean
}

/** Downloads a page and returns its readable text. Exported for tests and reuse. */
export async function fetchPage(
  url: string,
  options: { maxChars?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<FetchedPage> {
  const maxChars = Math.min(Math.max(options.maxChars ?? DEFAULT_FETCH_CHARS, 500), MAX_FETCH_CHARS)
  const maxBytes = Math.min(Math.max(options.maxBytes ?? MAX_BYTES, 64 * 1024), MAX_BYTES)
  const doFetch = options.fetchImpl ?? fetch

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Not a valid URL: ${url}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http and https URLs are allowed (got ${parsed.protocol}).`)
  }

  const response = await timedFetch(parsed.toString(), doFetch)
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${parsed.toString()}`)

  const contentType = response.headers.get("content-type") ?? ""
  const body = await readCapped(response, maxBytes)

  if (/^text\/plain/i.test(contentType)) {
    return { url: parsed.toString(), text: body.slice(0, maxChars), truncated: body.length > maxChars }
  }
  const text = htmlToText(body)
  const title = extractTitle(body)
  return {
    url: parsed.toString(),
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  }
}

// ── Web cache ───────────────────────────────────────────────────────────────

/** Project-relative directory fetched pages are cached in. */
const WEB_CACHE_DIR = ".imurun/web-cache"

/**
 * Where a fetched page is cached. The name carries enough of the URL to be
 * recognisable by eye, plus a hash so two pages with the same path cannot
 * overwrite each other.
 */
export function webCachePath(workingDir: string, url: string): string {
  const parsed = new URL(url)
  const slug =
    `${parsed.hostname}${parsed.pathname}`
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page"
  return join(workingDir, WEB_CACHE_DIR, `${slug}-${sha256(url).slice(0, 8)}.md`)
}

/**
 * Writes a fetched page into the project, where the project index will find it.
 *
 * `web.cacheFetches` is what turns this on. It exists because re-reading a page
 * the agent has already read is exactly the sort of thing a local-first agent
 * should not do twice: once cached, the text is searchable offline through
 * `code_search`, and no second request is needed. Returns the path for display.
 */
export async function cacheFetchedPage(workingDir: string, page: FetchedPage): Promise<string> {
  const path = webCachePath(workingDir, page.url)
  await mkdir(dirname(path), { recursive: true })
  const title = page.title ?? page.url
  const body = `# ${title}\n\nSource: ${page.url}\nFetched: ${new Date().toISOString()}\n\n${page.text}\n`
  await writeFile(path, body, "utf8")
  return relative(workingDir, path).replace(/\\/g, "/")
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const webSearchTool: ImurunTool = {
  name: "web_search",
  description:
    "Search the internet for current information. Use this whenever the answer depends on something that may have " +
    "changed recently (library versions, API changes, error messages, release notes) or on facts outside the project. " +
    "Returns titles, URLs and snippets; follow up with web_fetch to read a page in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query, phrased as you would type it into a search engine." },
      limit: { type: "number", description: `Maximum results to return (default ${DEFAULT_RESULTS}).` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  title: (args) => `search the web for "${String(args.query ?? "")}"`,
  async execute(args, ctx) {
    const query = requireString(args, "query")
    const limit = optionalNumber(args, "limit") ?? DEFAULT_RESULTS
    const web = ctx.config?.web
    try {
      const results = await searchWeb(query, {
        limit,
        backend: web?.searchBackend,
        searxngURL: web?.searxngURL,
        apiKey: web?.braveApiKey ?? process.env.BRAVE_API_KEY,
      })
      if (results.length === 0) {
        return ok(`No results for "${query}". Try different words, or fetch a known URL with web_fetch.`)
      }
      const rendered = results
        .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`)
        .join("\n\n")
      return ok(rendered, { title: `${results.length} result(s) for "${query}"` })
    } catch (error) {
      return fail(networkError(error))
    }
  },
}

export const webFetchTool: ImurunTool = {
  name: "web_fetch",
  description:
    "Download a web page (or text file) from a URL and return its readable text. Use it to read documentation, " +
    "changelogs, issues or articles you found with web_search, or any URL the user gives you. HTML is reduced to " +
    "plain text; only http and https are allowed.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to read." },
      maxChars: { type: "number", description: `Maximum characters of text to return (default ${DEFAULT_FETCH_CHARS}).` },
    },
    required: ["url"],
    additionalProperties: false,
  },
  title: (args) => `fetch ${String(args.url ?? "")}`,
  async execute(args, ctx) {
    const url = requireString(args, "url")
    const maxChars = optionalNumber(args, "maxChars") ?? DEFAULT_FETCH_CHARS
    const web = ctx.config?.web
    try {
      const page = await fetchPage(url, {
        maxChars,
        // A page bigger than the configured ceiling is read up to it, not in
        // full: one enormous page must not eat the window.
        maxBytes: web ? web.maxPageKB * 1024 : undefined,
      })
      const header = page.title ? `# ${page.title}\n${page.url}\n\n` : `${page.url}\n\n`
      let footer = page.truncated ? "\n\n[truncated — fetch a more specific URL or raise maxChars]" : ""
      if (web?.cacheFetches) {
        const saved = await cacheFetchedPage(ctx.workingDir, page).catch(() => undefined)
        if (saved) footer += `\n[cached at ${saved}; code_search will find it offline]`
      }
      return ok(`${header}${page.text}${footer}`.trim(), { title: page.title ?? page.url })
    } catch (error) {
      return fail(networkError(error))
    }
  },
}

/** Re-exported for tests. */
export const webTools: ImurunTool[] = [webSearchTool, webFetchTool]

/**
 * The research engine.
 *
 * A local model does not know what happened after its training cut-off, and a
 * small one will often answer a current-events question from memory even when
 * it has a `web_search` tool. Telling it to "always search" wastes time on
 * "rename this function"; telling it to "search when needed" gets ignored.
 *
 * So the decision is taken out of the model's hands at the point where it
 * matters:
 *
 *   1. Before the first token, a learned classifier decides whether the request
 *      is about the world or about the codebase.
 *   2. If it is, IMURUN searches (DuckDuckGo by default, with the configured
 *      backend first and a fallback chain), dedupes and ranks the results,
 *      fetches the pages, extracts the passages that answer the question, and
 *      puts them in the prompt with numbered citations.
 *   3. After the draft, a claim check compares the answer's factual sentences
 *      against that evidence. Unsupported claims trigger one bounded extra
 *      search, and the model is asked to reconcile — not to guess.
 *
 * Everything is dependency-free, bounded, and honest when offline: a failure
 * becomes a note and the turn continues without evidence rather than hanging.
 */
import type { WebConfig } from "@imurun/schema"
import { cosineSimilarity, featureWords } from "../engines/linear"
import { tokenize } from "../memory/search"
import { fetchPage, searchWeb, type SearchResult, type WebSearchOptions } from "../tool/web"
import { defaultResearchModelPath, ResearchNeedEngine, type ResearchAssessment, type ResearchContext } from "./need"

export interface ResearchSource {
  title: string
  url: string
  snippet?: string
}

export interface EvidencePassage {
  url: string
  title: string
  text: string
  score: number
}

export interface ResearchBundle {
  query: string
  queries: string[]
  assessment?: ResearchAssessment
  sources: ResearchSource[]
  passages: EvidencePassage[]
  notes: string[]
  searchedAt: number
}

export interface ResearchOptions {
  config: WebConfig
  fetchImpl?: typeof fetch
  modelPath?: string
}

export interface GatherOptions {
  /** Extra queries, used for claim checks. */
  queries?: readonly string[]
  maxQueries?: number
  maxPages?: number
}

export interface Claim {
  text: string
  coverage: number
  reason: string
}

const SEARCH_RESULTS_PER_QUERY = 6
const MAX_PASSAGES_PER_PAGE = 2
const MAX_PASSAGE_CHARS = 1_400
const MAX_CONTEXT_CHARS = 7_000
const MAX_CLAIM_CHECKS = 1
const SKIP_EXTENSIONS = /\.(?:pdf|zip|tar|gz|7z|exe|dmg|iso|mp4|mp3|png|jpe?g|gif|webp|svg)$/i

export const RESEARCH_CHECK_PROMPT =
  "[system] Some factual statements in your answer are not supported by the sources gathered so far. " +
  "The evidence above has been updated by a further search. Check each statement below against it. " +
  "If a statement is still unsupported, either remove it, qualify it as uncertain, or call web_search for " +
  "that exact question and cite what you find. Do not invent numbers, versions, dates or citations. " +
  "Then give the corrected final answer."

function cleanQuery(text: string): string {
  let query = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  if (query.length > 200) {
    const sentence = query.split(/(?<=[.!?])\s+/).find((part) => part.length >= 12) ?? query
    query = sentence.slice(0, 200)
  }
  return query.replace(/^(?:please\s+|can you\s+|could you\s+|hey,?\s+)/i, "").trim()
}

function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ""
    const path = url.pathname.replace(/\/+$/, "")
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw
  }
}

function domainOf(raw: string): string {
  try {
    return new URL(raw).host.toLowerCase()
  } catch {
    return ""
  }
}

function scoreResult(result: SearchResult, queryTerms: readonly string[], rank: number): number {
  const titleTokens = new Set(featureWords(result.title))
  const snippetTokens = new Set(featureWords(result.snippet))
  let coverage = 0
  for (const term of queryTerms) {
    if (titleTokens.has(term)) coverage += 2
    else if (snippetTokens.has(term)) coverage += 1
  }
  const freshness = /\b(?:19|20)\d{2}\b/.test(`${result.title} ${result.snippet}`) ? 0.4 : 0
  const secure = result.url.startsWith("https://") ? 0.1 : 0
  return coverage / Math.max(1, queryTerms.length) + freshness + secure - rank * 0.05
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 60)
}

/** Picks the paragraphs that actually contain the query's terms. */
function passagesFrom(
  text: string,
  url: string,
  title: string,
  terms: readonly string[],
): EvidencePassage[] {
  const candidates = paragraphs(text)
  if (candidates.length === 0) {
    const fallback = text.replace(/\s+/g, " ").trim()
    if (!fallback) return []
    return [{ url, title, text: fallback.slice(0, 900), score: 0 }]
  }
  const scored = candidates.map((paragraph, index) => {
    const tokens = new Set(featureWords(paragraph))
    let hits = 0
    for (const term of terms) if (tokens.has(term)) hits++
    const coverage = hits / Math.max(1, terms.length)
    // Prefer a paragraph that can stand alone: not a caption, not a wall.
    const length = paragraph.length
    const shape = length >= 180 && length <= 900 ? 0.15 : 0
    return { paragraph, index, score: coverage + shape }
  })
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_PASSAGES_PER_PAGE)
    .map((entry) => ({
      url,
      title,
      text: entry.paragraph.slice(0, MAX_PASSAGE_CHARS),
      score: entry.score,
    }))
}

export class ResearchEngine {
  private readonly need: ResearchNeedEngine
  private readonly config: WebConfig
  private readonly fetchImpl: typeof fetch
  private readonly modelPath: string

  constructor(need: ResearchNeedEngine, options: ResearchOptions) {
    this.need = need
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? fetch
    this.modelPath = options.modelPath ?? defaultResearchModelPath()
  }

  static async create(options: ResearchOptions): Promise<ResearchEngine> {
    const path = options.modelPath ?? defaultResearchModelPath()
    return new ResearchEngine(await ResearchNeedEngine.load(path), { ...options, modelPath: path })
  }

  assess(message: string, context: ResearchContext = {}): ResearchAssessment {
    return this.need.assess(message, context)
  }

  /** Records what actually happened, so the next assessment is a little better. */
  async learn(message: string, needed: boolean, strength = 0.5, context: ResearchContext = {}): Promise<void> {
    this.need.learn(message, needed, strength, context)
    try {
      await this.need.save()
    } catch {
      // A model file that cannot be written must not fail a turn.
    }
  }

  /** The backend order: the configured one first, then whatever can work. */
  private backends(): WebSearchOptions[] {
    const list: WebSearchOptions[] = []
    const push = (backend: "duckduckgo" | "searxng" | "brave"): void => {
      if (list.some((entry) => entry.backend === backend)) return
      list.push({
        backend,
        limit: SEARCH_RESULTS_PER_QUERY,
        fetchImpl: this.fetchImpl,
        searxngURL: this.config.searxngURL,
        apiKey: this.config.braveApiKey ?? process.env.BRAVE_API_KEY,
      })
    }
    push(this.config.searchBackend)
    if (this.config.searchBackend !== "duckduckgo") push("duckduckgo")
    if (this.config.searxngURL) push("searxng")
    if (this.config.braveApiKey ?? process.env.BRAVE_API_KEY) push("brave")
    return list
  }

  private async searchOne(query: string, notes: string[]): Promise<SearchResult[]> {
    for (const backend of this.backends()) {
      try {
        const results = await searchWeb(query, backend)
        if (results.length > 0) return results
        notes.push(`${backend.backend ?? "search"} returned no results for "${query}"`)
      } catch (error) {
        notes.push(`${backend.backend ?? "search"} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return []
  }

  private rank(results: readonly SearchResult[], queryTerms: readonly string[]): SearchResult[] {
    const seenUrls = new Set<string>()
    const seenTitles: string[][] = []
    const perDomain = new Map<string, number>()
    const kept: Array<{ result: SearchResult; score: number }> = []

    for (const result of results) {
      if (!/^https?:\/\//i.test(result.url)) continue
      let pathname: string
      try {
        pathname = new URL(result.url).pathname
      } catch {
        continue
      }
      if (SKIP_EXTENSIONS.test(pathname)) continue
      const url = canonicalUrl(result.url)
      if (seenUrls.has(url)) continue
      const titleTokens = tokenize(result.title)
      if (seenTitles.some((tokens) => cosineSimilarity(tokens, titleTokens) >= 0.9)) continue
      const domain = domainOf(url)
      if (domain && (perDomain.get(domain) ?? 0) >= 2) continue
      seenUrls.add(url)
      seenTitles.push(titleTokens)
      if (domain) perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1)
      kept.push({ result: { ...result, url }, score: scoreResult(result, queryTerms, kept.length) })
    }

    return kept.sort((a, b) => b.score - a.score).map((entry) => entry.result)
  }

  /**
   * Searches, reads, and extracts evidence. Never throws: what failed is in
   * `notes`, and an empty bundle is a legitimate answer.
   */
  async gather(question: string, options: GatherOptions = {}): Promise<ResearchBundle> {
    const notes: string[] = []
    const base = cleanQuery(question)
    const extra = (options.queries ?? []).map(cleanQuery).filter(Boolean)
    const maxQueries = Math.max(1, options.maxQueries ?? this.config.researchMaxQueries)
    const queries: string[] = []
    for (const query of [base, ...extra]) {
      if (!query || queries.includes(query)) continue
      queries.push(query.slice(0, 200))
      if (queries.length >= maxQueries) break
    }

    const settled = await Promise.allSettled(queries.map((query) => this.searchOne(query, notes)))
    const results: SearchResult[] = []
    for (const entry of settled) if (entry.status === "fulfilled") results.push(...entry.value)

    const terms = [...new Set(queries.flatMap((query) => featureWords(query)))].filter((word) => word.length > 2)
    const ranked = this.rank(results, terms)
    const maxPages = Math.max(1, options.maxPages ?? this.config.researchMaxPages)
    const chosen = ranked.slice(0, maxPages)

    if (chosen.length === 0) {
      notes.push("No usable search results were found; the answer will have to say what is unknown.")
      return { query: base, queries, sources: [], passages: [], notes, searchedAt: Date.now() }
    }

    const sources: ResearchSource[] = chosen.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet || undefined,
    }))
    const passages: EvidencePassage[] = []
    const fetched = await Promise.allSettled(
      chosen.map((result) =>
        fetchPage(result.url, {
          maxChars: 12_000,
          fetchImpl: this.fetchImpl,
        }),
      ),
    )
    for (let index = 0; index < chosen.length; index++) {
      const result = chosen[index]!
      const outcome = fetched[index]!
      if (outcome.status === "rejected") {
        notes.push(
          `could not read ${result.url}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
        )
        if (result.snippet) {
          passages.push({ url: result.url, title: result.title, text: result.snippet, score: 0.1 })
        }
        continue
      }
      const page = outcome.value
      if (page.title && page.title.length > 3) {
        const source = sources.find((entry) => entry.url === result.url)
        if (source) source.title = page.title
      }
      const extracted = passagesFrom(page.text, result.url, page.title ?? result.title, terms)
      passages.push(...extracted)
    }

    passages.sort((a, b) => b.score - a.score)
    return {
      query: base,
      queries,
      sources,
      passages: passages.slice(0, maxPages * MAX_PASSAGES_PER_PAGE),
      notes,
      searchedAt: Date.now(),
    }
  }

  /** The prompt section, with citations in source order. */
  format(bundle: ResearchBundle, maxChars = MAX_CONTEXT_CHARS): string {
    if (bundle.sources.length === 0) return ""
    const numbered = new Map<string, number>()
    bundle.sources.forEach((source, index) => numbered.set(source.url, index + 1))
    const lines: string[] = [
      "## Web research (automatic)",
      "",
      "This request looked like it needed current or verifiable information, so IMURUN searched before answering.",
      "The sources below are numbered; cite the claim as [1], [2], and so on.",
      "",
      "### Sources",
    ]
    for (const source of bundle.sources) {
      lines.push(`[${numbered.get(source.url)}] ${source.title} — ${source.url}`)
    }
    if (bundle.passages.length > 0) {
      lines.push("", "### Evidence")
      let used = lines.join("\n").length
      for (const passage of bundle.passages) {
        const citation = numbered.get(passage.url)
        if (!citation) continue
        const block = `\n[${citation}] ${passage.title}\n${passage.text}\n`
        if (used + block.length > maxChars) break
        lines.push(block)
        used += block.length
      }
    }
    if (bundle.notes.length > 0) {
      lines.push("", "Search notes: " + bundle.notes.slice(0, 4).join("; "))
    }
    lines.push(
      "",
      "Only state what these sources support. If they disagree, say so and cite both. " +
        "If they do not settle the question, say what is still unknown instead of guessing.",
    )
    return lines.join("\n")
  }

  /** Merges a follow-up search into the evidence already in the prompt. */
  static merge(left: ResearchBundle, right: ResearchBundle): ResearchBundle {
    const seen = new Set(left.sources.map((source) => canonicalUrl(source.url)))
    const sources = [...left.sources]
    for (const source of right.sources) {
      const key = canonicalUrl(source.url)
      if (seen.has(key)) continue
      seen.add(key)
      sources.push(source)
    }
    const passageKeys = new Set(left.passages.map((passage) => `${passage.url}:${passage.text.slice(0, 60)}`))
    const passages = [...left.passages]
    for (const passage of right.passages) {
      const key = `${passage.url}:${passage.text.slice(0, 60)}`
      if (passageKeys.has(key)) continue
      passageKeys.add(key)
      passages.push(passage)
    }
    passages.sort((a, b) => b.score - a.score)
    return {
      query: left.query,
      queries: [...new Set([...left.queries, ...right.queries])],
      assessment: left.assessment ?? right.assessment,
      sources,
      passages,
      notes: [...new Set([...left.notes, ...right.notes])],
      searchedAt: Math.max(left.searchedAt, right.searchedAt),
    }
  }
}

/** Candidate factual sentences. Structural, not vocabulary-based. */
export function extractClaims(answer: string): string[] {
  const withoutCode = answer
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]{2,}`/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*#{1,6}\s+.*$/gm, " ")
  const sentences = withoutCode.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/)
  const claims: string[] = []
  for (const raw of sentences) {
    const sentence = raw
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\[(\d+)\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
    const words = sentence.split(/\s+/).filter(Boolean)
    if (words.length < 8 || words.length > 70) continue
    if (/\?$/.test(sentence)) continue
    const capitalized = (sentence.match(/\b[A-Z][a-z0-9]{1,}\b/g) ?? []).length
    const firstIsCapital = /^[A-Z]/.test(sentence) ? 1 : 0
    const entities = Math.max(0, capitalized - firstIsCapital)
    const numbers = /\b\d+(?:\.\d+)*\b/.test(sentence)
    if (!numbers && entities < 2) continue
    claims.push(sentence)
  }
  return claims.slice(0, 8)
}

function claimCoverage(claim: string, bundle: ResearchBundle): number {
  const claimTokens = tokenize(claim)
  if (claimTokens.length === 0) return 1
  const evidence = new Set(tokenize(bundle.passages.map((passage) => passage.text).join("\n")))
  let matched = 0
  let total = 0
  for (const token of claimTokens) {
    const weight = /\d/.test(token) ? 2 : 1
    total += weight
    if (evidence.has(token)) matched += weight
  }
  return total === 0 ? 1 : matched / total
}

/** Claims the evidence does not support, including invented citations. */
export function unsupportedClaims(answer: string, bundle: ResearchBundle): Claim[] {
  const claims: Claim[] = []
  const citations = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))
  for (const citation of citations) {
    if (citation < 1 || citation > bundle.sources.length) {
      claims.push({ text: `citation [${citation}]`, coverage: 0, reason: "there is no source with that number" })
    }
  }
  for (const claim of extractClaims(answer)) {
    const coverage = claimCoverage(claim, bundle)
    const numbers = claim.match(/\b\d+(?:\.\d+)*\b/g) ?? []
    // A number that appears nowhere in the evidence is a number nobody
    // supports — even when the rest of the sentence matches well. Versions,
    // dates and prices are exactly what a model gets wrong, so they are
    // checked on their own rather than by overall similarity.
    const unsupportedNumbers = numbers.filter(
      (number) => !bundle.passages.some((passage) => passage.text.includes(number)),
    )
    if (unsupportedNumbers.length > 0) {
      claims.push({
        text: claim,
        coverage,
        reason: `the sources do not mention ${unsupportedNumbers.slice(0, 3).join(", ")}`,
      })
      continue
    }
    const numericSupport = numbers.length === 0 || numbers.some((number) => bundle.passages.some((passage) => passage.text.includes(number)))
    if (coverage >= 0.55 || (coverage >= 0.35 && numericSupport)) continue
    claims.push({
      text: claim,
      coverage,
      reason: bundle.sources.length === 0 ? "no sources were gathered" : "the sources do not contain this",
    })
  }
  return claims
}

/**
 * How well the evidence supports the answer's factual sentences, 0..1.
 *
 * Not a probability: a share of the claim's terms (numbers weighted double)
 * that appear in the gathered passages. It exists so "check the answer" can be
 * a decision with a threshold behind it instead of an always-on second search.
 */
export function answerConfidence(answer: string, bundle: ResearchBundle): number {
  const claims = extractClaims(answer)
  if (claims.length === 0) return 1
  return claims.reduce((sum, claim) => sum + claimCoverage(claim, bundle), 0) / claims.length
}

/** The point below which an answer is checked against the sources again. */
export const CROSS_CHECK_CONFIDENCE = 0.75

/**
 * Whether the draft needs a cross-check before it is final.
 *
 * Two reasons only: the evidence supports less than 75% of what was said, or
 * something specific conflicts with it - an invented citation, or a number no
 * source contains. Everything else is left alone; a second search on every
 * answer would make the tool slower without making it more correct.
 */
export function needsCrossCheck(answer: string, bundle: ResearchBundle): boolean {
  if (bundle.passages.length === 0) return false

  const citations = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))
  if (citations.some((citation) => citation < 1 || citation > bundle.sources.length)) return true

  const numbers = answer.match(/\b\d+(?:\.\d+)*\b/g) ?? []
  const conflicting = numbers.some(
    (number) => !bundle.passages.some((passage) => passage.text.includes(number)),
  )
  if (conflicting) return true

  return answerConfidence(answer, bundle) < CROSS_CHECK_CONFIDENCE
}

/** One bounded follow-up question per unsupported claim. */
export function claimQueries(claims: readonly Claim[], limit = 2): string[] {
  return claims
    .filter((claim) => !claim.text.startsWith("citation ["))
    .map((claim) => claim.text.replace(/\s+/g, " ").slice(0, 160))
    .slice(0, limit)
}

export function claimCheckPrompt(claims: readonly Claim[]): string {
  const lines = claims.map((claim) => `- ${claim.text} (${claim.reason})`)
  return `${RESEARCH_CHECK_PROMPT}\n\nStatements in question:\n${lines.join("\n")}`
}

export const MAX_RESEARCH_VERIFICATIONS = MAX_CLAIM_CHECKS

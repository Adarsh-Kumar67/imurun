/**
 * Memory retrieval — offline, dependency-free ranking.
 *
 * A small BM25 implementation over memory records and session digests. It runs
 * entirely in-process (no embedding server, no network), which is what makes
 * recall work on a fresh machine with no model loaded. When the RAG index lands
 * (M8) it fuses these results with vector hits; the shapes already line up.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in", "on", "at", "by", "with",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "can", "could", "should", "would",
  "will", "shall", "may", "might", "must", "i", "you", "he", "she", "it", "we", "they", "this", "that", "these",
  "those", "my", "your", "its", "our", "their", "as", "so", "not", "no", "yes", "from", "into", "about", "over",
  "than", "too", "very", "just", "also", "how", "what", "when", "where", "which", "who", "why", "please", "help",
])

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const token of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (token.length < 2) continue
    if (STOPWORDS.has(token)) continue
    out.push(token)
  }
  return out
}

export interface SearchDoc {
  id: string
  /** Indexed text. */
  text: string
  /** "note", "session_summary", "todo", … — used for light boosting. */
  kind: string
  source: "note" | "session"
  projectPath?: string
  updatedAt: number
}

export interface SearchHit {
  doc: SearchDoc
  score: number
}

export interface SearchOptions {
  limit?: number
  /** Path of the active project; docs from it rank slightly higher. */
  projectPath?: string
  /** Kind prefixes that receive a relevance boost. */
  boostKinds?: string[]
}

const K1 = 1.2
const B = 0.75

/**
 * BM25 over the supplied docs. With an empty query it degrades to "most recent
 * first", so recall never comes back empty-handed.
 */
export function bm25Search(docs: SearchDoc[], query: string, options: SearchOptions = {}): SearchHit[] {
  const { limit = 5, projectPath, boostKinds = ["todo", "preference", "session_summary"] } = options
  if (docs.length === 0) return []

  const terms = tokenize(query)
  if (terms.length === 0) {
    return [...docs]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((doc) => ({ doc, score: 0 }))
  }

  const docTokens = docs.map((doc) => tokenize(doc.text))
  const lengths = docTokens.map((tokens) => tokens.length)
  const avgLength = lengths.reduce((sum, length) => sum + length, 0) / (docs.length || 1)

  const documentFrequency = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }

  const normalizedProject = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  const scored: SearchHit[] = []

  docs.forEach((doc, index) => {
    const tokens = docTokens[index]!
    const length = lengths[index] ?? 0
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)

    let score = 0
    for (const term of terms) {
      const tf = counts.get(term)
      if (!tf) continue
      const df = documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      const denom = tf + K1 * (1 - B + (B * length) / (avgLength || 1))
      score += idf * ((tf * (K1 + 1)) / (denom || 1))
    }
    if (score <= 0) return

    if (boostKinds.some((kind) => doc.kind.startsWith(kind))) score *= 1.15
    if (normalizedProject && doc.projectPath) {
      const docProject = doc.projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      if (docProject === normalizedProject) score *= 1.25
    }
    scored.push({ doc, score })
  })

  scored.sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt)
  return scored.slice(0, limit)
}

/** Formats a hit as one line for the system prompt. */
export function formatHit(hit: SearchHit): string {
  const text = hit.doc.text.replace(/\s+/g, " ").trim()
  const clipped = text.length > 240 ? `${text.slice(0, 239)}\u2026` : text
  return `- (${hit.doc.kind}) ${clipped}`
}

/**
 * Project index (RAG) — offline, self-updating search over the project's files.
 *
 * IMURUN has to answer "where does this live?" fast and without a network, an
 * embedding server, or a model call. So the index is lexical: every source file
 * is split into overlapping chunks, each chunk is tokenized, and retrieval is
 * BM25. That sounds old-fashioned next to vector search, but it is exactly the
 * right trade here — it runs in-process, it is instant, it works on a fresh
 * machine with nothing loaded, and for *code* (where identifiers are unusual
 * words with a precise spelling) lexical matching is genuinely strong.
 *
 * Keeping it current is the other half of the job. The index is not rebuilt from
 * scratch: each file records its mtime and size, so a refresh only re-reads what
 * actually changed, and the write/edit tools mark the index stale so the very
 * next search sees the edit. A snapshot is kept in ~/.imurun/rag so a new
 * session starts warm.
 *
 * Everything is capped (files, chunk size, total characters) so a huge or
 * hostile directory can never exhaust memory or stall a turn.
 */
import { readFile, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { ensureDir, imurunDir, logger, readJson, sha256, writeJsonAtomic } from "@imurun/util"
import { tokenize } from "../memory/search"
import { isIgnoredPath } from "../tool/glob"
import { isExcludedPath } from "./globs"

/** Bump when the snapshot shape changes so old snapshots are ignored. */
const RAG_VERSION = 1

/** How long a search may reuse the index before it re-checks the files. */
export const RAG_FRESH_MS = 5_000

const MAX_FILES = 3_000
const MAX_FILE_BYTES = 400 * 1024
const MAX_CHUNKS = 6_000
const MAX_INDEX_CHARS = 6 * 1024 * 1024
const MAX_CHUNK_LINES = 60
const MAX_CHUNK_CHARS = 1_600
const CHUNK_OVERLAP_LINES = 8
const MIN_CHUNK_TOKENS = 3
const MAX_EXCERPT_CHARS = 600

const K1 = 1.2
const B = 0.75

/** Source-like extensions worth indexing. */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx", "txt", "rst",
  "py", "pyi", "rb", "php", "go", "rs", "java", "kt", "kts", "swift", "scala", "lua", "dart",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cs", "fs", "fsx", "m", "mm",
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "sql", "graphql", "gql", "prisma",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "properties", "env", "editorconfig",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro", "xml", "svg",
  "csv", "tsv", "patch", "diff", "tex",
])

/** Extensionless files that are still source (or worth reading). */
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "rakefile", "procfile", "justfile", "caddyfile", "brewfile",
  "license", "licence", "notice", "readme", "changelog", "contributing", "authors", "todo",
])

/** Lock files: large, generated, and pure noise for search. */
const SKIP_FILES = /(^|\/)(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|composer\.lock|gemfile\.lock|poetry\.lock|uv\.lock|cargo\.lock)$/i

export interface RagChunk {
  path: string
  /** 1-based first line of the chunk. */
  start: number
  /** 1-based last line of the chunk. */
  end: number
  text: string
}

interface PersistedFile {
  path: string
  mtimeMs: number
  size: number
}

interface Snapshot {
  version: number
  root: string
  builtAt: number
  files: PersistedFile[]
  chunks: RagChunk[]
}

interface IndexedChunk extends RagChunk {
  terms: Map<string, number>
  length: number
}

export interface RagRefreshResult {
  /** Files newly indexed. */
  added: number
  /** Files re-read because they changed. */
  changed: number
  /** Files dropped because they disappeared. */
  removed: number
  files: number
  chunks: number
  /** False when a refresh found nothing to do. */
  changedAnything: boolean
}

export interface RagStats {
  root: string
  files: number
  chunks: number
  characters: number
  builtAt: number
  persistPath: string
}

export interface RagSearchOptions {
  limit?: number
  /** Only match chunks whose path contains this fragment. */
  path?: string
}

export interface RagSearchHit {
  path: string
  start: number
  end: number
  score: number
  excerpt: string
}

function chunkId(path: string, start: number, end: number): string {
  return `${path}:${start}-${end}`
}

/**
 * Tokenizes code the way people search for it.
 *
 * `tokenize` splits on punctuation only, which leaves `computeWidgetTotal` and
 * `MAX_RETRY_COUNT` as single opaque words. Searching for "widget" would then
 * never find the function. So identifiers are also broken at case boundaries and
 * underscores, and *both* forms are indexed: the whole identifier (so an exact
 * symbol search is precise) and its parts (so a plain word finds it).
 */
export function codeTokens(text: string): string[] {
  const whole = tokenize(text)
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$]+/g, " ")
  if (parts === text) return whole
  return [...whole, ...tokenize(parts)]
}

/** True when a project-relative path is worth putting in the index. */
export function isIndexableFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/")
  if (!normalized || isIgnoredPath(normalized)) return false
  const name = normalized.split("/").pop() ?? normalized
  if (SKIP_FILES.test(`/${name}`)) return false
  if (name.startsWith(".")) return false

  const dot = name.lastIndexOf(".")
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
  if (ext && TEXT_EXTENSIONS.has(ext)) return true
  const stem = (ext ? name.slice(0, -(ext.length + 1)) : name).toLowerCase()
  return TEXT_FILENAMES.has(stem)
}

/**
 * Splits a file into overlapping line windows.
 *
 * The overlap is what stops a function that straddles a boundary from being
 * invisible to search. Windows are bounded by both a line count and a character
 * count, because a "line" in generated or minified code can be enormous.
 */
export function chunkText(
  text: string,
  maxLines = MAX_CHUNK_LINES,
  maxChars = MAX_CHUNK_CHARS,
  overlap = CHUNK_OVERLAP_LINES,
): Array<{ start: number; end: number; text: string }> {
  const lines = text.split(/\r?\n/)
  // A file that ends with a newline would otherwise contribute a phantom final
  // line, pushing every chunk's end line one past the real content.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()

  const chunks: Array<{ start: number; end: number; text: string }> = []
  let start = 0

  while (start < lines.length) {
    let end = start
    let chars = 0
    while (end < lines.length && end - start < maxLines) {
      const width = (lines[end] ?? "").length + 1
      if (chars > 0 && chars + width > maxChars) break
      chars += width
      end++
    }
    if (end === start) end = start + 1
    const body = lines.slice(start, end).join("\n")
    if (codeTokens(body).length >= MIN_CHUNK_TOKENS) chunks.push({ start: start + 1, end, text: body })
    if (end >= lines.length) break
    start = Math.max(end - overlap, start + 1)
  }

  return chunks
}

function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of codeTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function looksBinary(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 2_048)
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true
  return false
}

/** The window of a chunk that best answers the query, clipped to a sane size. */
export function excerpt(text: string, terms: string[], maxChars = MAX_EXCERPT_CHARS): string {
  const lines = text.split("\n")
  let hit = -1
  for (let i = 0; i < lines.length; i++) {
    const tokens = new Set(codeTokens(lines[i] ?? ""))
    if (terms.some((term) => tokens.has(term))) {
      hit = i
      break
    }
  }
  const from = hit > 2 ? hit - 2 : 0
  const picked: string[] = []
  let chars = 0
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (picked.length > 0 && chars + line.length > maxChars) break
    picked.push(line)
    chars += line.length + 1
  }
  const prefix = from > 0 ? "\u2026\n" : ""
  const suffix = from + picked.length < lines.length ? "\n\u2026" : ""
  return `${prefix}${picked.join("\n").trimEnd()}${suffix}`
}

export interface RagIndexOptions {
  root: string
  persistPath?: string
  maxFiles?: number
  maxFileBytes?: number
  maxChunks?: number
  maxIndexChars?: number
  /** Lines per chunk, lines shared with the next, and a character cap. */
  chunkLines?: number
  chunkOverlapLines?: number
  chunkChars?: number
  /** Project-relative globs that are never indexed. */
  excludeGlobs?: string[]
}

/**
 * An in-memory index of one project directory, backed by a snapshot on disk.
 *
 * Lifecycle: `ensureFresh()` loads the snapshot the first time it is called and
 * then refreshes only when the index is older than the freshness window or has
 * been marked stale by a write. `search()` is pure and never touches the disk,
 * so it is safe to call in a loop.
 */
export class RagIndex {
  readonly root: string
  readonly persistPath: string

  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly maxChunks: number
  private readonly maxIndexChars: number
  private readonly chunkLines: number
  private readonly chunkOverlapLines: number
  private readonly chunkChars: number
  private readonly excludeGlobs: string[]

  private files = new Map<string, PersistedFile>()
  private chunks = new Map<string, IndexedChunk>()
  private df = new Map<string, number>()
  private chars = 0
  private builtAt = 0
  private loaded = false
  private stale = false
  private savedAt = 0

  constructor(options: RagIndexOptions) {
    this.root = resolve(options.root)
    this.persistPath = options.persistPath ?? snapshotPath(this.root)
    this.maxFiles = options.maxFiles ?? MAX_FILES
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
    this.maxChunks = options.maxChunks ?? MAX_CHUNKS
    this.maxIndexChars = options.maxIndexChars ?? MAX_INDEX_CHARS
    this.chunkLines = options.chunkLines ?? MAX_CHUNK_LINES
    this.chunkOverlapLines = options.chunkOverlapLines ?? CHUNK_OVERLAP_LINES
    this.chunkChars = options.chunkChars ?? MAX_CHUNK_CHARS
    this.excludeGlobs = options.excludeGlobs ?? []
  }

  /** Forces the next `ensureFresh` to re-check the files. */
  markStale(): void {
    this.stale = true
  }

  /**
   * Loads the snapshot if needed, then refreshes when the index is old or has
   * been invalidated. Returns undefined when the index was already fresh.
   */
  async ensureFresh(options: { maxAgeMs?: number } = {}): Promise<RagRefreshResult | undefined> {
    const maxAgeMs = options.maxAgeMs ?? RAG_FRESH_MS
    if (!this.loaded) await this.load()
    if (!this.stale && this.builtAt > 0 && Date.now() - this.builtAt <= maxAgeMs) return undefined
    return this.refresh()
  }

  /** Re-reads only the files that changed, then persists the snapshot. */
  async refresh(): Promise<RagRefreshResult> {
    const candidates = await this.scan()

    const added: string[] = []
    const changed: string[] = []
    const removed: string[] = []

    for (const path of this.files.keys()) if (!candidates.has(path)) removed.push(path)
    for (const [path, meta] of candidates) {
      const existing = this.files.get(path)
      if (!existing) added.push(path)
      else if (existing.mtimeMs !== meta.mtimeMs || existing.size !== meta.size) changed.push(path)
    }

    for (const path of removed) this.dropFile(path)

    let touched = 0
    for (const path of [...added, ...changed]) {
      if (this.chunks.size >= this.maxChunks || this.chars >= this.maxIndexChars) break
      if (await this.indexFile(path)) touched++
    }

    // Files skipped because the budget was already spent still get their
    // metadata recorded, so a refresh never re-reads them. The caps are a hard
    // limit: past them the index simply covers fewer files.
    for (const path of added) {
      if (!this.files.has(path)) {
        const meta = candidates.get(path)
        if (meta) this.files.set(path, { path, mtimeMs: meta.mtimeMs, size: meta.size })
      }
    }

    this.rebuildDf()
    this.builtAt = Date.now()
    this.loaded = true
    this.stale = false

    const changedAnything = added.length + changed.length + removed.length > 0
    if (changedAnything || Date.now() - this.savedAt > 60_000) await this.save()

    if (changedAnything) {
      logger.debug(
        `rag index ${this.root}: +${added.length} ~${changed.length} -${removed.length} (${this.chunks.size} chunks, ${touched} read)`,
      )
    }
    return {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      files: this.files.size,
      chunks: this.chunks.size,
      changedAnything,
    }
  }

  /** BM25 over the indexed chunks. Pure: never reads or writes files. */
  search(query: string, options: RagSearchOptions = {}): RagSearchHit[] {
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 40)
    const terms = codeTokens(query)
    if (terms.length === 0 || this.chunks.size === 0) return []

    const total = this.chunks.size
    let totalLength = 0
    for (const chunk of this.chunks.values()) totalLength += chunk.length
    const average = totalLength / total

    const prefix = options.path?.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
    const hits: RagSearchHit[] = []

    for (const chunk of this.chunks.values()) {
      if (prefix && !chunk.path.toLowerCase().includes(prefix)) continue

      let score = 0
      let matched = 0
      for (const term of terms) {
        const tf = chunk.terms.get(term)
        if (!tf) continue
        matched++
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.length) / (average || 1))))
      }
      if (score <= 0) continue

      // A chunk that covers more of the question beats one that repeats a word,
      // and a hit in the path itself (naming the file we are looking for) wins.
      score *= 1 + 0.25 * (matched - 1)
      const lowerPath = chunk.path.toLowerCase()
      if (terms.some((term) => lowerPath.includes(term))) score *= 1.4

      hits.push({
        path: chunk.path,
        start: chunk.start,
        end: chunk.end,
        score,
        excerpt: excerpt(chunk.text, terms),
      })
    }

    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start)
    return hits.slice(0, limit)
  }

  stats(): RagStats {
    return {
      root: this.root,
      files: this.files.size,
      chunks: this.chunks.size,
      characters: this.chars,
      builtAt: this.builtAt,
      persistPath: this.persistPath,
    }
  }

  /** Forgets everything, on disk and in memory. */
  async clear(): Promise<void> {
    this.files.clear()
    this.chunks.clear()
    this.df.clear()
    this.chars = 0
    this.builtAt = 0
    this.savedAt = 0
    this.loaded = true
    this.stale = true
    await rm(this.persistPath, { force: true })
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    this.loaded = true
    const snapshot = await readJson<Snapshot>(this.persistPath)
    if (!snapshot || snapshot.version !== RAG_VERSION || snapshot.root !== this.root) return

    this.builtAt = snapshot.builtAt ?? 0
    this.files = new Map((snapshot.files ?? []).map((file) => [file.path, file]))
    this.chunks = new Map()
    this.chars = 0

    let skipped = 0
    for (const chunk of snapshot.chunks ?? []) {
      if (!chunk?.text) continue
      if (this.chunks.size >= this.maxChunks) {
        skipped++
        continue
      }
      const terms = termCounts(chunk.text)
      let length = 0
      for (const count of terms.values()) length += count
      this.chunks.set(chunkId(chunk.path, chunk.start, chunk.end), { ...chunk, terms, length })
      this.chars += chunk.text.length
    }
    // Files whose chunks were dropped by the cap would otherwise look indexed.
    if (skipped > 0) this.stale = true

    this.rebuildDf()
  }

  private async save(): Promise<void> {
    const snapshot: Snapshot = {
      version: RAG_VERSION,
      root: this.root,
      builtAt: this.builtAt,
      files: [...this.files.values()],
      chunks: [...this.chunks.values()].map(({ path, start, end, text }) => ({ path, start, end, text })),
    }
    await ensureDir(dirname(this.persistPath))
    await writeJsonAtomic(this.persistPath, snapshot, false)
    this.savedAt = Date.now()
  }

  private async scan(): Promise<Map<string, { mtimeMs: number; size: number }>> {
    const out = new Map<string, { mtimeMs: number; size: number }>()
    const glob = new Bun.Glob("**/*")
    const candidates: string[] = []

    try {
      for await (const file of glob.scan({ cwd: this.root, onlyFiles: true, dot: false })) {
        const normalized = file.replace(/\\/g, "/")
        if (isExcludedPath(normalized, this.excludeGlobs)) continue
        if (isIndexableFile(normalized)) candidates.push(normalized)
      }
    } catch (error) {
      logger.warn(`rag: could not scan ${this.root}: ${(error as Error).message}`)
      return out
    }

    // Deterministic order, so the file cap always keeps the same files.
    candidates.sort()
    for (const rel of candidates) {
      if (out.size >= this.maxFiles) break
      try {
        const info = await stat(resolve(this.root, rel))
        if (!info.isFile() || info.size > this.maxFileBytes) continue
        out.set(rel, { mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // vanished mid-scan
      }
    }
    return out
  }

  private dropFile(path: string): void {
    const file = this.files.get(path)
    this.files.delete(path)
    if (!file) return
    for (const key of [...this.chunks.keys()]) {
      const chunk = this.chunks.get(key)
      if (!chunk || chunk.path !== path) continue
      this.chars -= chunk.text.length
      this.chunks.delete(key)
    }
  }

  /** Reads one file and replaces its chunks. Returns false if it had no text. */
  private async indexFile(path: string): Promise<boolean> {
    const full = resolve(this.root, path)
    let info: { mtimeMs: number; size: number }
    let data: Buffer
    try {
      const stats = await stat(full)
      info = { mtimeMs: stats.mtimeMs, size: stats.size }
      data = await readFile(full)
    } catch {
      return false
    }

    this.dropFile(path)
    this.files.set(path, { path, ...info })
    if (looksBinary(data)) return false

    const pieces = chunkText(data.toString("utf8"), this.chunkLines, this.chunkChars, this.chunkOverlapLines)
    for (const piece of pieces) {
      if (this.chunks.size >= this.maxChunks || this.chars >= this.maxIndexChars) break
      const terms = termCounts(piece.text)
      let length = 0
      for (const count of terms.values()) length += count
      this.chunks.set(chunkId(path, piece.start, piece.end), { path, ...piece, terms, length })
      this.chars += piece.text.length
    }
    return true
  }

  private rebuildDf(): void {
    this.df = new Map()
    for (const chunk of this.chunks.values()) {
      for (const term of chunk.terms.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }
  }
}

/** Where a project's snapshot lives: ~/.imurun/rag/<name>-<hash>.json */
export function snapshotPath(root: string): string {
  const absolute = resolve(root)
  const name = basename(absolute).replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() || "project"
  return join(imurunDir("rag"), `${name}-${sha256(absolute).slice(0, 10)}.json`)
}

const cache = new Map<string, RagIndex>()

/** The shared index for a project directory (one per process, per root). */
export function getRagIndex(root: string, options: Omit<RagIndexOptions, "root"> = {}): RagIndex {
  const key = resolve(root)
  const existing = cache.get(key)
  if (existing) return existing
  const index = new RagIndex({ root: key, ...options })
  cache.set(key, index)
  return index
}

/**
 * Marks a project's index stale — called by write/edit so a search that follows
 * an edit always sees the new contents rather than the indexed version.
 */
export function invalidateRag(root: string): void {
  cache.get(resolve(root))?.markStale()
}

/** Drops cached indexes (tests, and `imurun rag clear`). */
export function clearRagCache(): void {
  cache.clear()
}

/** Formats one hit for a tool result. */
export function formatRagHit(hit: RagSearchHit): string {
  const header = `${hit.path}:${hit.start}-${hit.end}  (score ${hit.score.toFixed(1)})`
  const body = hit.excerpt
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
  return `${header}\n${body}`
}

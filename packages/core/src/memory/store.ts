/**
 * Memory store — everything IMURUN remembers between sessions.
 *
 * Layout under `~/.imurun/memory/`:
 *
 *   notes.md              durable notes, human-readable and editable
 *   index.json            machine index (notes + session digests)
 *   sessions/<id>.md      one digest per session, written on compaction/close
 *
 * The markdown files are the durable record — a person can read them, and the
 * RAG indexer ingests them as ordinary documents — while `index.json` keeps
 * retrieval fast without walking the tree. If the index is ever lost or
 * corrupted it is rebuilt from `notes.md`.
 */
import { join } from "node:path"
import { ensureDir, imurunDir, newId, readJson, writeJsonAtomic, writeFileAtomic, readText, removeIfExists } from "@imurun/util"
import type { Session } from "@imurun/schema"
import type { Message } from "@imurun/schema"
import { NOTE_KINDS, type NoteKind } from "@imurun/schema"
import { bm25Search, formatHit, type SearchDoc, type SearchHit, type SearchOptions } from "./search"
import { rankByRetention } from "./retention"
import { buildDigest, digestToMarkdown, type SessionDigest } from "./summarize"
import { isSealed, openSecret, sealSecret } from "./vault"

/** Note kinds are the schema's list minus the session-digest document kind. */
export type MemoryKind = NoteKind

export interface MemoryRecord {
  id: string
  kind: MemoryKind
  text: string
  tags: string[]
  /** Project the note belongs to; omitted means global. */
  projectPath?: string
  sessionId?: string
  createdAt: number
  updatedAt: number
  /** How many times recall has surfaced this note. */
  usageCount: number
}

export interface RememberInput {
  text: string
  kind?: MemoryKind
  tags?: string[]
  projectPath?: string
  sessionId?: string
}

export interface MemoryStats {
  notes: number
  sessions: number
  todos: number
  byKind: Record<string, number>
  path: string
}

interface MemoryIndexFile {
  version: number
  notes: MemoryRecord[]
  digests: SessionDigest[]
}

const INDEX_VERSION = 1

const NOTES_HEADER = `# IMURUN memory

Durable notes IMURUN keeps across sessions. This file is yours: add, edit or
delete lines freely. Each line has the form:

    - [kind] text — tags: a, b

Valid kinds: ${NOTE_KINDS.join(", ")}. A [credential] line is encrypted, so it
reads as enc:{"v":1,...} here — IMURUN decrypts it with the machine key in
~/.imurun/key when it needs it. IMURUN rewrites this file when it learns
something new; anything you keep here is picked up again automatically.

`

export function memoryRoot(): string {
  return imurunDir("memory")
}

export class MemoryStore {
  readonly dir: string
  private cache?: MemoryIndexFile

  constructor(dir: string = memoryRoot()) {
    this.dir = dir
  }

  private get indexPath(): string {
    return join(this.dir, "index.json")
  }

  private get notesPath(): string {
    return join(this.dir, "notes.md")
  }

  private sessionPath(sessionId: string): string {
    return join(this.dir, "sessions", `${sessionId}.md`)
  }

  // ── Loading / saving ──────────────────────────────────────────────────────

  async load(force = false): Promise<MemoryIndexFile> {
    if (this.cache && !force) return this.cache

    const file = await readJson<MemoryIndexFile>(this.indexPath)
    if (file && Array.isArray(file.notes) && Array.isArray(file.digests)) {
      await this.unseal(file.notes)
      this.cache = file
      return file
    }

    // Index missing or corrupt: rebuild whatever we can from the markdown.
    const notes = await this.parseNotesMarkdown()
    this.cache = { version: INDEX_VERSION, notes, digests: [] }
    return this.cache
  }

  /** Decrypts any sealed credential in place, so callers only see plaintext. */
  private async unseal(notes: MemoryRecord[]): Promise<void> {
    for (const note of notes) {
      if (note.kind !== "credential" || !isSealed(note.text)) continue
      const plain = await openSecret(note.text)
      if (plain !== undefined) note.text = plain
    }
  }

  /**
   * The form of a note that may be written to disk: credentials are sealed, so
   * a copy of notes.md never carries the secret in the clear.
   */
  private async sealForDisk(note: MemoryRecord): Promise<MemoryRecord> {
    if (note.kind !== "credential" || isSealed(note.text)) return note
    return { ...note, text: await sealSecret(note.text) }
  }

  private async save(): Promise<void> {
    const file = this.cache ?? (await this.load())
    await ensureDir(this.dir)
    const sealed: MemoryRecord[] = []
    for (const note of file.notes) sealed.push(await this.sealForDisk(note))
    await writeJsonAtomic(this.indexPath, { ...file, notes: sealed })
    await writeFileAtomic(this.notesPath, this.renderNotesMarkdown(sealed))
  }

  private renderNotesMarkdown(notes: MemoryRecord[]): string {
    const lines = [NOTES_HEADER]
    if (notes.length === 0) {
      lines.push("_No notes yet._\n")
      return lines.join("\n")
    }
    const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const note of sorted) {
      const tags = note.tags.length > 0 ? ` \u2014 tags: ${note.tags.join(", ")}` : ""
      const where = note.projectPath ? ` \u2014 project: ${note.projectPath}` : ""
      lines.push(`- [${note.kind}] ${note.text}${tags}${where}`)
    }
    lines.push("")
    return lines.join("\n")
  }

  private async parseNotesMarkdown(): Promise<MemoryRecord[]> {
    let raw: string
    try {
      raw = await readText(this.notesPath)
    } catch {
      return []
    }

    const notes: MemoryRecord[] = []
    const now = Date.now()
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*[-*]\s*\[([a-z_]+)\]\s*(.+)$/i.exec(line)
      if (!match) continue
      const kind = match[1]!.toLowerCase()
      // An unknown kind (or the digest kind) is not a note; leave it alone
      // rather than inventing a note with a kind nothing understands.
      if (!(NOTE_KINDS as readonly string[]).includes(kind)) continue
      let text = match[2]!.trim()
      let projectPath: string | undefined
      const tags: string[] = []

      const tagsMatch = /\s+\u2014\s+tags:\s*(.+)$/i.exec(text)
      if (tagsMatch) {
        text = text.slice(0, tagsMatch.index).trim()
        for (const tag of tagsMatch[1]!.split(",")) {
          const clean = tag.trim()
          if (clean) tags.push(clean)
        }
      }
      const projectMatch = /\s+\u2014\s+project:\s*(.+)$/i.exec(text)
      if (projectMatch) {
        text = text.slice(0, projectMatch.index).trim()
        projectPath = projectMatch[1]!.trim()
      }
      if (!text) continue

      notes.push({
        id: newId("mem"),
        kind: kind as MemoryKind,
        text,
        tags,
        projectPath,
        createdAt: now,
        updatedAt: now,
        usageCount: 0,
      })
    }
    await this.unseal(notes)
    return notes
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  async all(): Promise<MemoryRecord[]> {
    return (await this.load()).notes
  }

  /** Adds a note, merging it with an identical one if it already exists. */
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const file = await this.load()
    const text = input.text.replace(/\s+/g, " ").trim()
    const now = Date.now()
    const existing = file.notes.find((note) => note.text === text)
    if (existing) {
      existing.updatedAt = now
      existing.kind = input.kind ?? existing.kind
      for (const tag of input.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag)
      await this.save()
      return existing
    }

    const note: MemoryRecord = {
      id: newId("mem"),
      kind: input.kind ?? "note",
      text,
      tags: input.tags ?? [],
      projectPath: input.projectPath,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
    }
    file.notes.push(note)
    await this.save()
    return note
  }

  /** Removes notes matching an id or a text fragment. Returns the count removed. */
  async forget(ref: string): Promise<number> {
    const file = await this.load()
    const needle = ref.toLowerCase()
    const before = file.notes.length
    file.notes = file.notes.filter(
      (note) => note.id !== ref && !note.text.toLowerCase().includes(needle),
    )
    const removed = before - file.notes.length
    if (removed > 0) await this.save()
    return removed
  }

  // ── Digests ───────────────────────────────────────────────────────────────

  /** Upserts a session digest: index entry + `sessions/<id>.md`. */
  async saveDigest(digest: SessionDigest): Promise<SessionDigest> {
    const file = await this.load()
    const index = file.digests.findIndex((entry) => entry.sessionId === digest.sessionId)
    if (index >= 0) file.digests[index] = digest
    else file.digests.push(digest)

    // keep the newest 200 sessions so the index stays small
    if (file.digests.length > 200) {
      file.digests.sort((a, b) => b.updatedAt - a.updatedAt)
      file.digests = file.digests.slice(0, 200)
    }

    await this.save()
    await writeFileAtomic(this.sessionPath(digest.sessionId), digestToMarkdown(digest))
    return digest
  }

  /**
   * Summarizes a session's messages and persists the digest. `previous` (the
   * digest already on disk) supplies carry-forward todos.
   */
  async summarize(
    session: Pick<Session, "id" | "title" | "workingDir" | "model" | "createdAt" | "updatedAt">,
    messages: Message[],
  ): Promise<SessionDigest> {
    const previous = await this.getDigest(session.id)
    const digest = buildDigest({
      sessionId: session.id,
      title: session.title,
      workingDir: session.workingDir,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages,
      previous,
    })
    return this.saveDigest(digest)
  }

  async getDigest(sessionId: string): Promise<SessionDigest | undefined> {
    return (await this.load()).digests.find((entry) => entry.sessionId === sessionId)
  }

  /** Path of the markdown digest written for a session. */
  sessionFile(sessionId: string): string {
    return this.sessionPath(sessionId)
  }

  async digests(): Promise<SessionDigest[]> {
    return (await this.load()).digests
  }

  /** Open todos across everything IMURUN remembers, newest first. */
  async openTodos(projectPath?: string): Promise<string[]> {
    const file = await this.load()
    const out: string[] = []
    const normalized = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

    const relevant = [...file.digests].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const digest of relevant) {
      if (normalized) {
        const project = digest.workingDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
        if (project !== normalized) continue
      }
      for (const todo of digest.todos) if (!out.includes(todo)) out.push(todo)
    }
    for (const note of file.notes) {
      if (note.kind !== "todo") continue
      if (normalized && note.projectPath) {
        const project = note.projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
        if (project !== normalized) continue
      }
      if (!out.includes(note.text)) out.push(note.text)
    }
    return out
  }

  // ── Retrieval ─────────────────────────────────────────────────────────────

  /** Search docs for notes and session digests, ready for the ranker. */
  private async searchDocs(sources?: Array<"note" | "session">): Promise<SearchDoc[]> {
    const file = await this.load()
    const docs: SearchDoc[] = []
    const wantNotes = !sources || sources.includes("note")
    const wantSessions = !sources || sources.includes("session")

    if (wantNotes) {
      for (const note of file.notes) {
        docs.push({
          id: note.id,
          text: `${note.kind} ${note.text} ${note.tags.join(" ")}`,
          kind: note.kind,
          source: "note",
          projectPath: note.projectPath,
          updatedAt: note.updatedAt,
        })
      }
    }
    if (wantSessions) {
      for (const digest of file.digests) {
        const parts = [
          digest.title,
          digest.highlights.join(" "),
          digest.done.join(" "),
          digest.files.join(" "),
          digest.commands.join(" "),
          digest.todos.join(" "),
        ]
        docs.push({
          id: digest.sessionId,
          text: parts.join(" "),
          kind: "session_summary",
          source: "session",
          projectPath: digest.workingDir,
          updatedAt: digest.updatedAt,
        })
      }
    }
    return docs
  }

  /** BM25 recall over everything remembered. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const docs = await this.searchDocs(options.sources)
    const hits = bm25Search(docs, query, options)
    await this.touchNotes(hits)
    return hits
  }

  /**
   * Records that recall surfaced these notes. The count feeds retention: a note
   * that keeps being useful stays pinned, one nobody touches fades on schedule.
   */
  private async touchNotes(hits: readonly SearchHit[]): Promise<void> {
    const ids = new Set(hits.filter((hit) => hit.doc.source === "note").map((hit) => hit.doc.id))
    if (ids.size === 0) return
    const file = await this.load()
    let changed = false
    for (const note of file.notes) {
      if (!ids.has(note.id)) continue
      note.usageCount++
      changed = true
    }
    if (changed) await this.save()
  }

  /**
   * Durable notes worth pinning into every prompt: things the user explicitly
   * asked to remember, scoped to the active project plus global notes.
   *
   * Credentials are deliberately left out: a secret belongs in memory for the
   * model to look up, not in the system prompt of every turn.
   */
  async durable(projectPath?: string, limit = 8): Promise<string[]> {
    const file = await this.load()
    const normalized = projectPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

    return rankByRetention(
      file.notes
        .filter((note) => note.kind !== "note" && note.kind !== "credential")
        .filter((note) => {
          if (!note.projectPath) return true
          if (!normalized) return true
          return note.projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === normalized
        }),
    )
      .slice(0, limit)
      .map((note) => `(${note.kind}) ${note.text}`)
  }

  async stats(): Promise<MemoryStats> {
    const file = await this.load()
    const byKind: Record<string, number> = {}
    for (const note of file.notes) byKind[note.kind] = (byKind[note.kind] ?? 0) + 1
    const todos = file.digests.reduce((sum, digest) => sum + digest.todos.length, 0)
    return { notes: file.notes.length, sessions: file.digests.length, todos, byKind, path: this.dir }
  }

  /** Forgets one session's digest (both the index entry and the markdown). */
  async forgetSession(sessionId: string): Promise<boolean> {
    const file = await this.load()
    const before = file.digests.length
    file.digests = file.digests.filter((entry) => entry.sessionId !== sessionId)
    if (file.digests.length === before) return false
    await this.save()
    await removeIfExists(this.sessionPath(sessionId))
    return true
  }
}

/** Formats recall hits as system-prompt bullet lines. */
export function formatHits(hits: SearchHit[], options: { maskSecrets?: boolean } = {}): string[] {
  return hits.map((hit) => formatHit(hit, options))
}

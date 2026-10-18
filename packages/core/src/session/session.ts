/**
 * Session store — persistent sessions and messages backed by SQLite.
 *
 * Sessions are the unit of conversation: every chat, one-shot run, subagent,
 * and compaction output lives in a session with its full message history.
 */
import type { ContentPart, Message, MessageUsage, Session, SessionSummary, ToolCall } from "@imurun/schema"
import { MessageMetadata } from "@imurun/schema"
import { logger, newId, truncate } from "@imurun/util"
import type { ImurunDatabase } from "../storage/database"

export interface CreateSessionInput {
  title?: string
  model?: string
  workingDir: string
  parentSessionId?: string
}

export interface AddMessageInput {
  sessionId: string
  role: Message["role"]
  content: string | ContentPart[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  usage?: MessageUsage
  metadata?: Message["metadata"]
}

export interface ListSessionsOptions {
  limit?: number
  offset?: number
  /** Include sessions whose workingDir matches this path (normalized). */
  workingDir?: string
}

interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  model: string | null
  working_dir: string
  summary: string | null
  topics: string
  parent_session_id: string | null
  message_count: number
  total_input_tokens: number
  total_output_tokens: number
}

interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  tool_calls: string | null
  tool_call_id: string | null
  created_at: number
  usage: string | null
  metadata: string | null
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model ?? undefined,
    workingDir: row.working_dir,
    summary: row.summary ?? undefined,
    topics: JSON.parse(row.topics) as string[],
    parentSessionId: row.parent_session_id ?? undefined,
    messageCount: row.message_count,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
  }
}

function rowToMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as Message["role"],
    content: JSON.parse(row.content) as string | ContentPart[],
    createdAt: row.created_at,
  }
  if (row.tool_calls) message.toolCalls = JSON.parse(row.tool_calls) as ToolCall[]
  if (row.tool_call_id) message.toolCallId = row.tool_call_id
  if (row.usage) message.usage = JSON.parse(row.usage) as MessageUsage
  if (row.metadata) {
    const parsed = MessageMetadata.safeParse(JSON.parse(row.metadata))
    if (parsed.success) message.metadata = parsed.data
  }
  return message
}

/** Derives a human title from the first user message. */
export function deriveTitle(text: string, max = 60): string {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return "New session"
  return truncate(cleaned, max)
}

export class SessionStore {
  constructor(private readonly store: ImurunDatabase) {}

  // ── Sessions ────────────────────────────────────────────────────────────

  create(input: CreateSessionInput): Session {
    const now = Date.now()
    const session: Session = {
      id: newId("ses"),
      title: input.title ?? "New session",
      createdAt: now,
      updatedAt: now,
      model: input.model,
      workingDir: input.workingDir,
      topics: [],
      parentSessionId: input.parentSessionId,
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }

    this.store.sqlite
      .query(
        `INSERT INTO sessions (id, title, created_at, updated_at, model, working_dir, topics, parent_session_id, message_count, total_input_tokens, total_output_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', ?7, 0, 0, 0)`,
      )
      .run(
        session.id,
        session.title,
        session.createdAt,
        session.updatedAt,
        session.model ?? null,
        session.workingDir,
        session.parentSessionId ?? null,
      )

    this.store.logEvent("session.created", session.id, { title: session.title })
    logger.debug(`session created: ${session.id}`)
    return session
  }

  get(id: string): Session | undefined {
    const row = this.store.sqlite
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?1")
      .get(id)
    return row ? rowToSession(row) : undefined
  }

  /** Most recently updated session, optionally scoped to a working dir. */
  latest(workingDir?: string): Session | undefined {
    const row = this.store.sqlite
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC")
      .all()
      .find((r) => !workingDir || normalizeDir(r.working_dir) === normalizeDir(workingDir))
    return row ? rowToSession(row) : undefined
  }

  list(options: ListSessionsOptions = {}): SessionSummary[] {
    const { limit = 20, offset = 0, workingDir } = options
    const rows = this.store.sqlite
      .query<SessionRow, []>("SELECT * FROM sessions ORDER BY updated_at DESC")
      .all()

    const filtered = workingDir
      ? rows.filter((r) => normalizeDir(r.working_dir) === normalizeDir(workingDir))
      : rows

    return filtered.slice(offset, offset + limit).map((row) => {
      const session = rowToSession(row)
      return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        model: session.model,
        messageCount: session.messageCount,
      }
    })
  }

  update(
    id: string,
    patch: Partial<Pick<Session, "title" | "model" | "summary" | "topics">>,
  ): void {
    const existing = this.get(id)
    if (!existing) throw new Error(`Session not found: ${id}`)
    const next = { ...existing, ...patch, updatedAt: Date.now() }

    this.store.sqlite
      .query("UPDATE sessions SET title = ?2, model = ?3, summary = ?4, topics = ?5, updated_at = ?6 WHERE id = ?1")
      .run(
        id,
        next.title,
        next.model ?? null,
        next.summary ?? null,
        JSON.stringify(next.topics),
        next.updatedAt,
      )
    this.store.logEvent("session.updated", id, patch as unknown)
  }

  /** Bumps updated_at without changing content. */
  touch(id: string): void {
    this.store.sqlite.query("UPDATE sessions SET updated_at = ?2 WHERE id = ?1").run(id, Date.now())
  }

  delete(id: string): void {
    this.store.sqlite.query("DELETE FROM sessions WHERE id = ?1").run(id)
    logger.debug(`session deleted: ${id}`)
  }

  // ── Messages ────────────────────────────────────────────────────────────

  addMessage(input: AddMessageInput): Message {
    const message: Message = {
      id: newId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: Date.now(),
    }
    if (input.toolCalls) message.toolCalls = input.toolCalls
    if (input.toolCallId) message.toolCallId = input.toolCallId
    if (input.usage) message.usage = input.usage
    if (input.metadata) message.metadata = input.metadata

    const tx = this.store.sqlite.transaction(() => {
      this.store.sqlite
        .query(
          `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at, usage, metadata)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          message.id,
          message.sessionId,
          message.role,
          JSON.stringify(message.content),
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.toolCallId ?? null,
          message.createdAt,
          message.usage ? JSON.stringify(message.usage) : null,
          message.metadata ? JSON.stringify(message.metadata) : null,
        )

      const inputTokens = input.usage?.inputTokens ?? 0
      const outputTokens = input.usage?.outputTokens ?? 0

      this.store.sqlite
        .query(
          `UPDATE sessions
           SET message_count = message_count + 1,
               total_input_tokens = total_input_tokens + ?2,
               total_output_tokens = total_output_tokens + ?3,
               updated_at = ?4
           WHERE id = ?1`,
        )
        .run(input.sessionId, inputTokens, outputTokens, message.createdAt)

      // First user message becomes the session title
      if (input.role === "user") {
        const session = this.get(input.sessionId)
        if (session && (session.title === "New session" || session.title === "")) {
          const text = typeof input.content === "string" ? input.content : ""
          if (text) {
            this.store.sqlite
              .query("UPDATE sessions SET title = ?2 WHERE id = ?1")
              .run(input.sessionId, deriveTitle(text))
          }
        }
      }
    })
    tx()

    return message
  }

  getMessages(sessionId: string, options: { limit?: number; offset?: number } = {}): Message[] {
    const { limit, offset = 0 } = options
    const rows = this.store.sqlite
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE session_id = ?1 ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId)
    const sliced = limit !== undefined ? rows.slice(offset, offset + limit) : rows.slice(offset)
    return sliced.map(rowToMessage)
  }

  /** Messages in reverse-chronological order — used by context assembly. */
  getRecentMessages(sessionId: string, count: number): Message[] {
    const rows = this.store.sqlite
      .query<MessageRow, [string, number]>(
        "SELECT * FROM messages WHERE session_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2",
      )
      .all(sessionId, count)
    return rows.reverse().map(rowToMessage)
  }

  countMessages(sessionId: string): number {
    const row = this.store.sqlite
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?1")
      .get(sessionId)
    return row?.n ?? 0
  }

  deleteMessage(id: string, sessionId: string): void {
    const tx = this.store.sqlite.transaction(() => {
      this.store.sqlite.query("DELETE FROM messages WHERE id = ?1").run(id)
      this.store.sqlite
        .query("UPDATE sessions SET message_count = MAX(message_count - 1, 0), updated_at = ?2 WHERE id = ?1")
        .run(sessionId, Date.now())
    })
    tx()
  }
}

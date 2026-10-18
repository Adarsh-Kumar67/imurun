/**
 * Drizzle table definitions for the IMURUN database.
 *
 * Tables arrive milestone by milestone via migrations:
 *   001 init           — sessions, messages, events, kv, permissions
 *   002 memory         — memories, credentials (M7)
 *   003 rag            — rag_chunks, rag_vectors (M8)
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const sessionsTable = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    model: text("model"),
    workingDir: text("working_dir").notNull(),
    summary: text("summary"),
    /** JSON array of topic strings. */
    topics: text("topics").notNull().default("[]"),
    parentSessionId: text("parent_session_id"),
    messageCount: integer("message_count").notNull().default(0),
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  },
  (t) => [index("sessions_updated_idx").on(t.updatedAt)],
)

export const messagesTable = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessionsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    /** JSON: string or ContentPart[]. */
    content: text("content").notNull(),
    /** JSON: ToolCall[]. */
    toolCalls: text("tool_calls"),
    toolCallId: text("tool_call_id"),
    createdAt: integer("created_at").notNull(),
    /** JSON: MessageUsage. */
    usage: text("usage"),
    /** JSON: MessageMetadata. */
    metadata: text("metadata"),
  },
  (t) => [index("messages_session_idx").on(t.sessionId, t.createdAt)],
)

export const eventsTable = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    sessionId: text("session_id"),
    /** JSON payload. */
    data: text("data"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("events_session_idx").on(t.sessionId), index("events_type_idx").on(t.type)],
)

export const kvTable = sqliteTable("kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const permissionsTable = sqliteTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    pattern: text("pattern"),
    action: text("action").notNull(),
    scope: text("scope").notNull().default("global"),
    projectPath: text("project_path"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("permissions_tool_idx").on(t.tool)],
)

export const schema = {
  sessionsTable,
  messagesTable,
  eventsTable,
  kvTable,
  permissionsTable,
}

export type DatabaseSchema = typeof schema

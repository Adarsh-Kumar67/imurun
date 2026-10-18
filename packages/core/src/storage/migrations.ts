/**
 * Migration runner — plain SQL migrations applied in order, tracked in the
 * _migrations table. Each migration runs inside a transaction.
 */
import type { Database as BunDatabase } from "bun:sqlite"

export interface Migration {
  id: string
  sql: string
}

export const migrations: Migration[] = [
  {
    id: "001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT,
        working_dir TEXT NOT NULL,
        summary TEXT,
        topics TEXT NOT NULL DEFAULT '[]',
        parent_session_id TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions (updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        usage TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, created_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        session_id TEXT,
        data TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id);
      CREATE INDEX IF NOT EXISTS events_type_idx ON events (type);

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        pattern TEXT,
        action TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        project_path TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS permissions_tool_idx ON permissions (tool);
    `,
  },
]

export function runMigrations(sqlite: BunDatabase): { applied: string[] } {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  const done = new Set(
    sqlite
      .query<{ id: string }, []>("SELECT id FROM _migrations")
      .all()
      .map((row) => row.id),
  )

  const applied: string[] = []
  const record = sqlite.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?1, ?2)")

  for (const migration of migrations) {
    if (done.has(migration.id)) continue
    const tx = sqlite.transaction(() => {
      sqlite.exec(migration.sql)
      record.run(migration.id, Date.now())
    })
    tx()
    applied.push(migration.id)
  }

  return { applied }
}

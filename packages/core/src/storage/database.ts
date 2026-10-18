/**
 * Database — opens a SQLite database (bun:sqlite, no native build needed),
 * applies migrations, and exposes drizzle for typed queries plus small KV and
 * event-log helpers.
 */
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite"
import { dirname } from "node:path"
import { ensureDir, logger, sha256 } from "@imurun/util"
import { schema, type DatabaseSchema } from "./schema"
import { runMigrations } from "./migrations"
import { imurunDir } from "@imurun/util"

export type ImurunDrizzle = BunSQLiteDatabase<DatabaseSchema>

export interface OpenDatabaseOptions {
  /** Skip migrations (tests that only inspect pragmas). */
  skipMigrations?: boolean
  /** Open read-only. */
  readonly?: boolean
}

export class ImurunDatabase {
  readonly sqlite: BunDatabase
  readonly db: ImurunDrizzle
  readonly path: string

  private constructor(path: string, options: OpenDatabaseOptions) {
    this.path = path
    this.sqlite = new BunDatabase(path, options.readonly ? { readonly: true } : undefined)
    this.sqlite.exec("PRAGMA journal_mode = WAL;")
    this.sqlite.exec("PRAGMA foreign_keys = ON;")
    this.sqlite.exec("PRAGMA busy_timeout = 5000;")
    this.sqlite.exec("PRAGMA synchronous = NORMAL;")
    this.db = drizzle(this.sqlite, { schema })
    if (!options.skipMigrations && !options.readonly) {
      const { applied } = runMigrations(this.sqlite)
      if (applied.length > 0) logger.debug(`migrations applied: ${applied.join(", ")}`, this.path)
    }
  }

  /** Opens (creating if needed) the database at an explicit path. */
  static async open(path: string, options: OpenDatabaseOptions = {}): Promise<ImurunDatabase> {
    await ensureDir(dirname(path))
    return new ImurunDatabase(path, options)
  }

  /** Opens the global IMURUN database (~/.imurun/data/imurun.db). */
  static async openGlobal(options: OpenDatabaseOptions = {}): Promise<ImurunDatabase> {
    return ImurunDatabase.open(imurunDir("data", "imurun.db"), options)
  }

  /**
   * Opens the per-project database (~/.imurun/data/projects/<hash>.db).
   * Each working directory gets its own sessions, isolated from other projects.
   */
  static async openProject(workingDir: string, options: OpenDatabaseOptions = {}): Promise<ImurunDatabase> {
    const key = sha256(workingDir.replace(/\\/g, "/").toLowerCase()).slice(0, 16)
    return ImurunDatabase.open(imurunDir("data", "projects", `${key}.db`), options)
  }

  get(key: string): string | undefined {
    const row = this.sqlite.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?1").get(key)
    return row?.value
  }

  set(key: string, value: string): void {
    this.sqlite
      .query("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
      .run(key, value, Date.now())
  }

  getJson<T>(key: string): T | undefined {
    const raw = this.get(key)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value))
  }

  deleteKey(key: string): void {
    this.sqlite.query("DELETE FROM kv WHERE key = ?1").run(key)
  }

  /** Appends an event to the durable event log. */
  logEvent(type: string, sessionId: string | null, data?: unknown): void {
    this.sqlite
      .query("INSERT INTO events (type, session_id, data, created_at) VALUES (?1, ?2, ?3, ?4)")
      .run(type, sessionId, data === undefined ? null : JSON.stringify(data), Date.now())
  }

  close(): void {
    this.sqlite.close()
  }
}

/**
 * Progress ledger — the key/value half of IMURUN's memory.
 *
 * A local model has a small window and no durable plan of its own. When a run
 * stops halfway through writing a file, is interrupted, or simply runs out of
 * output room, the next run has no idea how far it got — so it starts again,
 * repeats work, or writes a file a second time from scratch.
 *
 * This ledger is the missing state: a small, exact key/value store per project
 * ("file:src/app.ts" was appended to, 12 KB, section 3 done) that survives
 * restarts, is cheap to look up, and is cheap to put in front of the model. RAG
 * holds the *text* that can be searched; the ledger holds the *state* that has
 * to be recalled exactly.
 *
 * Writes are atomic and the file is plain JSON, so a crash mid-write cannot
 * leave a half-parsed ledger behind.
 */
import { join } from "node:path"
import { ensureDir, imurunDir, readJson, shortHash, writeJsonAtomic } from "@imurun/util"

export interface LedgerEntry {
  /** Stable key, e.g. "file:src/app.ts" or "task:landing-page". */
  key: string
  value: string
  updatedAt: number
  /** open = still in flight; done = finished and no longer worth recalling. */
  status: "open" | "done"
  /** Optional numbers that are useful verbatim (bytes, lines, step). */
  numbers?: Record<string, number>
}

interface LedgerFile {
  version: 1
  projectPath: string
  updatedAt: number
  entries: LedgerEntry[]
}

/** Entries kept per project. Anything older is dropped when the cap is hit. */
const MAX_ENTRIES = 200
/** Open entries surfaced to the model. */
export const LEDGER_PROMPT_LIMIT = 12

export function ledgerDir(): string {
  return imurunDir("memory", "ledger")
}

export function ledgerPath(projectPath: string): string {
  return join(ledgerDir(), `${shortHash(projectPath.toLowerCase(), 10)}.json`)
}

function sortNewestFirst(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
}

export class ProgressLedger {
  constructor(readonly projectPath: string) {}

  private async load(): Promise<LedgerFile> {
    const data = await readJson<LedgerFile>(ledgerPath(this.projectPath))
    if (!data || !Array.isArray(data.entries)) {
      return { version: 1, projectPath: this.projectPath, updatedAt: Date.now(), entries: [] }
    }
    return { version: 1, projectPath: this.projectPath, updatedAt: data.updatedAt ?? 0, entries: data.entries }
  }

  private async save(file: LedgerFile): Promise<void> {
    await ensureDir(ledgerDir())
    const entries = sortNewestFirst(file.entries).slice(0, MAX_ENTRIES)
    await writeJsonAtomic(ledgerPath(this.projectPath), { ...file, updatedAt: Date.now(), entries })
  }

  async all(): Promise<LedgerEntry[]> {
    return sortNewestFirst((await this.load()).entries)
  }

  async get(key: string): Promise<LedgerEntry | undefined> {
    const normalised = key.trim().toLowerCase()
    return (await this.load()).entries.find((entry) => entry.key.toLowerCase() === normalised)
  }

  async set(
    key: string,
    value: string,
    options: { status?: "open" | "done"; numbers?: Record<string, number> } = {},
  ): Promise<LedgerEntry> {
    const name = key.trim()
    if (!name) throw new Error("ledger key cannot be empty")
    const file = await this.load()
    const existing = file.entries.find((entry) => entry.key.toLowerCase() === name.toLowerCase())
    const entry: LedgerEntry = {
      key: existing?.key ?? name,
      value,
      updatedAt: Date.now(),
      status: options.status ?? existing?.status ?? "open",
      numbers: options.numbers ?? existing?.numbers,
    }
    file.entries = [...file.entries.filter((item) => item.key.toLowerCase() !== name.toLowerCase()), entry]
    await this.save(file)
    return entry
  }

  async remove(key: string): Promise<boolean> {
    const name = key.trim().toLowerCase()
    const file = await this.load()
    const before = file.entries.length
    file.entries = file.entries.filter((entry) => entry.key.toLowerCase() !== name)
    if (file.entries.length === before) return false
    await this.save(file)
    return true
  }

  async clear(): Promise<number> {
    const file = await this.load()
    const count = file.entries.length
    await this.save({ ...file, entries: [] })
    return count
  }

  /** Unfinished work, newest first — what a fresh run should pick up. */
  async open(limit = LEDGER_PROMPT_LIMIT): Promise<LedgerEntry[]> {
    return (await this.all()).filter((entry) => entry.status === "open").slice(0, limit)
  }

  /**
   * Records that a file was written, without clobbering a deliberate "done"
   * marker the model may have set for the surrounding task.
   */
  async noteFile(path: string, info: { bytes: number; lines: number; mode: string }): Promise<void> {
    const key = `file:${path.replace(/\\/g, "/")}`
    const existing = await this.get(key)
    await this.set(key, `${info.mode} \u00b7 ${info.lines} lines \u00b7 ${info.bytes} bytes`, {
      status: existing?.status ?? "open",
      numbers: { bytes: info.bytes, lines: info.lines, mode: info.mode === "append" ? 2 : 1 },
    })
  }
}

const ledgers = new Map<string, ProgressLedger>()

/** One ledger per project, cached so repeated tool calls do no extra work. */
export function ledgerFor(projectPath: string): ProgressLedger {
  const key = projectPath.toLowerCase()
  let ledger = ledgers.get(key)
  if (!ledger) {
    ledger = new ProgressLedger(projectPath)
    ledgers.set(key, ledger)
  }
  return ledger
}

export function clearLedgerCache(): void {
  ledgers.clear()
}

/** Renders entries for the system prompt, one short line each. */
export function formatLedger(entries: LedgerEntry[]): string[] {
  return entries.map((entry) => {
    const numbers = entry.numbers
      ? Object.entries(entry.numbers)
          .map(([name, value]) => `${name}=${value}`)
          .join(" ")
      : ""
    const body = `${entry.key} \u2014 ${entry.value}${numbers ? ` (${numbers})` : ""}`
    return body.replace(/\s+/g, " ").trim()
  })
}

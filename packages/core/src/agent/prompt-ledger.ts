/**
 * The prompt ledger — every instruction of the session, and where it stands.
 *
 * A long session loses things. The user asks for five things, the agent does
 * three of them, and neither side can see the other two any more. The plan
 * (`.imurun/PLAN.md`) covers the steps of one piece of work; the ledger
 * covers the *requests* themselves, across the whole session.
 *
 * Each prompt is recorded when it is sent, with the turn it belongs to. When
 * a turn finishes, the prompt is marked complete — or, if the agent said it
 * could not do it, marked blocked, with the reason. Nothing is ever silently
 * dropped: an unstarted prompt stays `pending` and is visible until it is
 * dealt with.
 *
 * The ledger lives in the project directory, next to the plan and the todos,
 * so it is a file the user can open, edit, and diff.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureDir, writeFileAtomic } from "@imurun/util"

export type PromptStatus = "pending" | "active" | "done" | "blocked"

export interface PromptEntry {
  /** A short, stable id: `pr_1`, `pr_2`, … */
  id: string
  /** The request, as the user wrote it. */
  text: string
  /** The first line, for the list. */
  title: string
  status: PromptStatus
  /** When it was asked for. */
  askedAt: number
  /** When it was dealt with. */
  finishedAt?: number
  /** Why it was blocked, when it was. */
  reason?: string
  /** How many turns it took. */
  turns: number
}

export interface PromptLedgerState {
  version: number
  entries: PromptEntry[]
}

export const PROMPT_LEDGER_VERSION = 1

/** The file the ledger lives in, inside the project. */
export function promptLedgerPath(workingDir: string): string {
  return join(workingDir, ".imurun", "prompts.md")
}

/** The first line of a prompt, trimmed to something a list can show. */
export function promptTitle(text: string, max = 72): string {
  const line = text.split(/\r?\n/).find((part) => part.trim().length > 0)?.trim() ?? ""
  if (line.length <= max) return line
  return `${line.slice(0, max - 1)}…`
}

/** Renders the ledger as markdown, so it is readable and diffable. */
export function renderPromptLedger(entries: readonly PromptEntry[]): string {
  const lines: string[] = [
    "# Prompts",
    "",
    "Every request made in this session, and where it stands.",
    "",
  ]
  if (entries.length === 0) {
    lines.push("_Nothing yet._", "")
    return lines.join("\n")
  }
  for (const entry of entries) {
    const mark =
      entry.status === "done" ? "x" : entry.status === "blocked" ? "!" : entry.status === "active" ? ">" : " "
    const reason = entry.reason ? ` — ${entry.reason}` : ""
    lines.push(`- [${mark}] **${entry.id}** ${entry.title}${reason}`)
  }
  lines.push("")
  return lines.join("\n")
}

export class PromptLedger {
  private entries: PromptEntry[] = []
  private readonly path: string

  constructor(workingDir: string, entries: PromptEntry[] = []) {
    this.path = promptLedgerPath(workingDir)
    this.entries = entries
  }

  /** Reads the ledger from disk. A missing or broken file starts empty. */
  static async load(workingDir: string): Promise<PromptLedger> {
    const path = promptLedgerPath(workingDir)
    let entries: PromptEntry[] = []
    try {
      const raw = await readFile(path, "utf8")
      entries = parsePromptLedger(raw)
    } catch {
      entries = []
    }
    return new PromptLedger(workingDir, entries)
  }

  all(): PromptEntry[] {
    return [...this.entries]
  }

  /** The requests that are not finished yet. */
  open(): PromptEntry[] {
    return this.entries.filter((entry) => entry.status === "pending" || entry.status === "active")
  }

  /** Records a new request. */
  add(text: string, now = Date.now()): PromptEntry {
    const entry: PromptEntry = {
      id: `pr_${this.entries.length + 1}`,
      text: text.trim(),
      title: promptTitle(text),
      status: "pending",
      askedAt: now,
      turns: 0,
    }
    this.entries.push(entry)
    return entry
  }

  /** The entry a turn belongs to. */
  active(): PromptEntry | undefined {
    return this.entries.find((entry) => entry.status === "active")
  }

  /** Marks the active request as being worked on. */
  start(now = Date.now()): PromptEntry | undefined {
    const entry = this.active() ?? this.open()[0]
    if (!entry) return undefined
    entry.status = "active"
    entry.turns++
    void now
    return entry
  }

  /** Marks a request as finished. */
  complete(id: string, now = Date.now()): PromptEntry | undefined {
    const entry = this.entries.find((item) => item.id === id)
    if (!entry) return undefined
    entry.status = "done"
    entry.finishedAt = now
    return entry
  }

  /** Marks a request as blocked, with the reason. */
  block(id: string, reason: string, now = Date.now()): PromptEntry | undefined {
    const entry = this.entries.find((item) => item.id === id)
    if (!entry) return undefined
    entry.status = "blocked"
    entry.reason = reason
    entry.finishedAt = now
    return entry
  }

  /** A one-line summary: how many are done, and what is still open. */
  summary(): string {
    const done = this.entries.filter((entry) => entry.status === "done").length
    const blocked = this.entries.filter((entry) => entry.status === "blocked").length
    const pending = this.entries.length - done - blocked
    return `${done} done \u00b7 ${pending} pending \u00b7 ${blocked} blocked`
  }

  async save(): Promise<void> {
    await ensureDir(join(this.path, ".."))
    await writeFileAtomic(this.path, renderPromptLedger(this.entries))
  }
}

/** Reads the entries back out of the markdown file. */
export function parsePromptLedger(markdown: string): PromptEntry[] {
  const entries: PromptEntry[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^- \[( |x|!|>)\] \*\*([^*]+)\*\* (.*)$/.exec(line)
    if (!match) continue
    const [, mark, id, rest] = match
    const reason = rest.includes(" — ") ? rest.slice(rest.indexOf(" — ") + 3).trim() : undefined
    const title = reason ? rest.slice(0, rest.indexOf(" — ")).trim() : rest.trim()
    entries.push({
      id: id!.trim(),
      text: title ?? "",
      title: title ?? "",
      status: mark === "x" ? "done" : mark === "!" ? "blocked" : mark === ">" ? "active" : "pending",
      askedAt: 0,
      reason,
      turns: 0,
    })
  }
  return entries
}

/**
 * The card vault — the second brain's home on disk.
 *
 * A clean-room port of the memory engine behind `smixs/agent-second-brain`
 * (MIT), rebuilt for IMURUN: a folder of Obsidian-compatible markdown cards
 * with typed frontmatter, aged by use and tidied by a maintenance pass. No
 * network, no database, no SaaS — `notes.md` stays the quick jot, and the vault
 * is the structured layer above it.
 *
 * The tier arithmetic lives in `cards.ts`. This file is everything that touches
 * the filesystem: the scaffold, reading and writing cards, promotion on a hit,
 * ageing on a read, link repair, duplicate quarantine, the map-of-content, and
 * the 100-point health score.
 *
 * A card's tier in its frontmatter is what it *earned*; the tier `list()`
 * reports is that tier aged by disuse. Ageing is derived rather than written,
 * so a vault left alone for a year reads correctly without anything having to
 * have run; `maintain()` writes the aged tier back for outside editors.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { shortHash } from "@imurun/util"
import {
  ACTIVE_DAYS,
  CARD_TYPES,
  type BrainCard,
  type CardTier,
  type CardType,
  daysBetween,
  normalizeTitle,
  promoted,
  scoreCard,
  slugify,
  tierByAge,
  wikiLinks,
} from "./cards"

const NOW = () => new Date().toISOString()

/** The folders a fresh vault is scaffolded with. */
export const VAULT_FOLDERS = ["daily", "goals", "projects", "thoughts", "MOC"] as const

/** Where a card of a given type lives. */
export function folderFor(type: CardType): string {
  if (type === "goal") return "goals"
  if (type === "project" || type === "crm") return "projects"
  return "thoughts"
}

/** A card as it exists on disk: stored state plus its file and body. */
export interface BrainCardFile extends BrainCard {
  /** Absolute path of the markdown file. */
  path: string
  /** Markdown below the frontmatter. */
  body: string
  /** The tier as written, before ageing. */
  storedTier: CardTier
}

export interface VaultHealth {
  /** 0–100: links 40, orphans 25, duplicates 20, map-of-content 15. */
  score: number
  cards: number
  /** Cards nothing links to. Reported, never deleted. */
  orphans: string[]
  /** Links pointing at titles that do not exist. */
  brokenLinks: Array<{ from: string; to: string }>
  /** Titles held by more than one card. */
  duplicates: string[]
  hasMoc: boolean
}

export interface MaintenanceReport {
  brokenLinksRepaired: number
  brokenLinksRemaining: number
  duplicatesTrashed: string[]
  orphans: string[]
  /** Cards whose written tier was lowered to match their age. */
  demoted: string[]
  mocWritten: boolean
}

/** Serialises the frontmatter IMURUN writes. A deliberate YAML subset. */
function frontmatter(card: BrainCardFile, description: string): string {
  const lines = [
    "---",
    `id: ${card.id}`,
    `type: ${card.type}`,
    `title: ${yamlString(card.title)}`,
    `tier: ${card.storedTier}`,
    `created: ${card.created}`,
    `accessed: ${card.accessed}`,
    `access-count: ${card.accessCount}`,
  ]
  if (card.status) lines.push(`status: ${yamlString(card.status)}`)
  lines.push(`tags: [${card.tags.map(yamlString).join(", ")}]`)
  if (description) lines.push(`description: ${yamlString(description)}`)
  lines.push("---", "")
  return lines.join("\n")
}

function yamlString(value: string): string {
  return /^[\w ./-]+$/.test(value) ? value : JSON.stringify(value)
}

/** Parses the frontmatter this vault writes, tolerating hand edits. */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (!entry) continue
    data[entry[1]!] = (entry[2] ?? "").trim().replace(/^"(.*)"$/, "$1")
  }
  return { data, body: match[2] ?? "" }
}

const KNOWN_TIERS: readonly CardTier[] = ["core", "active", "warm", "cold", "archive"]

/** Reads one markdown file into a card, ageing its tier to today. */
export function parseCardFile(path: string, raw: string, now = NOW()): BrainCardFile | undefined {
  const { data, body } = parseFrontmatter(raw)
  const type = CARD_TYPES.includes(data.type as CardType) ? (data.type as CardType) : "note"
  const title = data.title || firstHeading(body) || fileTitle(path)
  if (!title) return undefined
  const accessCount = Number.parseInt(data["access-count"] ?? "1", 10) || 1
  const storedTier = KNOWN_TIERS.includes(data.tier as CardTier) ? (data.tier as CardTier) : "warm"
  return {
    id: data.id || `card_${shortHash(`${type}:${title}`, 8)}`,
    type,
    title,
    storedTier,
    tier: tierByAge(storedTier, daysBetween(data.accessed ?? now, now), accessCount),
    tags: parseTags(data.tags),
    status: data.status || undefined,
    created: data.created || now,
    accessed: data.accessed || now,
    accessCount,
    description: data.description || firstParagraph(body) || undefined,
    // A link can appear in the description and again in the body; one edge.
    links: [...new Set(wikiLinks(raw))],
    path,
    body: body.trim(),
  }
}

function parseTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((tag) => tag.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
}

function firstParagraph(body: string): string {
  const paragraph = body.split(/\n\s*\n/).find((part) => part.trim() && !part.trim().startsWith("#"))
  return (paragraph ?? "").replace(/\s+/g, " ").trim().slice(0, 240)
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim()
}

function fileTitle(path: string): string {
  return path
    .split(/[\\/]/)
    .pop()!
    .replace(/\.md$/i, "")
    .replace(/-/g, " ")
}

function renderDocument(card: BrainCardFile): string {
  return `${frontmatter(card, card.description ?? "")}\n${card.body.trim()}\n`
}

export class CardVault {
  readonly root: string
  private cache: BrainCardFile[] | undefined

  constructor(root: string) {
    this.root = root
  }

  /** Creates the folders and the two standing files, once. */
  async ensureScaffold(): Promise<void> {
    for (const folder of [...VAULT_FOLDERS, ".trash"]) {
      await mkdir(join(this.root, folder), { recursive: true })
    }
    const memory = join(this.root, "MEMORY.md")
    if (!existsSync(memory)) {
      await writeFile(
        memory,
        "# Memory map\n\nA map of everything in this vault, regenerated by IMURUN.\nIt is an ordinary markdown file — open it anywhere.\n",
        "utf8",
      )
    }
    const persona = join(this.root, "persona.md")
    if (!existsSync(persona)) {
      await writeFile(
        persona,
        "# About me\n\n" +
          "Anything filled in here is put in front of IMURUN at the start of every session.\n" +
          "Edit it freely — it is yours.\n\n" +
          "- Name:\n- Timezone:\n- What I am working on:\n- How I like answers (short? tables? step by step?):\n",
        "utf8",
      )
    }
    this.cache = undefined
  }

  /**
   * The persona file, or undefined while it is still the untouched scaffold.
   * This is what personalises the prompt to the user, on top of the role.
   */
  async persona(): Promise<string | undefined> {
    const path = join(this.root, "persona.md")
    if (!existsSync(path)) return undefined
    const body = (await readFile(path, "utf8")).replace(/^---[\s\S]*?---\r?\n?/, "").trim()
    // A scaffold with nothing filled in is not a persona.
    const lines = body.split("\n").filter((line) => /^- [A-Za-z]/.test(line))
    return lines.some((line) => /^- [A-Za-z][^:]*:\s*\S/.test(line)) ? body : undefined
  }

  private async scan(): Promise<BrainCardFile[]> {
    if (this.cache) return this.cache
    const cards: BrainCardFile[] = []
    if (existsSync(this.root)) {
      for (const folder of VAULT_FOLDERS) {
        const dir = join(this.root, folder)
        if (!existsSync(dir)) continue
        for (const entry of await readdir(dir)) {
          if (!entry.toLowerCase().endsWith(".md")) continue
          const path = join(dir, entry)
          const card = parseCardFile(path, await readFile(path, "utf8"))
          if (card) cards.push(card)
        }
      }
    }
    this.cache = cards
    return cards
  }

  /** Every card, aged to the tier its disuse earns. */
  async list(): Promise<BrainCardFile[]> {
    return this.scan()
  }

  /** Writes a card, updating the existing one when title and type match. */
  async save(input: {
    type: CardType
    title: string
    body?: string
    tags?: string[]
    status?: string
    id?: string
  }): Promise<BrainCardFile> {
    await this.ensureScaffold()
    const now = NOW()
    const existing = (await this.list()).find(
      (card) => normalizeTitle(card.title) === normalizeTitle(input.title) && card.type === input.type,
    )
    const description = firstParagraph(input.body ?? "")

    // Two types can share a folder, so two cards can want the same file name.
    // The second one gets a hash suffix instead of overwriting the first.
    const folder = join(this.root, folderFor(input.type))
    const wanted = join(folder, `${slugify(input.title)}.md`)
    const taken = (await this.list()).some((card) => card.path.toLowerCase() === wanted.toLowerCase())
    const path = taken
      ? join(folder, `${slugify(input.title)}-${shortHash(`${input.type}:${input.title}`, 4)}.md`)
      : wanted

    const card: BrainCardFile = existing
      ? {
          ...existing,
          title: input.title,
          status: input.status ?? existing.status,
          tags: input.tags ?? existing.tags,
          description: description || existing.description,
          body: (input.body ?? existing.body).trim(),
          links: wikiLinks(input.body ?? existing.body),
        }
      : {
          id: input.id ?? `card_${shortHash(`${input.type}:${input.title}`, 8)}`,
          type: input.type,
          title: input.title,
          storedTier: "active",
          tier: "active",
          tags: input.tags ?? [],
          status: input.status,
          created: now,
          accessed: now,
          accessCount: 1,
          description: description || undefined,
          links: wikiLinks(input.body ?? ""),
          path,
          body: (input.body ?? "").trim(),
        }

    await mkdir(join(this.root, folderFor(card.type)), { recursive: true })
    await writeFile(card.path, renderDocument(card), "utf8")
    this.cache = undefined
    return card
  }

  /**
   * A recall hit: the card gets older but stronger. The access count rises, the
   * tier is promoted a step — use is what keeps memory alive — and the file is
   * rewritten so the state survives a restart.
   */
  async touch(id: string, now = NOW()): Promise<BrainCardFile | undefined> {
    const card = (await this.list()).find((entry) => entry.id === id)
    if (!card) return undefined
    const next: BrainCardFile = {
      ...card,
      accessCount: card.accessCount + 1,
      accessed: now,
      storedTier: promoted(card.storedTier, card.accessCount + 1),
      tier: promoted(card.storedTier, card.accessCount + 1),
    }
    await writeFile(next.path, renderDocument(next), "utf8")
    this.cache = undefined
    return next
  }

  /**
   * Recall. Lexical match weighted by strength and tier (see `scoreCard`).
   * `archive` cards are excluded — they surface at random, not on search.
   */
  async recall(query: string, options: { limit?: number } = {}): Promise<BrainCardFile[]> {
    const cards = (await this.list()).filter((card) => card.tier !== "archive")
    const ranked = cards
      .map((card) => ({ card, ...scoreCard(card, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 5)
    for (const entry of ranked) await this.touch(entry.card.id)
    return ranked.map((entry) => ({ ...entry.card, tier: promoted(entry.card.storedTier, entry.card.accessCount + 1) }))
  }

  /** What goes into the system prompt: `core` always, `active` while in use. */
  async inject(): Promise<BrainCardFile[]> {
    const cards = await this.list()
    return cards
      .filter(
        (card) => card.tier === "core" || (card.tier === "active" && daysBetween(card.accessed, NOW()) <= ACTIVE_DAYS),
      )
      .sort((a, b) => KNOWN_TIERS.indexOf(b.tier) - KNOWN_TIERS.indexOf(a.tier))
  }

  /**
   * One cold or archived card, at most — the "you have not thought about this
   * in a while" nudge. Bounded by design: it is a garnish, never a flood.
   */
  async randomRecall(excludeTitles: ReadonlySet<string> = new Set()): Promise<BrainCardFile | undefined> {
    const candidates = (await this.list()).filter(
      (card) => (card.tier === "cold" || card.tier === "archive") && !excludeTitles.has(normalizeTitle(card.title)),
    )
    if (candidates.length === 0) return undefined
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  /** The 100-point health check. */
  async health(): Promise<VaultHealth> {
    const cards = await this.list()
    const hasMoc = existsSync(join(this.root, "MEMORY.md"))
    if (cards.length === 0) {
      return { score: hasMoc ? 100 : 85, cards: 0, orphans: [], brokenLinks: [], duplicates: [], hasMoc }
    }

    const byTitle = new Map(cards.map((card) => [normalizeTitle(card.title), card]))
    const brokenLinks: VaultHealth["brokenLinks"] = []
    for (const card of cards) {
      for (const link of card.links) {
        if (!byTitle.has(normalizeTitle(link))) brokenLinks.push({ from: card.title, to: link })
      }
    }

    const inbound = new Map<string, number>()
    for (const card of cards) {
      for (const link of card.links) {
        const target = byTitle.get(normalizeTitle(link))
        if (target) inbound.set(target.id, (inbound.get(target.id) ?? 0) + 1)
      }
    }
    const orphans = cards.filter((card) => (inbound.get(card.id) ?? 0) === 0).map((card) => card.title)

    const seen = new Map<string, number>()
    for (const card of cards) seen.set(normalizeTitle(card.title), (seen.get(normalizeTitle(card.title)) ?? 0) + 1)
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([title]) => title)

    const linkTotal = cards.reduce((sum, card) => sum + card.links.length, 0)
    const linkScore = linkTotal === 0 ? 40 : 40 * (1 - brokenLinks.length / linkTotal)
    const orphanScore = 25 * (1 - orphans.length / cards.length)
    const duplicateScore = 20 * (1 - duplicates.length / cards.length)
    const score = Math.round(linkScore + orphanScore + duplicateScore + (hasMoc ? 15 : 0))

    return { score, cards: cards.length, orphans, brokenLinks, duplicates, hasMoc }
  }

  /**
   * Tidies the vault: repairs links that have exactly one plausible target,
   * quarantines duplicate titles to `.trash/` (keeping the most-used card),
   * writes aged tiers back for outside editors, and regenerates the MOC.
   */
  async maintain(): Promise<MaintenanceReport> {
    await this.ensureScaffold()
    let cards = await this.list()
    let repaired = 0
    let remaining = 0

    // Repair: a broken link with exactly one card whose title contains it as a
    // whole-word prefix is a typo, not a mystery. Anything else stays broken
    // and is reported — guessing wildly would corrupt the user's links.
    for (const card of cards) {
      if (card.links.length === 0) continue
      let body = card.body
      let changed = false
      for (const link of card.links) {
        if (cards.some((other) => normalizeTitle(other.title) === normalizeTitle(link))) continue
        const wanted = normalizeTitle(link)
        const candidates = cards.filter((other) => {
          const title = normalizeTitle(other.title)
          return title.startsWith(wanted) || wanted.startsWith(title)
        })
        if (candidates.length === 1) {
          body = body.replaceAll(`[[${link}]]`, `[[${candidates[0]!.title}]]`)
          changed = true
          repaired++
        } else {
          remaining++
        }
      }
      if (changed) {
        const updated = { ...card, body, links: wikiLinks(`${card.body.slice(0, 0)}${body}`) }
        await writeFile(card.path, renderDocument(updated), "utf8")
      }
    }

    this.cache = undefined
    cards = await this.list()

    // Duplicates: same normalised title. Keep the most-used card, move the rest.
    const trashDir = join(this.root, ".trash")
    await mkdir(trashDir, { recursive: true })
    const duplicatesTrashed: string[] = []
    const groups = new Map<string, BrainCardFile[]>()
    for (const card of cards) {
      const key = normalizeTitle(card.title)
      groups.set(key, [...(groups.get(key) ?? []), card])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const sorted = [...group].sort(
        (a, b) => b.accessCount - a.accessCount || Date.parse(b.accessed) - Date.parse(a.accessed),
      )
      for (const loser of sorted.slice(1)) {
        const target = join(trashDir, `${slugify(loser.title)}-${loser.id.slice(-4)}.md`)
        await rename(loser.path, target)
        duplicatesTrashed.push(loser.title)
      }
    }
    if (duplicatesTrashed.length > 0) {
      this.cache = undefined
      cards = await this.list()
    }

    // Write aged tiers back, so Obsidian and the user see the same thing IMURUN does.
    const demoted: string[] = []
    for (const card of cards) {
      if (card.tier === card.storedTier) continue
      await writeFile(card.path, renderDocument({ ...card, storedTier: card.tier }), "utf8")
      demoted.push(card.title)
    }
    this.cache = undefined
    cards = await this.list()

    const health = await this.health()
    await writeFile(join(this.root, "MEMORY.md"), this.renderMoc(cards), "utf8")

    return {
      brokenLinksRepaired: repaired,
      brokenLinksRemaining: remaining,
      duplicatesTrashed,
      orphans: health.orphans,
      demoted,
      mocWritten: true,
    }
  }

  /** The map of content: every card, grouped by type, linked wiki-style. */
  renderMoc(cards: BrainCardFile[]): string {
    const lines = [
      "# Memory map",
      "",
      "Regenerated by IMURUN. Edit freely; the next tidy rewrites it.",
      "",
    ]
    for (const type of CARD_TYPES) {
      const group = cards.filter((card) => card.type === type)
      if (group.length === 0) continue
      lines.push(`## ${type.charAt(0).toUpperCase()}${type.slice(1)}`)
      for (const card of group) {
        lines.push(`- [[${card.title}]] — ${card.description || card.body.slice(0, 80)}`)
      }
      lines.push("")
    }
    return lines.join("\n")
  }
}

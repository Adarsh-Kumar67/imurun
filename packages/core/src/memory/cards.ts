/**
 * The card model — the part of the second brain that is pure arithmetic.
 *
 * This is a clean-room port of the ideas in `smixs/agent-second-brain` (MIT):
 * knowledge as typed cards that age the way memory does, ranked by how often
 * they are used rather than only how well they match. The algorithms are
 * reimplemented for IMURUN's offline, file-based store; nothing is copied and
 * no dependency is added. See `THIRD_PARTY_NOTICES.md`.
 *
 * A card is an ordinary Obsidian-compatible markdown file with frontmatter, so
 * the vault on disk stays readable and editable by hand and by other tools.
 * Everything here works without a network, a model, or a database.
 */

export const CARD_TYPES = [
  "note",
  "contact",
  "project",
  "crm",
  "goal",
  "idea",
  "learning",
  "reflection",
] as const
export type CardType = (typeof CARD_TYPES)[number]

/**
 * Memory tiers, coldest to hottest. The tier decides what reaches the model:
 * `core` is always in the prompt, `active` joins it while it is being used,
 * `warm` and `cold` are searchable, and `archive` surfaces only at random.
 */
export const CARD_TIERS = ["archive", "cold", "warm", "active", "core"] as const
export type CardTier = (typeof CARD_TIERS)[number]

/** How many days of disuse drop a card one tier. */
export const DEMOTE_AFTER_DAYS = 30
/** A card counts as recently used for this long. */
export const ACTIVE_DAYS = 7
/** Accesses needed before a card can be promoted all the way to `core`. */
export const CORE_ACCESS_THRESHOLD = 8

/**
 * Ebbinghaus-style strength: `1 + ln(accesses)`. One look is strength 1; the
 * tenth look is ~2.4. It multiplies a search hit's lexical score, so what the
 * user keeps coming back to rises without ever drowning out a good match.
 */
export function decayStrength(accessCount: number): number {
  return 1 + Math.log(Math.max(1, accessCount))
}

/** Days between two instants (fractional). */
export function daysBetween(fromISO: string, toISO: string): number {
  const from = Date.parse(fromISO)
  const to = Date.parse(toISO)
  if (Number.isNaN(from) || Number.isNaN(to)) return Infinity
  return Math.max(0, (to - from) / 86_400_000)
}

/** The tier a card's age and access count earn when nothing else touches it. */
export function tierByAge(tier: CardTier, daysSinceAccess: number, accessCount: number): CardTier {
  if (tier === "core") return "core" // the user pinned it, or it earned its place
  if (daysSinceAccess < DEMOTE_AFTER_DAYS) return tier
  const order = CARD_TIERS.indexOf(tier)
  const aged = Math.floor(daysSinceAccess / DEMOTE_AFTER_DAYS)
  return CARD_TIERS[Math.max(0, order - aged)]
}

/** One hit on a card promotes it a tier — use is what keeps memory alive. */
export function promoted(tier: CardTier, accessCount: number): CardTier {
  if (tier === "core") return "core"
  const order = CARD_TIERS.indexOf(tier)
  const next = CARD_TIERS[Math.min(CARD_TIERS.length - 1, order + 1)]
  // `core` means "always in the prompt", so it is earned, not reached once.
  if (next === "core" && accessCount < CORE_ACCESS_THRESHOLD) return tier
  return next
}

export interface CardScore {
  /** Lexical score: 1.0 for a plain full match, more when the title or a tag carries it. */
  match: number
  /** `match × strength × tier`, the number recall ranks by. */
  score: number
}

/** A card's stored state — everything the frontmatter carries. */
export interface BrainCard {
  id: string
  type: CardType
  title: string
  tier: CardTier
  tags: string[]
  /** `open` / `done` / whatever the card's type needs. */
  status?: string
  /** ISO timestamps. */
  created: string
  accessed: string
  accessCount: number
  /** One line saying what the card is, shown in lists and the MOC. */
  description?: string
  /** `[[wiki-link]]` targets found anywhere in the card. */
  links: string[]
}

/**
 * Ranks one card against a query. Lexical coverage first — how much of the
 * query the card accounts for — then title and tag hits on top, because a card
 * *about* the word beats one that merely says it. Use and tier scale the
 * result, so two equally good matches are ordered by what is still alive.
 */
export function scoreCard(
  card: { title: string; body: string; tags: string[]; tier: CardTier; accessCount: number },
  query: string,
): CardScore {
  const tokens = cardTokens(query)
  if (tokens.length === 0) return { match: 0, score: 0 }
  const haystack = cardTokens(`${card.title} ${card.tags.join(" ")} ${card.title} ${card.body}`)
  const counts = new Map<string, number>()
  for (const token of haystack) counts.set(token, (counts.get(token) ?? 0) + 1)

  let hits = 0
  for (const token of tokens) hits += counts.get(token) ?? 0
  const coverage = Math.min(1, hits / tokens.length)
  if (coverage === 0) return { match: 0, score: 0 }

  // Title and tag hits are worth more than a mention buried in the body.
  const titleTokens = new Set(cardTokens(card.title))
  const tagTokens = new Set(card.tags.flatMap((tag) => cardTokens(tag)))
  const emphasis = tokens.reduce(
    (sum, token) => sum + (titleTokens.has(token) ? 0.5 : 0) + (tagTokens.has(token) ? 0.25 : 0),
    0,
  )
  const match = coverage * (1 + emphasis / tokens.length)

  const tierWeight = 0.5 + CARD_TIERS.indexOf(card.tier) * 0.25 // archive 0.5 … core 1.5
  return { match, score: match * decayStrength(card.accessCount) * tierWeight }
}

/** Lowercase word tokens; short and stop words are dropped. */
export function cardTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []).filter((token) => token.length > 1)
}

/** `IMURUN release plan!` → `imurun-release-plan`, the file name for a title. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return slug || "card"
}

/** Reads `[[Link]]`, `[[Link|alias]]` and `[[Link#heading]]` targets out of markdown. */
export function wikiLinks(text: string): string[] {
  const links: string[] = []
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]!.trim()
    if (target) links.push(target)
  }
  return links
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

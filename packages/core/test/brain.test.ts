/**
 * The second brain: cards that age, strengthen, and tidy themselves.
 *
 * These tests drive the vault through a real temporary directory, because the
 * thing that can break is the files themselves — frontmatter that stops
 * round-tripping, a tier that does not survive a restart, a link repair that
 * rewrites the wrong text.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CORE_ACCESS_THRESHOLD,
  DEMOTE_AFTER_DAYS,
  decayStrength,
  normalizeTitle,
  promoted,
  scoreCard,
  slugify,
  tierByAge,
  wikiLinks,
} from "../src/memory/cards"
import { CardVault, parseCardFile } from "../src/memory/brain"

const DAY = 86_400_000
const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString()

describe("card arithmetic", () => {
  test("strength grows with use, logarithmically", () => {
    expect(decayStrength(1)).toBe(1)
    expect(decayStrength(2)).toBeCloseTo(1 + Math.log(2), 5)
    expect(decayStrength(100)).toBeCloseTo(1 + Math.log(100), 5)
    // A thousand looks is strong, but not so strong it drowns a better match.
    expect(decayStrength(1000)).toBeLessThan(decayStrength(1) * 9)
  })

  test("disuse walks a card down, one tier per month, and core never moves", () => {
    expect(tierByAge("active", 0, 3)).toBe("active")
    expect(tierByAge("active", DEMOTE_AFTER_DAYS + 1, 3)).toBe("warm")
    expect(tierByAge("active", DEMOTE_AFTER_DAYS * 2 + 1, 3)).toBe("cold")
    expect(tierByAge("active", DEMOTE_AFTER_DAYS * 3 + 1, 3)).toBe("archive")
    expect(tierByAge("archive", DEMOTE_AFTER_DAYS * 10, 3)).toBe("archive")
    expect(tierByAge("core", DEMOTE_AFTER_DAYS * 10, 3)).toBe("core")
  })

  test("a hit promotes a tier, but core is earned over several hits", () => {
    expect(promoted("archive", 2)).toBe("cold")
    expect(promoted("cold", 3)).toBe("warm")
    expect(promoted("warm", 4)).toBe("active")
    expect(promoted("active", CORE_ACCESS_THRESHOLD - 1)).toBe("active")
    expect(promoted("active", CORE_ACCESS_THRESHOLD)).toBe("core")
    expect(promoted("core", 99)).toBe("core")
  })

  test("a title match outranks a body mention, and a lively card outranks a stale one", () => {
    const base = { tags: [] as string[], tier: "warm" as const, accessCount: 1 }
    const titleHit = scoreCard({ ...base, title: "Deployment checklist", body: "nothing here" }, "deployment")
    const bodyHit = scoreCard({ ...base, title: "Notes", body: "deployment happened once" }, "deployment")
    expect(titleHit.score).toBeGreaterThan(bodyHit.score)

    const fresh = scoreCard({ ...base, title: "Deployment", body: "", accessCount: 20 }, "deployment")
    const stale = scoreCard({ ...base, title: "Deployment", body: "", accessCount: 1 }, "deployment")
    expect(fresh.score).toBeGreaterThan(stale.score)

    const core = scoreCard({ ...base, tier: "core", title: "Deployment", body: "" }, "deployment")
    const archive = scoreCard({ ...base, tier: "archive", title: "Deployment", body: "" }, "deployment")
    expect(core.score).toBeGreaterThan(archive.score)
  })

  test("no query means no match; a card with nothing to do with it scores zero", () => {
    const card = { title: "Deployment", body: "", tags: [], tier: "active" as const, accessCount: 3 }
    expect(scoreCard(card, "   ").score).toBe(0)
    expect(scoreCard(card, "kubernetes ingress").score).toBe(0)
  })

  test("titles become file names and links are read back with their aliases", () => {
    expect(slugify("IMURUN release plan!")).toBe("imurun-release-plan")
    expect(slugify("C++ / Rust")).toBe("c-rust")
    expect(slugify("???")).toBe("card")
    expect(wikiLinks("see [[ImuTechz]] and [[Roadmap|the plan]] and [[Goals#Q4]]")).toEqual([
      "ImuTechz",
      "Roadmap",
      "Goals",
    ])
    expect(normalizeTitle("  Imu-Techz  ")).toBe("imu techz")
  })
})

describe("CardVault", () => {
  let root: string
  let vault: CardVault

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "imurun-vault-"))
    vault = new CardVault(root)
  })

  afterEach(() => {
    vault = undefined as unknown as CardVault
  })

  test("the scaffold is folders, a memory map and an empty persona", async () => {
    await vault.ensureScaffold()
    const entries = readdirSync(root).sort()
    expect(entries).toContain("MEMORY.md")
    expect(entries).toContain("persona.md")
    expect(entries).toContain("goals")
    expect(entries).toContain("projects")
    expect(entries).toContain("thoughts")
    // An untouched persona is not a persona: it must not reach the prompt.
    expect(await vault.persona()).toBeUndefined()
  })

  test("a filled-in persona is returned as written", async () => {
    await vault.ensureScaffold()
    writeFileSync(join(root, "persona.md"), "# About me\n\n- Name: Shubham\n- Timezone: IST\n", "utf8")
    expect(await vault.persona()).toContain("Name: Shubham")
  })

  test("a saved card is an ordinary markdown file with typed frontmatter", async () => {
    const card = await vault.save({
      type: "project",
      title: "IMURUN release",
      body: "Ship the local-first agent.\n\nTracks [[ImuTechz]] and [[TUI polish]].",
      tags: ["release", "cli"],
      status: "open",
    })

    expect(card.path.startsWith(join(root, "projects"))).toBe(true)
    const raw = readFileSync(card.path, "utf8")
    expect(raw).toContain("type: project")
    expect(raw).toContain("tier: active")
    expect(raw).toContain("status: open")
    expect(raw).toContain("tags: [release, cli]")
    expect(raw).toContain("description: Ship the local-first agent.")
    expect(raw).toContain("[[ImuTechz]]")

    const [listed] = await vault.list()
    expect(listed?.title).toBe("IMURUN release")
    expect(listed?.type).toBe("project")
    expect(listed?.tags).toEqual(["release", "cli"])
    expect(listed?.links).toEqual(["ImuTechz", "TUI polish"])
    expect(listed?.description).toBe("Ship the local-first agent.")
  })

  test("saving the same title and type updates rather than duplicating", async () => {
    await vault.save({ type: "goal", title: "Ship v1", body: "first draft" })
    await vault.save({ type: "goal", title: "Ship v1", body: "second draft", status: "done" })

    const cards = await vault.list()
    expect(cards).toHaveLength(1)
    expect(cards[0]?.body).toBe("second draft")
    expect(cards[0]?.status).toBe("done")
  })

  test("a hit raises the access count and the tier, and it survives a restart", async () => {
    await vault.save({ type: "idea", title: "Offline sync", body: "queue edits and flush later" })
    const [before] = await vault.list()
    expect(before?.tier).toBe("active")

    const touched = await vault.touch(before!.id)
    expect(touched?.accessCount).toBe(2)

    // A new instance reads the file, not the cache.
    const reopened = new CardVault(root)
    const [after] = await reopened.list()
    expect(after?.accessCount).toBe(2)
    expect(after?.accessed).not.toBe(before?.accessed)
  })

  test("recall ranks by match and touches what it returns", async () => {
    await vault.save({ type: "note", title: "Deployment steps", body: "build, tag, push" })
    await vault.save({ type: "note", title: "Lunch", body: "deployment chat with the team" })
    await vault.save({ type: "note", title: "Unrelated", body: "nothing to see" })

    const hits = await vault.recall("deployment", { limit: 2 })
    expect(hits[0]?.title).toBe("Deployment steps")
    expect(hits).toHaveLength(2)

    const [stored] = (await vault.list()).filter((card) => card.title === "Deployment steps")
    expect(stored?.accessCount).toBe(2)
  })

  test("archive cards are reachable only at random, never by search", async () => {
    const card = await vault.save({ type: "reflection", title: "Old idea", body: "offline sync" })
    // Age it by rewriting the frontmatter, the way a year of disuse would.
    const raw = readFileSync(card.path, "utf8").replace(/^accessed: .*$/m, `accessed: ${iso(400)}`)
    writeFileSync(card.path, raw, "utf8")

    const aged = new CardVault(root)
    const [stored] = await aged.list()
    expect(stored?.tier).toBe("archive")
    expect(await aged.recall("offline sync")).toHaveLength(0)

    const stray = await aged.randomRecall()
    expect(stray?.title).toBe("Old idea")
    expect(await aged.randomRecall(new Set([normalizeTitle("Old idea")]))).toBeUndefined()
  })

  test("only core and recently used cards reach the prompt", async () => {
    await vault.save({ type: "contact", title: "Shubham", body: "dev@imutechz.in" })
    const [contact] = await vault.list()
    // Written by hand: a core card is one the user pinned.
    writeFileSync(contact!.path, readFileSync(contact!.path, "utf8").replace("tier: active", "tier: core"), "utf8")
    await vault.save({ type: "note", title: "Old note", body: "from last year" })
    const old = (await vault.list()).find((card) => card.title === "Old note")!
    writeFileSync(
      old.path,
      readFileSync(old.path, "utf8").replace(/^accessed: .*$/m, `accessed: ${iso(200)}`).replace("tier: active", "tier: warm"),
      "utf8",
    )

    const injected = await new CardVault(root).inject()
    expect(injected.map((card) => card.title)).toEqual(["Shubham"])
  })

  test("health scores links, orphans and duplicates, and a broken link costs points", async () => {
    await vault.save({ type: "note", title: "Roadmap", body: "see [[Nowhere]]" })
    const broken = await vault.health()
    expect(broken.brokenLinks).toEqual([{ from: "Roadmap", to: "Nowhere" }])
    expect(broken.score).toBeLessThan(100)
    // One orphan (Roadmap links out but nothing links in) and one broken link.
    expect(broken.orphans).toEqual(["Roadmap"])

    await vault.save({ type: "note", title: "Nowhere", body: "the target exists after all" })
    const repaired = await new CardVault(root).health()
    expect(repaired.brokenLinks).toEqual([])
    expect(repaired.score).toBeGreaterThan(broken.score)
  })

  test("maintain quarantines a duplicate, rewrites the map, and reports what is left", async () => {
    const first = await vault.save({ type: "note", title: "Dup", body: "kept, because it is used" })
    await vault.touch(first.id)
    const second = await vault.save({ type: "idea", title: "Dup", body: "quarantined" })
    // The save above went to a different folder (idea), so both files exist.
    expect(second.path).not.toBe(first.path)

    const report = await vault.maintain()
    expect(report.duplicatesTrashed).toEqual(["Dup"])
    expect(readdirSync(join(root, ".trash")).some((name) => name.startsWith("dup-"))).toBe(true)
    expect((await vault.list()).filter((card) => card.title === "Dup")).toHaveLength(1)

    const moc = readFileSync(join(root, "MEMORY.md"), "utf8")
    expect(moc).toContain("[[Dup]]")
    expect(report.mocWritten).toBe(true)
  })

  test("maintain repairs the one plausible link and leaves the impossible ones alone", async () => {
    await vault.save({ type: "project", title: "IMURUN release", body: "the release" })
    await vault.save({ type: "note", title: "Index", body: "see [[IMURUN]] and [[Totally Absent]]" })

    const report = await vault.maintain()
    expect(report.brokenLinksRepaired).toBe(1)
    expect(report.brokenLinksRemaining).toBe(1)
    const index = (await vault.list()).find((card) => card.title === "Index")
    expect(index?.body).toContain("[[IMURUN release]]")
    expect(index?.body).toContain("[[Totally Absent]]")
  })

  test("maintain writes an aged tier back for outside editors", async () => {
    const card = await vault.save({ type: "note", title: "Aged", body: "still here" })
    writeFileSync(card.path, readFileSync(card.path, "utf8").replace(/^accessed: .*$/m, `accessed: ${iso(40)}`), "utf8")

    const report = await vault.maintain()
    expect(report.demoted).toContain("Aged")
    expect(readFileSync(card.path, "utf8")).toContain("tier: warm")
  })
})

describe("parseCardFile", () => {
  test("a hand-written file without frontmatter still becomes a card", () => {
    const card = parseCardFile(join("/vault/thoughts", "quick-thought.md"), "# Quick thought\n\nSomething true.\n")
    expect(card?.title).toBe("Quick thought")
    expect(card?.type).toBe("note")
    expect(card?.description).toBe("Something true.")
  })

  test("an unknown type falls back to note rather than being rejected", () => {
    const card = parseCardFile(
      join("/vault/thoughts", "x.md"),
      "---\ntitle: X\ntype: spreadsheet\ntier: eventually\n---\n\nbody\n",
    )
    expect(card?.type).toBe("note")
    expect(card?.tier).toBe("warm")
  })
})

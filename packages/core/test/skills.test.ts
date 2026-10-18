import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SKILL_ALIASES, SKILL_CATALOG, catalogSize } from "../src/agent/skill-catalog"
import {
  BUILTIN_SKILLS,
  formatSkillMarkdown,
  getSkill,
  loadSkills,
  parseFrontmatter,
  parseSkillMarkdown,
  scoreSkill,
  selectSkills,
  skillsToPromptSection,
  type SkillDefinition,
} from "../src/agent/skills"
import { syncSkillPack } from "../src/skills/sync"

let home: string
let work: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-skills-"))
  work = await mkdtemp(join(tmpdir(), "imurun-work-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

describe("skill catalog", () => {
  test("ships at least 50 built-in skills", () => {
    expect(catalogSize()).toBeGreaterThanOrEqual(50)
    expect(catalogSize()).toBe(SKILL_CATALOG.length)
    expect(BUILTIN_SKILLS.length).toBe(SKILL_CATALOG.length)
  })

  test("uses unique, kebab-case ids", () => {
    const ids = SKILL_CATALOG.map((skill) => skill.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  test("every skill is usable", () => {
    for (const skill of SKILL_CATALOG) {
      expect(skill.name.length).toBeGreaterThan(2)
      expect(skill.description.length).toBeGreaterThan(10)
      expect(skill.prompt.length).toBeGreaterThan(40)
      expect(skill.tags?.length ?? 0).toBeGreaterThan(0)
      expect(skill.source).toBe("builtin")
    }
  })

  test("aliases point at real skills", () => {
    const ids = new Set(SKILL_CATALOG.map((skill) => skill.id))
    for (const target of Object.values(SKILL_ALIASES)) expect(ids.has(target)).toBe(true)
  })
})

describe("frontmatter", () => {
  test("reads key/value pairs and separates the body", () => {
    const { data, body } = parseFrontmatter("---\nname: Hello\ntags: a, b\n---\n\nbody text\n")
    expect(data.name).toBe("Hello")
    expect(data.tags).toBe("a, b")
    expect(body.trim()).toBe("body text")
  })

  test("falls back when there is no frontmatter", () => {
    expect(parseFrontmatter("just text").body).toBe("just text")
    expect(parseFrontmatter("just text").data).toEqual({})
  })

  test("round-trips through markdown", () => {
    const skill: SkillDefinition = {
      id: "demo",
      name: "Demo skill",
      description: "Does demo things",
      prompt: "Step one.\nStep two.",
      tags: ["demo", "example"],
      whenToUse: "when demoing",
      source: "global",
      origin: "https://github.com/acme/skills",
      license: "MIT",
    }
    const parsed = parseSkillMarkdown(formatSkillMarkdown(skill), "demo", "global")
    expect(parsed).toBeDefined()
    expect(parsed!.name).toBe("Demo skill")
    expect(parsed!.description).toBe("Does demo things")
    expect(parsed!.tags).toEqual(["demo", "example"])
    expect(parsed!.whenToUse).toBe("when demoing")
    expect(parsed!.origin).toBe("https://github.com/acme/skills")
    expect(parsed!.license).toBe("MIT")
    expect(parsed!.prompt).toContain("Step two.")
  })

  test("refuses markdown with no instructions", () => {
    expect(parseSkillMarkdown("---\nname: Empty\n---\n\n", "empty", "global")).toBeUndefined()
  })
})

describe("routing", () => {
  test("weights the name, then tags, then description", () => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.id === "landing-page")!
    const byName = scoreSkill("landing", skill)
    const byTag = scoreSkill("marketing", skill)
    const byDesc = scoreSkill("conversion", skill)
    expect(byName).toBeGreaterThan(byTag)
    expect(byTag).toBeGreaterThan(byDesc)
    expect(byDesc).toBeGreaterThan(0)
  })

  test("picks the landing-page skill for a landing page request", () => {
    const matches = selectSkills("build a landing page for my startup", BUILTIN_SKILLS)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.skill.id).toBe("landing-page")
  })

  test("picks flaky-tests for a flaky test request", () => {
    const matches = selectSkills("the flaky test in ci keeps failing", BUILTIN_SKILLS)
    expect(matches.map((match) => match.skill.id)).toContain("flaky-tests")
  })

  test("returns nothing when no skill is close enough", () => {
    expect(selectSkills("what is the weather today", BUILTIN_SKILLS)).toEqual([])
    expect(selectSkills("", BUILTIN_SKILLS)).toEqual([])
  })

  test("honours the limit and the minimum score", () => {
    const all = selectSkills("build a website", BUILTIN_SKILLS, { limit: 99 })
    expect(all.length).toBeGreaterThan(0)
    const one = selectSkills("build a website", BUILTIN_SKILLS, { limit: 1 })
    expect(one).toHaveLength(1)
    expect(selectSkills("build a website", BUILTIN_SKILLS, { minScore: 1000 })).toEqual([])
  })
})

describe("getSkill", () => {
  test("resolves ids, aliases and names", () => {
    expect(getSkill(BUILTIN_SKILLS, "review")?.id).toBe("review")
    expect(getSkill(BUILTIN_SKILLS, "code-review")?.id).toBe("review")
    expect(getSkill(BUILTIN_SKILLS, "website")?.id).toBe("build-website")
    expect(getSkill(BUILTIN_SKILLS, "Review Changes")?.id).toBe("review")
    expect(getSkill(BUILTIN_SKILLS, "nope")).toBeUndefined()
  })
})

describe("skillsToPromptSection", () => {
  test("is empty without matches", () => {
    expect(skillsToPromptSection([])).toBeUndefined()
  })

  test("names the skill and includes its instructions", () => {
    const [match] = selectSkills("build a landing page", BUILTIN_SKILLS, { limit: 1 })
    const section = skillsToPromptSection([match!])
    expect(section).toContain(match!.skill.name)
    expect(section).toContain(match!.skill.prompt.slice(0, 20))
  })

  test("lists several approaches when more than one applies", () => {
    const matches = selectSkills("build a landing page", BUILTIN_SKILLS, { limit: 3 })
    const section = skillsToPromptSection(matches)
    expect(section).toContain("skill library")
  })
})

describe("loadSkills", () => {
  test("merges built-ins with a project override", async () => {
    const dir = join(work, ".imurun", "skills")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "review.md"),
      "---\nname: Project review\ndescription: the house rules\n---\n\nReview with our house rules.\n",
    )

    const skills = await loadSkills({ workingDir: work })
    const review = getSkill(skills, "review")
    expect(review?.name).toBe("Project review")
    expect(review?.source).toBe("project")
    expect(skills.length).toBeGreaterThanOrEqual(SKILL_CATALOG.length)
  })

  test("reads the folder form written by skill packs", async () => {
    const dir = join(home, "skills", "pack-skill")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "SKILL.md"), "---\nname: Pack skill\ndescription: from a pack\n---\n\nPack instructions here.\n")

    const skills = await loadSkills()
    expect(getSkill(skills, "pack-skill")?.source).toBe("global")
  })
})

// ── Skill pack sync ─────────────────────────────────────────────────────────

interface TreeEntry {
  path: string
  type: string
}

function fakeGitHub(files: Record<string, string>, opts: { treeStatus?: number; omitManifests?: boolean } = {}) {
  const tree: TreeEntry[] = Object.keys(files)
    .filter((path) => /SKILL\.md$/i.test(path) || /LICENSE$/i.test(path))
    .map((path) => ({ path, type: "blob" }))
  if (opts.omitManifests) tree.splice(0, tree.length, { path: "README.md", type: "blob" })

  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    if (url.includes("/git/trees/")) {
      const status = opts.treeStatus ?? 200
      return { ok: status < 400, status, json: async () => ({ tree }) } as unknown as Response
    }
    const prefix = "https://raw.githubusercontent.com/acme/skills/main/"
    if (url.startsWith(prefix)) {
      const body = files[url.slice(prefix.length)]
      if (body === undefined) return { ok: false, status: 404, text: async () => "" } as unknown as Response
      return { ok: true, status: 200, text: async () => body } as unknown as Response
    }
    return { ok: false, status: 404, text: async () => "" } as unknown as Response
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

const PACK_FILES: Record<string, string> = {
  "skills/alpha/SKILL.md": "---\nname: Alpha\ndescription: the alpha approach\n---\n\nDo the alpha thing carefully.\n",
  "skills/alpha/LICENSE": "Apache License\nVersion 2.0, January 2004\n",
  "skills/pdf/SKILL.md": "---\nname: Pdf\ndescription: pdf tooling\n---\n\nProcess PDFs.\n",
  "skills/review/SKILL.md": "---\nname: Pack review\ndescription: review the pack way\n---\n\nReview it the pack way.\n",
}

describe("syncSkillPack", () => {
  test("imports permissively licensed skills", async () => {
    const dir = join(home, "packs")
    const { fetchImpl } = fakeGitHub(PACK_FILES)
    const result = await syncSkillPack({ source: "acme/skills", dir, fetchImpl })

    expect(result.source).toBe("acme/skills")
    expect(result.imported.map((skill) => skill.id).sort()).toEqual(["acme-review", "alpha"])
    expect(result.skipped.map((skill) => skill.id)).toEqual(["pdf"])

    const alpha = result.imported.find((skill) => skill.id === "alpha")!
    expect(alpha.license).toBe("Apache-2.0")
    expect(alpha.origin).toBe("https://github.com/acme/skills")
    expect(alpha.tags).toEqual(["alpha"])
  })

  test("renames a pack skill that would shadow a built-in", async () => {
    const dir = join(home, "packs")
    const { fetchImpl } = fakeGitHub(PACK_FILES)
    const result = await syncSkillPack({ source: "acme/skills", dir, fetchImpl })
    expect(result.replaced).toEqual(["review → acme-review"])
  })

  test("writes readable markdown to the target directory", async () => {
    const dir = join(home, "packs")
    const { fetchImpl } = fakeGitHub(PACK_FILES)
    await syncSkillPack({ source: "acme/skills", dir, fetchImpl })

    const written = (await readdir(dir)).sort()
    expect(written).toEqual(["acme-review.md", "alpha.md"])
    const text = await readFile(join(dir, "alpha.md"), "utf8")
    expect(text).toContain("origin: https://github.com/acme/skills")
    expect(text).toContain("license: Apache-2.0")
    expect(text).toContain("Do the alpha thing carefully.")
  })

  test("imports restricted packs only when asked", async () => {
    const dir = join(home, "packs")
    const { fetchImpl } = fakeGitHub(PACK_FILES)
    const result = await syncSkillPack({ source: "acme/skills", dir, fetchImpl, includeRestricted: true })
    expect(result.imported.map((skill) => skill.id)).toContain("pdf")
    expect(result.skipped).toEqual([])
  })

  test("reads the tree once and reports progress", async () => {
    const dir = join(home, "packs")
    const { fetchImpl, calls } = fakeGitHub(PACK_FILES)
    const statuses: string[] = []
    await syncSkillPack({ source: "acme/skills", dir, fetchImpl, onStatus: (message) => statuses.push(message) })
    expect(calls.filter((url) => url.includes("/git/trees/"))).toHaveLength(1)
    expect(statuses.some((message) => message.includes("skill tree"))).toBe(true)
    expect(statuses.some((message) => message.includes("alpha"))).toBe(true)
  })

  test("reports a bad source and a pack with no skills", async () => {
    await expect(syncSkillPack({ source: "nope", fetchImpl: fakeGitHub({}).fetchImpl })).rejects.toThrow("owner/repo")

    const forbidden = fakeGitHub(PACK_FILES, { treeStatus: 403 })
    await expect(syncSkillPack({ source: "acme/skills", fetchImpl: forbidden.fetchImpl })).rejects.toThrow("Could not read")

    const empty = fakeGitHub(PACK_FILES, { omitManifests: true })
    await expect(syncSkillPack({ source: "acme/skills", fetchImpl: empty.fetchImpl })).rejects.toThrow("No SKILL.md")
  })
})

/**
 * The skill router — learning which method actually worked.
 *
 * The router has to do two things: find the skills that could apply, and
 * prefer the ones that have worked before. The second half is the learned
 * part, and it is what these tests pin down.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SkillRouter, scoreSkill, type SkillDefinition } from "../src"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-router-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  await rm(home, { recursive: true, force: true })
})

const skill = (id: string, words: string): SkillDefinition => ({
  id,
  name: id,
  description: words,
  prompt: `Apply the ${id} approach.`,
  tags: words.split(" "),
  source: "builtin",
})

describe("the skill router", () => {
  test("it finds the skill whose words the request uses", () => {
    const router = new SkillRouter()
    const library = [skill("seo", "seo meta tags ranking"), skill("api", "rest endpoint version")]
    const picks = router.select("improve the seo meta tags on this page", library, 1)
    expect(picks).toHaveLength(1)
    expect(picks[0]!.skill.id).toBe("seo")
  })

  test("a request with nothing in common gets nothing", () => {
    const router = new SkillRouter()
    const library = [skill("seo", "seo meta tags ranking")]
    expect(router.select("fix the null dereference in the parser", library, 1)).toHaveLength(0)
  })

  test("a skill that keeps failing is passed over, even when the words match", () => {
    const router = new SkillRouter()
    const library = [skill("seo", "seo meta tags ranking"), skill("other", "seo alternative method")]

    // The request always looks like the seo skill. Teach the router that
    // applying it did not help.
    const query = "improve the seo meta tags on this page"
    for (let index = 0; index < 8; index++) {
      router.learn("seo", query, library[0]!, false, 0.9)
    }

    const picks = router.select(query, library, 1)
    expect(picks).toHaveLength(1)
    expect(picks[0]!.skill.id).toBe("other")
    expect(router.stats("seo").rate).toBe(0)
  })

  test("a skill that keeps helping is preferred", () => {
    const router = new SkillRouter()
    const library = [skill("seo", "seo meta tags ranking"), skill("other", "seo alternative method")]
    const query = "improve the seo meta tags on this page"
    for (let index = 0; index < 8; index++) {
      router.learn("seo", query, library[0]!, true, 0.9)
    }
    const picks = router.select(query, library, 1)
    expect(picks[0]!.skill.id).toBe("seo")
    expect(router.stats("seo").rate).toBe(1)
  })

  test("the state survives a restart, and a corrupt file falls back cleanly", async () => {
    const path = join(home, "skills.json")
    const router = new SkillRouter({ path })
    const library = [skill("seo", "seo meta tags ranking")]
    const query = "improve the seo meta tags on this page"
    for (let index = 0; index < 8; index++) router.learn("seo", query, library[0]!, false, 0.9)
    await router.save()

    const reloaded = await SkillRouter.load(path)
    expect(reloaded.stats("seo").used).toBe(8)

    // A corrupt file must not stop the router working.
    await Bun.write(path, "{ not json")
    const recovered = await SkillRouter.load(path)
    expect(recovered.stats("seo").used).toBe(0)
    expect(recovered.select(query, library, 1).length).toBeGreaterThan(0)
  })

  test("a state file from another version is ignored", async () => {
    const path = join(home, "skills.json")
    await Bun.write(path, JSON.stringify({ version: 999, models: {}, applied: {} }))
    const router = await SkillRouter.load(path)
    expect(router.stats("anything").used).toBe(0)
  })

  test("the overlap score is the cold-start signal", () => {
    const definition = skill("seo", "seo meta tags ranking")
    expect(scoreSkill("improve the seo meta tags", definition)).toBeGreaterThan(0)
    expect(scoreSkill("fix the parser", definition)).toBe(0)
  })
})

/**
 * Skills — small, reusable instructions the agent can load on demand.
 *
 * Two kinds live side by side:
 *   - built-ins from ./skill-catalog (50 of them, covering real tasks)
 *   - user skills from markdown on disk:
 *       ~/.imurun/skills/<id>.md            (global)
 *       <project>/.imurun/skills/<id>.md    (project — wins over global)
 *       ~/.imurun/skills/<id>/SKILL.md      (folder form, as published by skill packs)
 *
 * Frontmatter is intentionally minimal:
 *   ---
 *   name: Build a website
 *   description: Plan and build a complete website from a description
 *   tags: web, frontend
 *   ---
 *   ...instructions...
 *
 * `selectSkills` scores every skill against what the user actually asked, so
 * the right method can be injected into the system prompt without the user
 * having to remember a command.
 */
import { readdir, readFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { basename, join } from "node:path"
import { imurunDir, logger } from "@imurun/util"
import { tokenize } from "../memory/search"
import { SKILL_ALIASES, SKILL_CATALOG } from "./skill-catalog"

export interface SkillDefinition {
  id: string
  name: string
  description: string
  /** Instruction handed to the agent when the skill is active. */
  prompt: string
  /** Loose keywords used by the router. */
  tags?: string[]
  /** When this skill should be used, in the user's words. */
  whenToUse?: string
  source: "builtin" | "global" | "project"
  /** Where a synced skill came from, e.g. a repository URL. */
  origin?: string
  /** License note for a synced skill. */
  license?: string
}

export const BUILTIN_SKILLS: SkillDefinition[] = SKILL_CATALOG

export function skillsDir(): string {
  return imurunDir("skills")
}

export function projectSkillsDir(workingDir: string): string {
  return join(workingDir, ".imurun", "skills")
}

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!entry) continue
    data[entry[1]!.toLowerCase()] = entry[2]!.trim().replace(/^["']|["']$/g, "")
  }
  return { data, body: match[2] ?? "" }
}

/** Serializes a skill to the on-disk markdown form. */
export function formatSkillMarkdown(skill: SkillDefinition): string {
  const front: string[] = [`name: ${skill.name}`, `description: ${skill.description}`]
  if (skill.tags?.length) front.push(`tags: ${skill.tags.join(", ")}`)
  if (skill.whenToUse) front.push(`when: ${skill.whenToUse}`)
  if (skill.origin) front.push(`origin: ${skill.origin}`)
  if (skill.license) front.push(`license: ${skill.license}`)
  return `---\n${front.join("\n")}\n---\n\n${skill.prompt.trim()}\n`
}

/** Parses a skill markdown document into a definition. */
export function parseSkillMarkdown(
  text: string,
  fallbackId: string,
  source: SkillDefinition["source"],
): SkillDefinition | undefined {
  const { data, body } = parseFrontmatter(text)
  const prompt = body.trim()
  if (!prompt) return undefined
  const tags = data.tags
    ? data.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
    : undefined
  return {
    id: (data.id ?? fallbackId).toLowerCase(),
    name: data.name ?? fallbackId,
    description: data.description ?? "",
    prompt,
    tags,
    whenToUse: data.when,
    source,
    origin: data.origin,
    license: data.license,
  }
}

async function readSkillFile(
  path: string,
  source: SkillDefinition["source"],
  idHint?: string,
): Promise<SkillDefinition | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  const fallbackId = idHint ?? basename(path).replace(/\.(md|json)$/i, "")

  if (path.toLowerCase().endsWith(".json")) {
    try {
      const raw = JSON.parse(text) as Partial<SkillDefinition>
      if (!raw.prompt) return undefined
      return {
        id: (raw.id ?? fallbackId).toLowerCase(),
        name: raw.name ?? fallbackId,
        description: raw.description ?? "",
        prompt: raw.prompt,
        tags: raw.tags,
        whenToUse: raw.whenToUse,
        source,
      }
    } catch {
      logger.warn(`skill ${path}: invalid JSON — skipped`)
      return undefined
    }
  }

  return parseSkillMarkdown(text, fallbackId, source)
}

async function loadFromDir(dir: string, source: SkillDefinition["source"]): Promise<SkillDefinition[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: SkillDefinition[] = []
  for (const entry of entries) {
    if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) {
      const skill = await readSkillFile(join(dir, entry.name), source)
      if (skill) skills.push(skill)
      continue
    }
    // folder form: <id>/SKILL.md (or <id>/skill.md) — the folder names the skill
    if (entry.isDirectory()) {
      for (const name of ["SKILL.md", "skill.md"]) {
        const skill = await readSkillFile(join(dir, entry.name, name), source, entry.name)
        if (skill) {
          skills.push(skill)
          break
        }
      }
    }
  }
  return skills
}

/** Built-ins, then global, then project overrides (same id replaces). */
export async function loadSkills(options: { workingDir?: string } = {}): Promise<SkillDefinition[]> {
  const byId = new Map<string, SkillDefinition>()
  for (const skill of BUILTIN_SKILLS) byId.set(skill.id, skill)
  for (const skill of await loadFromDir(skillsDir(), "global")) byId.set(skill.id, skill)
  if (options.workingDir) {
    for (const skill of await loadFromDir(projectSkillsDir(options.workingDir), "project")) byId.set(skill.id, skill)
  }
  return [...byId.values()]
}

export function getSkill(skills: SkillDefinition[], id: string): SkillDefinition | undefined {
  const lower = id.toLowerCase()
  const aliased = SKILL_ALIASES[lower] ?? lower
  return (
    skills.find((s) => s.id === aliased) ??
    skills.find((s) => s.id.toLowerCase() === lower) ??
    skills.find((s) => s.name.toLowerCase() === lower)
  )
}

// ── Routing ─────────────────────────────────────────────────────────────────

export interface ScoredSkill {
  skill: SkillDefinition
  score: number
}

/**
 * Scores a skill against a request. Name and tags weigh heaviest — they are how
 * a person would find the skill — then the description, then the body.
 */
export function scoreSkill(query: string, skill: SkillDefinition): number {
  const terms = tokenize(query)
  if (terms.length === 0) return 0

  const nameTokens = new Set(tokenize(`${skill.id} ${skill.name}`))
  const tagTokens = new Set(tokenize(`${(skill.tags ?? []).join(" ")} ${skill.whenToUse ?? ""}`))
  const descTokens = new Set(tokenize(skill.description))
  const bodyTokens = new Set(tokenize(skill.prompt))

  let score = 0
  for (const term of terms) {
    if (nameTokens.has(term)) score += 3
    if (tagTokens.has(term)) score += 2
    if (descTokens.has(term)) score += 1.5
    else if (bodyTokens.has(term)) score += 0.5
  }
  // Long requests should not out-score short ones just for having more words.
  return score / Math.sqrt(terms.length)
}

export interface SelectSkillsOptions {
  limit?: number
  /** Minimum score before a skill is considered relevant. */
  minScore?: number
}

/**
 * Picks the skills that apply to a request. Returns [] when nothing matches
 * well enough — a wrong skill is worse than none, because it steers the model
 * into a method the user did not ask for.
 */
export function selectSkills(
  query: string,
  skills: SkillDefinition[],
  options: SelectSkillsOptions = {},
): ScoredSkill[] {
  const { limit = 2, minScore = 3 } = options
  const scored = skills
    .map((skill) => ({ skill, score: scoreSkill(query, skill) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** Renders the skills that apply to a request as a system-prompt section. */
export function skillsToPromptSection(matches: ScoredSkill[]): string | undefined {
  if (matches.length === 0) return undefined
  const lines: string[] = []
  if (matches.length === 1) {
    lines.push(`Apply the "${matches[0]!.skill.name}" approach to this request:`)
  } else {
    lines.push("These approaches from your skill library apply:")
  }
  for (const { skill } of matches) {
    lines.push(`\n## Skill: ${skill.name}\n${skill.prompt.trim()}`)
  }
  return lines.join("\n")
}

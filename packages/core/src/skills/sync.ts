/**
 * Skill packs — import published skill collections into IMURUN.
 *
 * A skill pack is any public GitHub repository laid out like the Agent Skills
 * convention: a folder per skill containing a `SKILL.md` with `name` and
 * `description` frontmatter. The default source is Anthropic's public skills
 * repository.
 *
 * Two rules keep this safe and predictable:
 *   1. Nothing is allowed to silently replace a built-in skill. A name clash is
 *      imported under `<owner>-<name>` instead.
 *   2. Source-available (non-open-source) skills are skipped unless the caller
 *      explicitly opts in — IMURUN only ships free, open licences by default.
 *
 * The import is one API call (the repo tree) plus one request per skill file,
 * which keeps it well inside GitHub's unauthenticated rate limit.
 */
import { join } from "node:path"
import { ensureDir, logger, writeFileAtomic } from "@imurun/util"
import { BUILTIN_SKILLS, formatSkillMarkdown, parseSkillMarkdown, skillsDir } from "../agent/skills"
import { githubHeaders } from "../github/client"
import type { SkillDefinition } from "../agent/skills"

export const DEFAULT_SKILL_SOURCE = "anthropics/skills"

/** A pack worth knowing by name, so `sync <short-name>` is enough. */
export interface SkillPackPreset {
  id: string
  source: string
  /** The pack's licence, as recorded on every imported skill. */
  license: string
  description: string
  /**
   * Skill ids that do not apply to IMURUN. Repository-maintenance tools are the
   * usual case: a migration doctor for another project's storage layout has
   * nothing to say here.
   */
  skip?: string[]
  /** Skills that need a port before they are useful; recorded, then skipped. */
  needsPort?: string[]
}

export const SKILL_PACK_PRESETS: SkillPackPreset[] = [
  {
    id: "anthropic",
    source: "anthropics/skills",
    license: "mixed (per skill)",
    description: "The general-purpose Agent Skills collection.",
  },
  {
    id: "second-brain",
    source: "smixs/agent-second-brain",
    license: "MIT",
    description: "Capture, review and resurface what was learned — the companion skills to the memory vault.",
    // A v1→v2 upgrade doctor for that project's own storage, and a processor
    // that expects its own data layout; neither means anything inside IMURUN.
    skip: ["migrate-doctor", "dbrain-processor"],
  },
]

/** Resolves a preset id (or a full `owner/repo`) to its preset, when known. */
export function resolveSkillPreset(source: string | undefined): SkillPackPreset | undefined {
  if (!source) return undefined
  const key = source.trim().toLowerCase()
  return SKILL_PACK_PRESETS.find(
    (preset) => preset.id === key || preset.source.toLowerCase() === key.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, ""),
  )
}

/** Nicer IMURUN ids for a few well-known pack skills. */
const RENAMES: Record<string, string> = {
  "skill-creator": "create-skill",
  "web-artifacts-builder": "single-page-app",
  "webapp-testing": "browser-testing",
  "canvas-design": "canvas-graphics",
  "brand-guidelines": "brand-system",
  "slack-gif-creator": "animated-gif",
  "theme-factory": "ui-theme",
  "internal-comms": "internal-writing",
  "doc-coauthoring": "coauthor-doc",
  "discernment-nudge": "critical-thinking",
}

/** Known source-available packs that must not be redistributed by default. */
const RESTRICTED = new Set(["docx", "pdf", "pptx", "xlsx"])

export interface SkillSyncOptions {
  /** "owner/repo", a GitHub URL, or a raw tree of skills. */
  source?: string
  branch?: string
  /** Import source-available skills too (not recommended). */
  includeRestricted?: boolean
  /** Where to write. Defaults to ~/.imurun/skills. */
  dir?: string
  onStatus?: (message: string) => void
  fetchImpl?: typeof fetch
}

export interface SkippedSkill {
  id: string
  reason: string
}

export interface SkillSyncResult {
  source: string
  dir: string
  imported: SkillDefinition[]
  skipped: SkippedSkill[]
  replaced: string[]
}

interface TreeEntry {
  path: string
  type: string
}

function parseSource(source: string): { owner: string; repo: string } {
  const cleaned = source
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  const [owner, repo] = cleaned.split("/")
  if (!owner || !repo) {
    throw new Error(`Skill source must look like "owner/repo" — got "${source}".`)
  }
  return { owner, repo }
}

function kebab(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const PERMISSIVE = /(apache license|mit license|bsd license|isc license|mozilla public license)/i

async function readLicense(
  api: (path: string) => Promise<string | undefined>,
  entries: TreeEntry[],
  skillPath: string,
): Promise<string | undefined> {
  const licenseEntry = entries.find(
    (entry) => entry.type === "blob" && entry.path.startsWith(`${skillPath}/`) && /(^|\/)LICENSE/i.test(entry.path),
  )
  if (!licenseEntry) return undefined
  const text = await api(licenseEntry.path)
  if (!text) return undefined
  if (PERMISSIVE.test(text)) {
    if (/mit license/i.test(text)) return "MIT"
    if (/apache license/i.test(text)) return "Apache-2.0"
    return "Permissive"
  }
  return undefined
}

/**
 * Downloads a skill pack and writes each skill as `<skills-dir>/<id>.md`.
 * Re-running updates in place; skills the user has edited are still overwritten,
 * which is why the file records its `origin` so the overwrite is explainable.
 */
export async function syncSkillPack(options: SkillSyncOptions = {}): Promise<SkillSyncResult> {
  const preset = resolveSkillPreset(options.source)
  const source = preset?.source ?? options.source ?? DEFAULT_SKILL_SOURCE
  const { owner, repo } = parseSource(source)
  const branch = options.branch ?? "main"
  const dir = options.dir ?? skillsDir()
  const doFetch = options.fetchImpl ?? fetch
  const status = options.onStatus ?? (() => {})

  await ensureDir(dir)

  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  status(`reading ${owner}/${repo} skill tree`)
  // The token raises the rate limit and reaches private packs. It is read
  // from the environment and goes into a header — never into the URL.
  const treeResponse = await doFetch(treeUrl, { headers: githubHeaders() })
  if (!treeResponse.ok) {
    const limited = treeResponse.status === 403 || treeResponse.status === 429
    throw new Error(
      `Could not read ${owner}/${repo} (${treeResponse.status}). ` +
        (limited
          ? `GitHub's rate limit may have been reached — set GITHUB_TOKEN for 5,000 requests an hour. `
          : `Check the source name and your network connection. `),
    )
  }
  const tree = (await treeResponse.json()) as { tree?: TreeEntry[] }
  const entries = tree.tree ?? []

  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`
  const api = async (path: string): Promise<string | undefined> => {
    const response = await doFetch(rawBase + path, { headers: githubHeaders() })
    if (!response.ok) return undefined
    return response.text()
  }

  // Skill manifests: <root>/<id>/SKILL.md, anywhere in the tree.
  const manifests = entries.filter((entry) => entry.type === "blob" && /(^|\/)SKILL\.md$/i.test(entry.path))
  if (manifests.length === 0) {
    throw new Error(`No SKILL.md files found in ${owner}/${repo}. Is that a skill pack?`)
  }

  const builtinIds = new Set(BUILTIN_SKILLS.map((skill) => skill.id))
  const imported: SkillDefinition[] = []
  const skipped: SkippedSkill[] = []
  const replaced: string[] = []

  for (const manifest of manifests) {
    const folder = manifest.path.split("/").slice(0, -1).pop() ?? manifest.path
    const rawId = kebab(folder)
    const id = RENAMES[rawId] ?? rawId

    if (RESTRICTED.has(rawId) && !options.includeRestricted) {
      skipped.push({ id, reason: "source-available (not an open licence) — pass --include-restricted to import" })
      continue
    }

    // A preset knows which of its skills are for another project's plumbing.
    if (preset?.skip?.includes(rawId) || preset?.skip?.includes(id)) {
      skipped.push({ id, reason: `does not apply to IMURUN (${preset.id} preset)` })
      continue
    }
    if (preset?.needsPort?.includes(rawId) || preset?.needsPort?.includes(id)) {
      skipped.push({ id, reason: "expects another project's data layout — port it first" })
      continue
    }

    const folderPath = manifest.path.split("/").slice(0, -1).join("/")
    const license = await readLicense(api, entries, folderPath)

    const text = await api(manifest.path)
    if (!text) {
      skipped.push({ id, reason: "could not download SKILL.md" })
      continue
    }

    const parsed = parseSkillMarkdown(text, id, "global")
    if (!parsed) {
      skipped.push({ id, reason: "SKILL.md has no instructions" })
      continue
    }

    // Never let a pack shadow a built-in: qualify the name instead.
    const localId = builtinIds.has(id) ? kebab(`${owner}-${id}`) : id
    if (localId !== id) replaced.push(`${id} → ${localId}`)

    const skill: SkillDefinition = {
      ...parsed,
      id: localId,
      source: "global",
      origin: `https://github.com/${owner}/${repo}`,
      license: license ?? preset?.license ?? "see repository",
      tags: parsed.tags ?? folder.split(/[-_]/).filter(Boolean),
    }

    await writeFileAtomic(join(dir, `${localId}.md`), formatSkillMarkdown(skill))
    imported.push(skill)
    status(`imported ${localId}`)
  }

  logger.info(`skill pack ${owner}/${repo}: ${imported.length} imported, ${skipped.length} skipped`)
  return { source: `${owner}/${repo}`, dir, imported, skipped, replaced }
}

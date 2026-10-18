/**
 * imurun skills — the skill library, from the command line.
 *
 *   imurun skills                       everything available, by source
 *   imurun skills show <id>             print one skill's instructions
 *   imurun skills find <query>          what the router would pick for a request
 *   imurun skills sync [owner/repo]     import a published skill pack
 *   imurun skills dir                   where skills are read from
 *
 * The same library the interactive session uses: built-ins ship with IMURUN,
 * imported packs land in ~/.imurun/skills, and a project can add its own under
 * .imurun/skills.
 */
import chalk from "chalk"
import {
  BUILTIN_SKILLS,
  DEFAULT_SKILL_SOURCE,
  getSkill,
  loadSkills,
  scoreSkill,
  skillsDir,
  syncSkillPack,
  type SkillDefinition,
} from "@imurun/core"
import type { Command } from "../framework/command"

const SOURCE_LABELS: Record<SkillDefinition["source"], string> = {
  builtin: "Built-in",
  global: "Imported (~/.imurun/skills)",
  project: "Project (.imurun/skills)",
}

export const skillsCommand: Command = {
  name: "skills",
  summary: "List, inspect, search, and import skills",
  usage:
    "imurun skills [list|show <id>|find <query>|sync [owner/repo]|dir] [--include-restricted] [--branch B] [--limit N]",
  options: [
    { name: "include-restricted", type: "boolean", description: "Import source-available skills too (not recommended)" },
    { name: "branch", type: "string", description: "Git branch of the skill pack to read (default: main)" },
    { name: "limit", type: "string", description: "With find: how many matches to show (default 8)" },
    { name: "all", type: "boolean", description: "With list: include the description of every skill" },
    { name: "json", type: "boolean", description: "Machine-readable output" },
  ],

  async run({ args, options }) {
    const sub = (args[0] ?? "list").toLowerCase()

    switch (sub) {
      case "list":
      case "ls":
        return listSkills({ json: options.json === true, verbose: options.all === true })

      case "show":
      case "print":
      case "cat": {
        const id = args[1]
        if (!id) {
          console.error("  Usage: imurun skills show <id>")
          return 1
        }
        return showSkill(id)
      }

      case "find":
      case "search":
      case "match": {
        const query = args.slice(1).join(" ").trim()
        if (!query) {
          console.error('  Usage: imurun skills find "build me a landing page"')
          return 1
        }
        return findSkills(query, Number(options.limit ?? 8) || 8)
      }

      case "sync":
      case "import":
      case "add":
        return syncSkills(args[1], {
          includeRestricted: options["include-restricted"] === true,
          branch: options.branch ? String(options.branch) : undefined,
        })

      case "dir":
      case "where":
        console.log("")
        console.log(`  skills directory  ${chalk.cyan(skillsDir())}`)
        console.log(`  project override  ${chalk.gray("<project>/.imurun/skills")}`)
        console.log("")
        return 0

      default:
        // `imurun skills <id>` is a convenient shorthand for `show <id>`.
        if (getSkill(BUILTIN_SKILLS, sub)) return showSkill(sub)
        console.error(`  ✖ Unknown subcommand: ${sub}`)
        console.error("  Try: imurun skills list | show <id> | find <query> | sync [owner/repo] | dir")
        return 1
    }
  },
}

// ── Subcommand implementations ──────────────────────────────────────────────

async function listSkills(opts: { json: boolean; verbose: boolean }): Promise<number> {
  const skills = await loadSkills({ workingDir: process.cwd() })

  if (opts.json) {
    console.log(JSON.stringify(skills.map(({ prompt, ...rest }) => ({ ...rest, promptChars: prompt.length })), null, 2))
    return 0
  }

  const groups: Array<SkillDefinition["source"]> = ["builtin", "global", "project"]
  const counts = groups.map((source) => skills.filter((skill) => skill.source === source).length)

  console.log("")
  console.log(
    `  ${chalk.bold("Skills")} ${chalk.gray(
      `· ${counts[0]} built in · ${counts[1]} imported · ${counts[2]} project · ${skills.length} total`,
    )}`,
  )

  for (const source of groups) {
    const group = skills.filter((skill) => skill.source === source)
    if (group.length === 0) continue
    console.log("")
    console.log(`  ${chalk.bold(SOURCE_LABELS[source])} ${chalk.gray(`(${group.length})`)}`)
    for (const skill of group) {
      const tags = skill.tags?.length ? chalk.gray(`  ${skill.tags.slice(0, 4).join(" ")}`) : ""
      console.log(`    ${chalk.cyan(skill.id.padEnd(26))} ${describe(skill, opts.verbose)}${tags}`)
    }
  }

  console.log("")
  console.log(`  ${chalk.gray("read one with:")}  ${chalk.cyan("imurun skills show <id>")}`)
  console.log(`  ${chalk.gray("what would match:")} ${chalk.cyan('imurun skills find "add a dark mode toggle"')}`)
  console.log(`  ${chalk.gray("add a pack:")}     ${chalk.cyan("imurun skills sync")} ${chalk.gray(`(${DEFAULT_SKILL_SOURCE})`)}`)
  console.log("")
  return 0
}

function describe(skill: SkillDefinition, verbose: boolean): string {
  if (verbose) return skill.description
  const text = skill.description || skill.name
  return text.length > 62 ? `${text.slice(0, 61)}…` : text
}

async function showSkill(id: string): Promise<number> {
  const skills = await loadSkills({ workingDir: process.cwd() })
  const skill = getSkill(skills, id)
  if (!skill) {
    console.error(`  ✖ Unknown skill "${id}".`)
    console.error("    See them all with `imurun skills list`, or find one with `imurun skills find <query>`.")
    return 1
  }

  console.log("")
  console.log(`  ${chalk.bold(skill.name)} ${chalk.gray(`(${skill.id})`)}`)
  console.log(`  ${chalk.gray(skill.description)}`)
  const bits = [SOURCE_LABELS[skill.source]]
  if (skill.tags?.length) bits.push(skill.tags.join(", "))
  if (skill.license) bits.push(skill.license)
  console.log(`  ${chalk.gray(bits.join("  ·  "))}`)
  if (skill.origin) console.log(`  ${chalk.gray(skill.origin)}`)
  console.log("")
  console.log(skill.prompt.trim().replace(/^/gm, "  "))
  console.log("")
  return 0
}

/** Shows what the automatic router would choose for a request. */
async function findSkills(query: string, limit: number): Promise<number> {
  const skills = await loadSkills({ workingDir: process.cwd() })
  const ranked = skills
    .map((skill) => ({ skill, score: scoreSkill(query, skill) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  console.log("")
  console.log(`  ${chalk.gray("request")}  ${chalk.white(query)}`)
  console.log("")
  if (ranked.length === 0) {
    console.log(`  ${chalk.gray("no skill matches — the model would answer unaided")}`)
    console.log("")
    return 0
  }

  const best = ranked[0]!.score
  for (const { skill, score } of ranked) {
    const bar = "█".repeat(Math.max(1, Math.round((score / best) * 12)))
    const chosen = score >= 3 ? chalk.green("●") : chalk.gray("○")
    console.log(
      `    ${chosen} ${chalk.cyan(skill.id.padEnd(24))} ${chalk.gray(bar.padEnd(13))} ${chalk.white(score.toFixed(1).padStart(5))}  ${chalk.gray(skill.name)}`,
    )
  }
  console.log("")
  console.log(
    `  ${chalk.gray("● above the threshold the router injects automatically (≥ 3.0); ○ is shown for context only")}`,
  )
  console.log("")
  return 0
}

async function syncSkills(
  source: string | undefined,
  opts: { includeRestricted: boolean; branch?: string },
): Promise<number> {
  const target = source ?? DEFAULT_SKILL_SOURCE
  console.log("")
  console.log(`  ${chalk.bold("Importing skills")} ${chalk.gray("from")} ${chalk.cyan(target)}`)
  if (opts.includeRestricted) console.log(`  ${chalk.yellow("including source-available skills")}`)
  console.log("")

  try {
    const result = await syncSkillPack({
      source: target,
      branch: opts.branch,
      includeRestricted: opts.includeRestricted,
      onStatus: (message) => console.log(`    ${chalk.gray("•")} ${message}`),
    })

    console.log("")
    console.log(`  ${chalk.green("✔")} imported ${chalk.bold(result.imported.length)} skill(s)`)
    if (result.imported.length > 0) {
      console.log(`    ${chalk.gray(result.imported.map((skill) => skill.id).join(", "))}`)
    }
    if (result.replaced.length > 0) {
      console.log(`  ${chalk.gray("renamed to avoid shadowing a built-in:")} ${result.replaced.join(", ")}`)
    }
    if (result.skipped.length > 0) {
      console.log(`  ${chalk.yellow("skipped")} ${result.skipped.length}:`)
      for (const skip of result.skipped) {
        console.log(`    ${chalk.gray(`${skip.id} — ${skip.reason}`)}`)
      }
    }
    console.log(`  ${chalk.gray("written to")} ${chalk.cyan(result.dir)}`)
    console.log("")
    console.log(`  ${chalk.gray("use one with:")} ${chalk.cyan("imurun skills show <id>")}`)
    console.log("")
    return 0
  } catch (error) {
    console.error("")
    console.error(`  ✖ ${error instanceof Error ? error.message : String(error)}`)
    console.error("")
    return 1
  }
}

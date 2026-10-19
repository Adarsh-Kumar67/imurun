/**
 * imurun rag — the offline project index behind code_search.
 *
 *   imurun rag                    show what is indexed for this directory
 *   imurun rag index              build or update it now
 *   imurun rag search <query>     search it from the shell
 *   imurun rag clear              delete the index (and its snapshot)
 *
 * The agent keeps this index up to date by itself; the command exists so you can
 * see what it knows, warm it before a long session, or work out why a search did
 * not find something.
 */
import chalk from "chalk"
import { clearRagCache, formatRagHit, loadConfigSafe, projectRagIndex, refreshRagIndex, type RagIndex, type RagSearchHit } from "@imurun/core"
import { formatBytes, formatTimestamp } from "@imurun/util"
import type { Command } from "../framework/command"

const DEFAULT_LIMIT = 10

export const ragCommand: Command = {
  name: "rag",
  summary: "Search the offline project index, or refresh it",
  usage: "imurun rag [status|index|search <query>|clear] [--path <fragment>] [--limit N] [--json]",
  options: [
    { name: "path", type: "string", description: "Restrict matches to paths containing this fragment" },
    { name: "limit", type: "string", description: `Maximum results (default ${DEFAULT_LIMIT})` },
    { name: "json", type: "boolean", description: "Machine-readable output" },
  ],

  async run({ args, options }): Promise<number> {
    const sub = (args[0] ?? "status").toLowerCase()
    // The index is configured from the project's own config, so the limits,
    // chunking and exclusion list are the ones the docs describe.
    const { loaded } = await loadConfigSafe(process.cwd())
    const config = loaded.config
    const index = projectRagIndex(process.cwd(), config)
    const json = options.json === true
    const limit = Math.max(Number(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1)
    const pathFilter = options.path ? String(options.path) : undefined

    switch (sub) {
      case "status":
      case "info":
        return showStatus(index, json, config.rag)

      case "index":
      case "refresh":
        return runIndex(index)

      case "clear":
        await index.clear()
        clearRagCache()
        console.log(`\n  ${chalk.green("✔")} project index cleared\n`)
        return 0

      case "search":
      case "find":
      case "query": {
        const query = args.slice(1).join(" ").trim()
        if (!query) {
          console.error('  Usage: imurun rag search "where are permissions checked"')
          return 1
        }
        await refreshRagIndex(index, config)
        return runSearch(index, query, limit, pathFilter, json)
      }

      default: {
        // `imurun rag <words>` is shorthand for a search.
        const query = args.join(" ").trim()
        if (!query) {
          console.error("  Try: imurun rag status | index | search <query> | clear")
          return 1
        }
        await refreshRagIndex(index, config)
        return runSearch(index, query, limit, pathFilter, json)
      }
    }
  },
}

type Index = RagIndex

function showStatus(index: Index, json: boolean, settings: { enabled: boolean; watch: boolean; autoInject: boolean; maxInjectChunks: number }): number {
  const stats = index.stats()
  if (json) {
    console.log(JSON.stringify({ ...stats, settings }, null, 2))
    return 0
  }
  console.log("")
  console.log(`  ${chalk.bold("Project index")} ${chalk.gray(stats.root)}`)
  console.log(
    `    settings  ${chalk.gray(
      settings.enabled
        ? `watching ${settings.watch ? "on" : "off"} · auto-inject ${settings.autoInject ? "on" : "off"} · ${settings.maxInjectChunks} chunk(s)/turn`
        : "disabled (rag.enabled is false)",
    )}`,
  )
  if (stats.builtAt === 0) {
    console.log(`    ${chalk.gray("not built yet — run 'imurun rag index'")}`)
  } else {
    console.log(`    files     ${chalk.white(String(stats.files))}`)
    console.log(`    chunks    ${chalk.white(String(stats.chunks))}`)
    console.log(`    size      ${chalk.white(formatBytes(stats.characters))}`)
    console.log(`    updated   ${chalk.white(formatTimestamp(stats.builtAt))}`)
    console.log(`    snapshot  ${chalk.gray(stats.persistPath)}`)
  }
  console.log("")
  return 0
}

async function runIndex(index: Index): Promise<number> {
  process.stdout.write(`  ${chalk.gray("indexing")} ${chalk.cyan(process.cwd())} … `)
  const result = await index.refresh()
  if (!result.changedAnything) {
    process.stdout.write(`${chalk.gray("already up to date")}\n\n`)
    return 0
  }
  process.stdout.write(`${chalk.green("done")}\n`)
  console.log(
    `  ${chalk.gray(
      `${result.files} file(s) · +${result.added} new · ~${result.changed} changed · -${result.removed} gone · ${result.chunks} chunks`,
    )}\n`,
  )
  return 0
}

async function runSearch(
  index: Index,
  query: string,
  limit: number,
  pathFilter: string | undefined,
  json: boolean,
): Promise<number> {
  await index.ensureFresh()
  const hits = index.search(query, { limit, path: pathFilter })

  if (json) {
    console.log(JSON.stringify(hits, null, 2))
    return hits.length > 0 ? 0 : 1
  }

  console.log("")
  if (hits.length === 0) {
    console.log(`  ${chalk.gray(`nothing matches "${query}"`)}`)
    console.log(`  ${chalk.gray(`the index covers ${index.stats().files} file(s) of this project`)}`)
    console.log("")
    return 1
  }
  printHits(hits)
  return 0
}

function printHits(hits: RagSearchHit[]): void {
  for (const hit of hits) {
    const [header, ...body] = formatRagHit(hit).split("\n")
    console.log(`  ${chalk.cyan(header ?? "")}`)
    for (const line of body.slice(0, 6)) console.log(chalk.gray(line))
    console.log("")
  }
}

/**
 * Config discovery — finds imurun.json(c) files.
 *
 * Search order (closest wins):
 *   ~/.imurun/imurun.json                     global config
 *   <ancestors>/imurun.json(c)                project configs (root → cwd)
 *   <ancestors>/.imurun/imurun.json(c)        project configs (root → cwd)
 *
 * The working directory and every ancestor up to the filesystem root are
 * scanned so monorepo packages inherit the repository-level config.
 */
import { join, dirname, parse } from "node:path"
import { fileExists, imurunDir } from "@imurun/util"

export interface DiscoveredConfig {
  path: string
  scope: "global" | "project"
}

const CONFIG_FILENAMES = ["imurun.json", "imurun.jsonc"]
const PROJECT_CONFIG_DIRS = ["", ".imurun"]

/** Returns the global config path (may not exist). */
export function globalConfigPath(): string {
  return imurunDir("imurun.json")
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return undefined
}

function candidatePaths(dir: string): string[] {
  const out: string[] = []
  for (const sub of PROJECT_CONFIG_DIRS) {
    for (const name of CONFIG_FILENAMES) {
      out.push(sub ? join(dir, sub, name) : join(dir, name))
    }
  }
  return out
}

/**
 * Discovers all config files applicable to `cwd`, from lowest to highest
 * precedence: [global, ...project (root → cwd)].
 */
export async function discoverConfigs(cwd: string): Promise<DiscoveredConfig[]> {
  const results: DiscoveredConfig[] = []

  const globalPath = await firstExisting([
    globalConfigPath(),
    imurunDir("imurun.jsonc"),
  ])
  if (globalPath) results.push({ path: globalPath, scope: "global" })

  // walk from cwd up to the filesystem root, collecting project configs
  const chain: string[] = []
  let dir = cwd
  while (true) {
    chain.push(dir)
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root) break
    dir = parent
  }

  // root-most first so closer configs override
  for (const p of chain.reverse()) {
    const found = await firstExisting(candidatePaths(p))
    if (found) results.push({ path: found, scope: "project" })
  }

  return results
}

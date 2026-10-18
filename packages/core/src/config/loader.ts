/**
 * Config loader — reads, merges, and validates imurun.json(c) files.
 *
 * Merge order (lowest to highest precedence):
 *   1. built-in defaults
 *   2. global config      ~/.imurun/imurun.json
 *   3. project configs    root-most ancestor → working directory
 *   4. inline overrides   (tests, CLI flags)
 */
import { z } from "zod"
import { ImurunConfig, type ImurunConfigInput } from "@imurun/schema"
import { deepMerge, isPlainObject, logger, parseJsonc, readText, writeJsonAtomic } from "@imurun/util"
import { discoverConfigs, globalConfigPath, type DiscoveredConfig } from "./discovery"

export interface LoadedConfig {
  config: ImurunConfig
  /** Files that contributed, lowest to highest precedence. */
  sources: string[]
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "ConfigError"
  }
}

async function readConfigFile(path: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readText(path)
  } catch (error) {
    throw new ConfigError(`Unable to read config file: ${path}`, path, error)
  }
  try {
    const parsed = parseJsonc(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("config root must be an object")
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new ConfigError(`Invalid config file (must be JSON or JSONC): ${path}`, path, error)
  }
}

/**
 * Older configs wrote `permissions` as a bare array of rules. Accept that shape
 * and fold it into the current one instead of failing validation.
 */
function migrateLegacyConfig(input: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(input.permissions)) {
    return { ...input, permissions: { rules: input.permissions } }
  }
  return input
}

/** Loads and validates the effective configuration for a working directory. */
export async function loadConfig(
  cwd: string,
  overrides: ImurunConfigInput = {},
): Promise<LoadedConfig> {
  const discovered = await discoverConfigs(cwd)
  return loadFromDiscovered(discovered, overrides)
}

/** Same as loadConfig but with explicit discovery results (tests). */
export async function loadFromDiscovered(
  discovered: DiscoveredConfig[],
  overrides: ImurunConfigInput = {},
): Promise<LoadedConfig> {
  let merged: Record<string, unknown> = {}
  const sources: string[] = []

  for (const found of discovered) {
    const data = await readConfigFile(found.path)
    merged = deepMerge(merged, data)
    sources.push(found.path)
  }

  merged = deepMerge(merged, overrides as Record<string, unknown>)
  merged = migrateLegacyConfig(merged)

  const result = ImurunConfig.safeParse(merged)
  if (!result.success) {
    const details = z.prettifyError(result.error)
    const where = sources.length > 0 ? sources[sources.length - 1]! : "(defaults)"
    throw new ConfigError(`Invalid IMURUN configuration in ${where}:\n${details}`, where, result.error)
  }

  logger.debug(`config loaded from ${sources.length} source(s)`)
  return { config: result.data, sources }
}

/** Loads without throwing — returns defaults plus an error note when invalid. */
export async function loadConfigSafe(
  cwd: string,
  overrides: ImurunConfigInput = {},
): Promise<{ loaded: LoadedConfig; error?: ConfigError }> {
  try {
    return { loaded: await loadConfig(cwd, overrides) }
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.warn(error.message)
      return {
        loaded: { config: ImurunConfig.parse({}), sources: [] },
        error,
      }
    }
    throw error
  }
}

/** Writes the global config file (~/.imurun/imurun.json). */
export async function saveGlobalConfig(config: ImurunConfigInput): Promise<string> {
  const path = globalConfigPath()
  await writeJsonAtomic(path, config)
  return path
}

/**
 * Merges a patch into the global config file, leaving every other key alone.
 * Used for small edits made from the UI (adding a provider, remembering the
 * chosen model) that must not flatten the rest of the user's configuration.
 */
export async function patchGlobalConfig(patch: ImurunConfigInput): Promise<string> {
  const path = globalConfigPath()
  let existing: Record<string, unknown> = {}
  try {
    existing = migrateLegacyConfig(await readConfigFile(path))
  } catch {
    // No file yet, or unreadable: start from what we were given.
    existing = {}
  }
  await writeJsonAtomic(path, deepMerge(existing, patch as Record<string, unknown>))
  return path
}

/**
 * Removes one entry from a record-valued section of the global config — used to
 * forget a provider without rewriting (and thereby flattening) everything else.
 */
export async function removeGlobalConfigEntry(section: string, key: string): Promise<string> {
  const path = globalConfigPath()
  let existing: Record<string, unknown>
  try {
    existing = migrateLegacyConfig(await readConfigFile(path))
  } catch {
    return path
  }
  const entries = existing[section]
  if (isPlainObject(entries) && key in entries) {
    const next = { ...entries }
    delete next[key]
    existing = { ...existing, [section]: next }
    await writeJsonAtomic(path, existing)
  }
  return path
}

/** Writes a project config file at <dir>/imurun.json. */
export async function saveProjectConfig(dir: string, config: ImurunConfigInput): Promise<string> {
  const path = `${dir}/imurun.json`
  await writeJsonAtomic(path, config)
  return path
}

/** Serializes a config with its $schema reference for editor support. */
export function withSchemaRef(config: ImurunConfigInput): ImurunConfigInput {
  return { $schema: "https://imurun.dev/config.json", ...config }
}

export { discoverConfigs, globalConfigPath } from "./discovery"
export type { DiscoveredConfig } from "./discovery"

/**
 * Installed-model store — the registry of everything `imurun` has downloaded.
 * A single JSON file at ~/.imurun/models/installed.json, easy to inspect and
 * back up. GGUF files live next to it under ~/.imurun/models/gguf/.
 */
import { readdir, rm, stat } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join } from "node:path"
import type { InstalledModel } from "@imurun/schema"
import { ensureDir, modelsDir, readGgufInfo, readJson, writeJsonAtomic } from "@imurun/util"

/** Cached context windows, keyed by path + size, so listing stays cheap. */
const contextCache = new Map<string, number>()

/**
 * Fills in the model's trained context window by reading the GGUF header.
 *
 * Entries installed before the field existed (or imported by hand) have no
 * `contextLength`; without it the engine used to fall back to llama.cpp's 4096
 * default and refuse perfectly normal requests. Reading the file fixes those
 * installs in place, once.
 */
async function backfillContextLength(entry: InstalledModel): Promise<boolean> {
  if (entry.contextLength && entry.contextLength > 0) return false
  const stats = await stat(entry.path).catch(() => undefined)
  if (!stats) return false
  const key = `${entry.path}\u0000${stats.size}`
  let length = contextCache.get(key)
  if (length === undefined) {
    length = (await readGgufInfo(entry.path).catch(() => undefined))?.contextLength ?? 0
    contextCache.set(key, length)
  }
  if (length > 0) {
    entry.contextLength = length
    return true
  }
  return false
}

export function ggufDir(): string {
  return join(modelsDir(), "gguf")
}

export function installedRegistryPath(): string {
  return join(modelsDir(), "installed.json")
}

interface RegistryFile {
  version: 1
  models: InstalledModel[]
}

async function loadRegistry(): Promise<RegistryFile> {
  const data = await readJson<RegistryFile>(installedRegistryPath())
  if (!data || !Array.isArray(data.models)) return { version: 1, models: [] }
  return { version: 1, models: data.models }
}

async function saveRegistry(registry: RegistryFile): Promise<void> {
  await ensureDir(modelsDir())
  await writeJsonAtomic(installedRegistryPath(), registry)
}

export async function listInstalled(): Promise<InstalledModel[]> {
  const registry = await loadRegistry()
  // heal entries whose files were deleted outside imurun, and fill in the
  // trained context window for entries that predate it
  const healed: InstalledModel[] = []
  let changed = false
  for (const entry of registry.models) {
    try {
      await stat(entry.path)
    } catch {
      changed = true
      continue // drop stale entry
    }
    if (await backfillContextLength(entry)) changed = true
    healed.push(entry)
  }
  if (changed) {
    await saveRegistry({ version: 1, models: healed })
  }
  return healed
}

export async function getInstalled(modelId: string): Promise<InstalledModel | undefined> {
  const all = await listInstalled()
  return all.find((m) => m.modelId === modelId)
}

export async function addInstalled(model: InstalledModel): Promise<void> {
  const registry = await loadRegistry()
  registry.models = registry.models.filter((m) => !(m.modelId === model.modelId && m.quant === model.quant))
  registry.models.push(model)
  await saveRegistry(registry)
}

export async function updateInstalled(modelId: string, patch: Partial<InstalledModel>): Promise<void> {
  const registry = await loadRegistry()
  registry.models = registry.models.map((m) => (m.modelId === modelId ? { ...m, ...patch } : m))
  await saveRegistry(registry)
}

/** True when a reference names an entry (id, model id, or model-quant). */
function matchesRef(entry: InstalledModel, ref: string): boolean {
  const lower = ref.toLowerCase()
  return (
    entry.id.toLowerCase() === lower ||
    entry.modelId.toLowerCase() === lower ||
    `${entry.modelId}-${entry.quant}`.toLowerCase() === lower
  )
}

/** Removes the registry entry and deletes the GGUF file from disk. */
export async function removeInstalled(ref: string, deleteFiles = true): Promise<InstalledModel | undefined> {
  const registry = await loadRegistry()
  const entry = registry.models.find((m) => matchesRef(m, ref))
  registry.models = registry.models.filter((m) => !matchesRef(m, ref))
  await saveRegistry(registry)
  if (entry && deleteFiles) {
    await rm(entry.path, { force: true })
    if (entry.mmprojPath) await rm(entry.mmprojPath, { force: true })
  }
  return entry
}

/**
 * Removes every installed model. With deleteFiles = false the registry is
 * emptied but the GGUF files stay on disk (a re-install then reuses them).
 */
export async function removeAllInstalled(deleteFiles = true): Promise<{ count: number; freedBytes: number }> {
  const registry = await loadRegistry()
  let freedBytes = 0
  for (const entry of registry.models) {
    freedBytes += entry.sizeBytes
    if (deleteFiles) {
      await rm(entry.path, { force: true }).catch(() => {})
      if (entry.mmprojPath) await rm(entry.mmprojPath, { force: true }).catch(() => {})
    }
  }
  const count = registry.models.length
  await saveRegistry({ version: 1, models: [] })
  return { count, freedBytes }
}

/** Deletes leftover `*.part` files from interrupted downloads. */
export async function prunePartialDownloads(): Promise<{ count: number; freedBytes: number }> {
  let count = 0
  let freedBytes = 0
  let entries: Dirent[]
  try {
    entries = await readdir(ggufDir(), { withFileTypes: true })
  } catch {
    return { count, freedBytes }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".part")) continue
    const path = join(ggufDir(), entry.name)
    const info = await stat(path).catch(() => undefined)
    if (info) freedBytes += info.size
    await rm(path, { force: true }).catch(() => {})
    count++
  }
  return { count, freedBytes }
}

/** Total bytes used by installed models on disk. */
export async function installedBytes(): Promise<number> {
  const all = await listInstalled()
  return all.reduce((sum, m) => sum + m.sizeBytes, 0)
}

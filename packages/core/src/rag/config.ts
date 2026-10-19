/**
 * Bridges `config.rag` to the project index.
 *
 * The index has its own defaults so it works with no configuration at all; this
 * module is what makes the settings the docs describe the settings the index
 * actually runs with. One place maps config → options, and one place decides
 * whether a search may refresh the index.
 */
import type { ImurunConfig } from "@imurun/schema"
import {
  getRagIndex,
  RAG_FRESH_MS,
  type RagIndex,
  type RagIndexOptions,
  type RagRefreshResult,
} from "./index"

/** The index options a project's config asks for. */
export function ragIndexOptions(config: ImurunConfig): Omit<RagIndexOptions, "root"> {
  return {
    maxFileBytes: config.rag.maxFileSizeKB * 1024,
    maxFiles: config.rag.maxFiles,
    maxChunks: config.rag.maxChunks,
    chunkLines: config.rag.chunkLines,
    chunkChars: config.rag.chunkChars,
    chunkOverlapLines: config.rag.chunkOverlapLines,
    excludeGlobs: config.rag.excludeGlobs,
  }
}

/** The shared index for a project, configured from `config.rag`. */
export function projectRagIndex(root: string, config: ImurunConfig): RagIndex {
  return getRagIndex(root, ragIndexOptions(config))
}

/**
 * Brings an index up to date the way `rag.watch` asks for: re-check the files
 * before a search, or — with watching off — only build it when there is nothing
 * indexed yet, so a search never re-reads the project behind the user's back.
 */
export async function refreshRagIndex(
  index: RagIndex,
  config: ImurunConfig,
  force = false,
): Promise<RagRefreshResult | undefined> {
  if (force) return index.refresh()
  if (!config.rag.watch) return index.stats().chunks === 0 ? index.refresh() : undefined
  return index.ensureFresh({ maxAgeMs: RAG_FRESH_MS })
}

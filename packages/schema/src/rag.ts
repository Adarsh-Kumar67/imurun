/**
 * RAG schemas — indexed chunks and retrieval hits for the offline semantic
 * search engine.
 */
import { z } from "zod"

export const RagSource = z.enum(["code", "doc", "conversation", "web"])
export type RagSource = z.infer<typeof RagSource>

export const RagChunk = z.object({
  id: z.string(),
  source: RagSource,
  /** For code/doc chunks. */
  filePath: z.string().optional(),
  /** For conversation chunks. */
  sessionId: z.string().optional(),
  language: z.string().optional(),
  startLine: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  content: z.string(),
  /** Content hash for incremental re-indexing. */
  hash: z.string(),
  /** Embedding vector dimension depends on the embedder (384 for MiniLM). */
  indexedAt: z.number(),
})
export type RagChunk = z.infer<typeof RagChunk>

export const RagHit = z.object({
  chunk: RagChunk,
  score: z.number(),
  /** Which retrieval path found it. */
  via: z.enum(["vector", "bm25", "fused"]).default("fused"),
})
export type RagHit = z.infer<typeof RagHit>

export const RagIndexStats = z.object({
  totalChunks: z.number().int().nonnegative(),
  bySource: z.record(z.string(), z.number().int().nonnegative()).default({}),
  lastIndexedAt: z.number().optional(),
  watching: z.boolean().default(false),
  embeddingModel: z.string().optional(),
  dbBytes: z.number().int().nonnegative().default(0),
})
export type RagIndexStats = z.infer<typeof RagIndexStats>

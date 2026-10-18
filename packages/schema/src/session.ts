/**
 * Session schemas — conversations, messages, tool calls, and usage tracking.
 */
import { z } from "zod"

export const MessageRole = z.enum(["user", "assistant", "tool", "system"])
export type MessageRole = z.infer<typeof MessageRole>

export const TextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
})

export const ImagePart = z.object({
  type: z.literal("image"),
  mime: z.string(),
  /** Base64-encoded image data. Processed locally, never uploaded. */
  data: z.string(),
})

export const FilePart = z.object({
  type: z.literal("file"),
  path: z.string(),
  mime: z.string().optional(),
})

export const ContentPart = z.discriminatedUnion("type", [TextPart, ImagePart, FilePart])
export type ContentPart = z.infer<typeof ContentPart>

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
})
export type ToolCall = z.infer<typeof ToolCall>

export const MessageUsage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  /** Estimated cost in USD; 0 for local models. */
  cost: z.number().nonnegative().default(0),
})
export type MessageUsage = z.infer<typeof MessageUsage>

export const RagSourceRef = z.object({
  chunkId: z.string(),
  filePath: z.string().optional(),
  sessionId: z.string().optional(),
  score: z.number(),
})
export type RagSourceRef = z.infer<typeof RagSourceRef>

export const MessageMetadata = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  /** Set on role="tool" messages: the tool that produced this result. */
  toolName: z.string().optional(),
  ragSources: z.array(RagSourceRef).optional(),
  memoriesUsed: z.array(z.string()).optional(),
  /** Set when this message is part of a compaction summary. */
  compacted: z.boolean().optional(),
})
export type MessageMetadata = z.infer<typeof MessageMetadata>

export const Message = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRole,
  content: z.union([z.string(), z.array(ContentPart)]),
  toolCalls: z.array(ToolCall).optional(),
  /** Set on role="tool" messages: which call this is the result of. */
  toolCallId: z.string().optional(),
  createdAt: z.number(),
  usage: MessageUsage.optional(),
  metadata: MessageMetadata.optional(),
})
export type Message = z.infer<typeof Message>

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Model ID active in this session. */
  model: z.string().optional(),
  workingDir: z.string(),
  /** Generated summary, written on close or compaction. */
  summary: z.string().optional(),
  /** Extracted topics for cross-session recall. */
  topics: z.array(z.string()).default([]),
  parentSessionId: z.string().optional(),
  messageCount: z.number().int().nonnegative().default(0),
  /** Token totals accumulate as the session runs. */
  totalInputTokens: z.number().int().nonnegative().default(0),
  totalOutputTokens: z.number().int().nonnegative().default(0),
})
export type Session = z.infer<typeof Session>

/** Lightweight session descriptor for list views. */
export const SessionSummary = Session.pick({
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  model: true,
  messageCount: true,
})
export type SessionSummary = z.infer<typeof SessionSummary>

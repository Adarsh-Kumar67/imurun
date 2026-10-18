/**
 * Event schemas — the internal event bus carries these between the agent
 * engine, daemon, and UI layers.
 */
import { z } from "zod"

export const SessionCreatedEvent = z.object({
  type: z.literal("session.created"),
  sessionId: z.string(),
  title: z.string(),
})

export const SessionUpdatedEvent = z.object({
  type: z.literal("session.updated"),
  sessionId: z.string(),
  title: z.string().optional(),
  model: z.string().optional(),
  messageCount: z.number().int().optional(),
})

export const MessageCreatedEvent = z.object({
  type: z.literal("message.created"),
  sessionId: z.string(),
  messageId: z.string(),
  role: z.string(),
})

export const MessagePartEvent = z.object({
  type: z.literal("message.part"),
  sessionId: z.string(),
  messageId: z.string(),
  /** Streaming text delta. */
  delta: z.string(),
})

export const ToolStartedEvent = z.object({
  type: z.literal("tool.started"),
  sessionId: z.string(),
  callId: z.string(),
  name: z.string(),
  title: z.string().optional(),
})

export const ToolFinishedEvent = z.object({
  type: z.literal("tool.finished"),
  sessionId: z.string(),
  callId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})

export const PermissionAskedEvent = z.object({
  type: z.literal("permission.asked"),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  detail: z.string().optional(),
})

export const DownloadProgressEvent = z.object({
  type: z.literal("download.progress"),
  modelId: z.string(),
  file: z.string(),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  bytesPerSecond: z.number().nonnegative(),
})

export const DownloadFinishedEvent = z.object({
  type: z.literal("download.finished"),
  modelId: z.string(),
  ok: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional(),
})

export const RuntimeEvent = z.object({
  type: z.literal("runtime.changed"),
  status: z.enum(["starting", "running", "stopping", "stopped", "error"]),
  engine: z.string().optional(),
  model: z.string().optional(),
  port: z.number().int().optional(),
  detail: z.string().optional(),
})

export const MemoryUpdatedEvent = z.object({
  type: z.literal("memory.updated"),
  kind: z.string(),
  key: z.string(),
  action: z.enum(["created", "updated", "deleted"]),
})

export const RagIndexedEvent = z.object({
  type: z.literal("rag.indexed"),
  chunksAdded: z.number().int().nonnegative(),
  chunksUpdated: z.number().int().nonnegative(),
  chunksRemoved: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

export const Event = z.discriminatedUnion("type", [
  SessionCreatedEvent,
  SessionUpdatedEvent,
  MessageCreatedEvent,
  MessagePartEvent,
  ToolStartedEvent,
  ToolFinishedEvent,
  PermissionAskedEvent,
  DownloadProgressEvent,
  DownloadFinishedEvent,
  RuntimeEvent,
  MemoryUpdatedEvent,
  RagIndexedEvent,
])
export type Event = z.infer<typeof Event>
export type EventType = Event["type"]

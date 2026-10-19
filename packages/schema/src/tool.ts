/**
 * Tool schemas — what the agent can call, and the shape of results it gets.
 */
import { z } from "zod"

export const ToolName = z.enum([
  "read",
  "write",
  "edit",
  "shell",
  "glob",
  "grep",
  "code_search",
  "memory",
  "progress",
  "web_search",
  "web_fetch",
  "task",
  "question",
  "skill",
])
export type ToolName = z.infer<typeof ToolName>

/** JSON Schema for a tool's parameters (kept loose so tools own their own validation). */
export const ToolParameters = z.record(z.string(), z.unknown())
export type ToolParameters = z.infer<typeof ToolParameters>

/**
 * An image handed back to the model alongside the text: base64 bytes, never a
 * URL, because a local model has to be able to see it with no network at all.
 */
export const ToolImage = z.object({
  mime: z.string(),
  /** Base64-encoded image bytes. */
  data: z.string(),
})
export type ToolImage = z.infer<typeof ToolImage>

export const ToolResult = z.object({
  ok: z.boolean(),
  /** Text result fed back to the model. */
  output: z.string().default(""),
  /** Structured data for programmatic consumers. */
  data: z.unknown().optional(),
  /**
   * Images for a model that can see them. Only set when the active model is
   * known to be vision-capable; otherwise a text description is all that is sent.
   */
  images: z.array(ToolImage).optional(),
  /** Short title shown in the UI, e.g. "read auth.ts". */
  title: z.string().optional(),
  error: z.string().optional(),
})
export type ToolResult = z.infer<typeof ToolResult>

export const ToolCallRequest = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  sessionId: z.string(),
})
export type ToolCallRequest = z.infer<typeof ToolCallRequest>

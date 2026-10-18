/**
 * Permission schemas — rules that gate which tools may run and when.
 */
import { z } from "zod"

export const PermissionAction = z.enum(["allow", "ask", "deny"])
export type PermissionAction = z.infer<typeof PermissionAction>

export const PermissionRule = z.object({
  /** Tool name the rule applies to, or "*" for all tools. */
  tool: z.string(),
  /** Optional glob/regex-ish pattern: file path for fs tools, command prefix for shell. */
  pattern: z.string().optional(),
  action: PermissionAction,
  /** Where the rule came from. */
  source: z.enum(["config", "saved", "session"]).default("config"),
})
export type PermissionRule = z.infer<typeof PermissionRule>

export const PermissionDecision = z.object({
  action: PermissionAction,
  /** Rule that produced this decision, when any. */
  rule: PermissionRule.optional(),
  /** True when the user chose "always allow" and a saved rule was written. */
  remembered: z.boolean().default(false),
})
export type PermissionDecision = z.infer<typeof PermissionDecision>

/** Tools that default to allow without prompting (read-only). */
export const AUTO_ALLOW_TOOLS: readonly string[] = [
  "read",
  "glob",
  "grep",
  "code_search",
  "memory",
  "progress",
  "todo",
  "plan",
  "web_search",
  "web_fetch",
] as const

/** Tools that always require user confirmation regardless of config defaults. */
export const ALWAYS_ASK_TOOLS: readonly string[] = ["shell", "write", "edit", "screenshot"] as const

/** Tools that change something outside the conversation. */
export const MUTATING_TOOLS: readonly string[] = ["shell", "write", "edit", "screenshot"] as const

/**
 * How permission prompts are handled for the session.
 *   auto     — run every tool without asking (the default; the fastest way to work)
 *   manual   — ask before anything that changes the machine
 *   readonly — allow inspection only; refuse anything that mutates
 */
export const PermissionMode = z.enum(["manual", "auto", "readonly"])
export type PermissionMode = z.infer<typeof PermissionMode>

/**
 * The `permissions` section of the config: how calls are approved, plus any
 * rules. Approval defaults to `auto` so a fresh install is usable without a
 * stream of prompts; `/permission` (or `mode` here) switches it.
 */
export const PermissionsConfig = z.object({
  mode: PermissionMode.default("auto"),
  rules: z.array(PermissionRule).default([]),
})
export type PermissionsConfig = z.infer<typeof PermissionsConfig>

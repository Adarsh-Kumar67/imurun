/**
 * Tool types — the contract every IMURUN tool implements.
 */
import type { AgentDefinition, ToolResult } from "@imurun/schema"
import type { Logger } from "@imurun/util"
import type { ProgressLedger } from "../memory/ledger"

export interface ToolContext {
  /** Directory the agent operates in; relative paths resolve against it. */
  workingDir: string
  sessionId: string
  /** Agent running this call; a subagent defaults to the same one. */
  agentId?: string
  signal?: AbortSignal
  log: Logger
  /**
   * Key/value store of work in flight for this project. Tools that change the
   * project record what they did, so a later run can see where it got to.
   */
  ledger?: ProgressLedger
}

/** Streamed progress from a subagent, surfaced to the parent UI. */
export type SubagentEvent =
  | { type: "text"; delta: string }
  /** The subagent's displayable text so far is exactly this (a retraction). */
  | { type: "reset"; text: string }
  | { type: "tool"; name: string; title?: string }
  | { type: "step"; step: number }

export interface SubagentRequest {
  /** Full instructions for the subagent. */
  prompt: string
  /** Short (3-5 word) human-readable description of the task. */
  description?: string
  /** Subagent id to run; the runner picks a sensible default when absent. */
  agentId?: string
  workingDir: string
  /** Parent session id — the runner creates a child session linked to it. */
  sessionId: string
  signal?: AbortSignal
  onEvent?: (event: SubagentEvent) => void
}

export interface SubagentResult {
  text: string
  agentId: string
  sessionId: string
}

/**
 * Runs a subagent in its own context window. Implemented by the host (CLI/TUI)
 * which owns the providers, sessions, and agent registry.
 */
export interface SubagentRunner {
  /** Subagents that may be requested via the `task` tool. */
  listAgents(): AgentDefinition[]
  run(request: SubagentRequest): Promise<SubagentResult>
}

export interface ImurunTool {
  /** Unique name, as seen by the model. */
  name: string
  /** Model-facing description of what the tool does and when to use it. */
  description: string
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>
  /** Human-readable summary of a call for permission prompts and UI. */
  title?(args: Record<string, unknown>): string
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/** Helper for building consistent success results. */
export function ok(output: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, output, ...extra }
}

/** Helper for building consistent failure results. */
export function fail(error: string, output = "", extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, error, output: output || error, ...extra }
}

/** Coerces model-provided args into a plain object, rejecting bad payloads. */
export function asArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object")
  }
  return value as Record<string, unknown>
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === "boolean" ? value : undefined
}

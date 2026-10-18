/**
 * Permission manager — decides whether a tool call may proceed.
 *
 * Decision order:
 *   1. disabled tools (config.disabledTools)          → deny
 *   2. explicit config rules / saved rules (first match) → allow | ask | deny
 *   3. AUTO_ALLOW_TOOLS                                → allow
 *   4. ALWAYS_ASK_TOOLS and everything else            → ask
 *
 * "ask" outcomes are surfaced to the caller (TUI dialog in interactive mode,
 * auto-approve with --yes in non-interactive mode).
 */
import type { PermissionDecision, PermissionMode, PermissionRule } from "@imurun/schema"
import { AUTO_ALLOW_TOOLS, ALWAYS_ASK_TOOLS, MUTATING_TOOLS, PermissionAction } from "@imurun/schema"
import { newId } from "@imurun/util"
import type { ImurunDatabase } from "../storage/database"

export interface PermissionRequest {
  tool: string
  /** Human-readable detail: file path, command, query... */
  detail?: string
}

export interface PermissionRuleSet {
  rules: PermissionRule[]
  disabledTools: string[]
  /** Project path rules are scoped to; saved rules use it. */
  projectPath?: string
}

function matches(rule: PermissionRule, request: PermissionRequest): boolean {
  if (rule.tool !== "*" && rule.tool !== request.tool) return false
  if (!rule.pattern) return true
  const detail = request.detail ?? ""
  if (rule.pattern.endsWith("*")) {
    return detail.startsWith(rule.pattern.slice(0, -1))
  }
  return detail === rule.pattern
}

export class PermissionManager {
  private rules: PermissionRule[]
  private disabledTools: Set<string>
  private projectPath: string | undefined
  private mode: PermissionMode = "manual"

  constructor(
    private readonly store: ImurunDatabase | undefined,
    ruleSet: PermissionRuleSet,
  ) {
    this.rules = [...ruleSet.rules]
    this.disabledTools = new Set(ruleSet.disabledTools)
    this.projectPath = ruleSet.projectPath
  }

  /** The session's approval mode (see PermissionMode). */
  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /** Loads saved rules from the database and merges them with config rules. */
  static withSavedRules(
    store: ImurunDatabase,
    ruleSet: PermissionRuleSet,
  ): PermissionManager {
    const saved = loadSavedRules(store, ruleSet.projectPath)
    const manager = new PermissionManager(store, ruleSet)
    // saved rules take precedence over config rules
    manager.rules = [...saved, ...manager.rules]
    return manager
  }

  check(request: PermissionRequest): PermissionDecision {
    if (this.disabledTools.has(request.tool)) {
      return { action: "deny", remembered: false }
    }

    // The user's chosen mode wins over the rules, except for rejected tools.
    if (this.mode === "auto") {
      return { action: "allow", remembered: false }
    }
    if (this.mode === "readonly" && MUTATING_TOOLS.includes(request.tool)) {
      return { action: "deny", remembered: false }
    }

    for (const rule of this.rules) {
      if (matches(rule, request)) {
        return { action: rule.action, rule, remembered: false }
      }
    }

    if (this.mode === "readonly") {
      return { action: "allow", remembered: false }
    }

    if (AUTO_ALLOW_TOOLS.includes(request.tool)) {
      return { action: "allow", remembered: false }
    }

    if (ALWAYS_ASK_TOOLS.includes(request.tool)) {
      return { action: "ask", remembered: false }
    }

    return { action: "ask", remembered: false }
  }

  /** Persists an "always allow/deny" rule chosen by the user. */
  remember(request: PermissionRequest, action: PermissionAction): PermissionRule {
    const rule: PermissionRule = {
      tool: request.tool,
      pattern: request.detail,
      action,
      source: "saved",
    }
    this.rules.unshift(rule)

    if (this.store) {
      this.store.sqlite
        .query(
          "INSERT INTO permissions (id, tool, pattern, action, scope, project_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .run(
          newId("perm"),
          rule.tool,
          rule.pattern ?? null,
          rule.action,
          "project",
          this.projectPath ?? null,
          Date.now(),
        )
    }

    return rule
  }
}

/** Loads saved rules from the database (global + project scoped). */
export function loadSavedRules(store: ImurunDatabase, projectPath?: string): PermissionRule[] {
  const rows = store.sqlite
    .query<
      { tool: string; pattern: string | null; action: string; project_path: string | null },
      []
    >("SELECT tool, pattern, action, project_path FROM permissions ORDER BY created_at DESC")
    .all()

  return rows
    .filter((row) => {
      if (!row.project_path) return true
      if (!projectPath) return false
      return row.project_path.replace(/\\/g, "/").toLowerCase() === projectPath.replace(/\\/g, "/").toLowerCase()
    })
    .map((row) => ({
      tool: row.tool,
      pattern: row.pattern ?? undefined,
      action: row.action as PermissionRule["action"],
      source: "saved" as const,
    }))
}

export { PermissionAction }

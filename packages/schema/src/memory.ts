/**
 * Memory schemas — credentials, user style, facts, and session summaries that
 * IMURUN persists and recalls across sessions.
 */
import { z } from "zod"

export const MemoryKind = z.enum([
  "credential",
  "user_style",
  "fact",
  "session_summary",
  "preference",
])
export type MemoryKind = z.infer<typeof MemoryKind>

export const MemoryScope = z.enum(["global", "project"])
export type MemoryScope = z.infer<typeof MemoryScope>

export const MemoryEntry = z.object({
  id: z.string(),
  kind: MemoryKind,
  key: z.string(),
  /** Plaintext for non-secrets; base64 ciphertext payload for credentials. */
  value: z.string(),
  encrypted: z.boolean().default(false),
  scope: MemoryScope.default("global"),
  projectPath: z.string().optional(),
  /** 0-1 confidence; increases with reinforcement. */
  confidence: z.number().min(0).max(1).default(1),
  usageCount: z.number().int().nonnegative().default(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  expiresAt: z.number().optional(),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

export const IndentStyle = z.enum(["tabs", "spaces"])
export const QuoteStyle = z.enum(["single", "double", "mixed"])
export const NamingStyle = z.enum(["camelCase", "snake_case", "PascalCase", "kebab-case", "mixed"])
export const CommentLevel = z.enum(["none", "minimal", "detailed"])

export const UserStyle = z.object({
  indent: IndentStyle.optional(),
  indentWidth: z.number().int().positive().optional(),
  quotes: QuoteStyle.optional(),
  semicolons: z.boolean().optional(),
  naming: NamingStyle.optional(),
  commentLevel: CommentLevel.optional(),
  /** Language -> usage weight (0-1), highest first. */
  languages: z.array(z.object({ lang: z.string(), weight: z.number().min(0).max(1) })).default([]),
  /** Natural-language observations, e.g. "prefers functional components". */
  learnings: z.array(z.string()).default([]),
  /** How many samples informed this profile. */
  samples: z.number().int().nonnegative().default(0),
  updatedAt: z.number(),
})
export type UserStyle = z.infer<typeof UserStyle>

export const UserPreferences = z.record(z.string(), z.string())
export type UserPreferences = z.infer<typeof UserPreferences>

export const UserProfile = z.object({
  style: UserStyle,
  preferences: UserPreferences.default({}),
  /** Free-form personal notes the user asked to remember. */
  personalNotes: z.array(z.string()).default([]),
})
export type UserProfile = z.infer<typeof UserProfile>

/** Stored encrypted credential record (value encrypted at rest). */
export const CredentialRecord = z.object({
  id: z.string(),
  /** e.g. "github_token", "openai_api_key". */
  key: z.string(),
  /** Display hint, e.g. "ghp_…c3f". Never the full secret. */
  hint: z.string().optional(),
  scope: MemoryScope.default("global"),
  projectPath: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
})
export type CredentialRecord = z.infer<typeof CredentialRecord>

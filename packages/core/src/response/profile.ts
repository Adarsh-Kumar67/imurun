/**
 * The response engine's profile: how *this* person wants to be answered.
 *
 * It is not a prompt template. It is a small, explainable set of learned
 * preferences - how brief, how stepwise, whether code comes before prose,
 * how much checking they expect - that is turned into a short directive and
 * placed in the system prompt. It starts neutral and moves only when there is
 * evidence, so a single "shorter" does not define the relationship.
 *
 * Everything here is deterministic and testable. The model's part (reading a
 * conversation and proposing an update) lives in `refine.ts`; it can only
 * *propose*, and the merge here decides what is kept.
 */

export interface ResponseProfile {
  version: 1
  /** Completed turns observed. */
  turns: number
  /** 0..1 - 1 means "as short as it can be". */
  brevity: number
  /** 0..1 - wants the why, the trade-offs, the reasoning. */
  depth: number
  /** 0..1 - prefers numbered steps for multi-part work. */
  stepwise: number
  /** 0..1 - the command or the diff before the explanation. */
  codeFirst: number
  /** 0..1 - a neutral, professional register. */
  formality: number
  /** 0..1 - expects claims to be checked before they are made. */
  verification: number
  /** The user's own standing instructions, redacted and deduped. */
  instructions: string[]
  /** Why the profile looks the way it does; `/response` shows this. */
  evidence: {
    turns: number
    corrections: number
    explicit: number
    refinements: number
  }
  /** Rolling mean length of the user's own messages, in characters. */
  userChars: number
  updatedAt: number
  /** True when the last update came from the model, not the counters. */
  refined?: boolean
}

export const PROFILE_VERSION = 1

/** Neutral: no assumptions before the first turn. */
export function emptyProfile(now = Date.now()): ResponseProfile {
  return {
    version: PROFILE_VERSION,
    turns: 0,
    brevity: 0.45,
    depth: 0.5,
    stepwise: 0.5,
    codeFirst: 0.5,
    formality: 0.45,
    verification: 0.55,
    instructions: [],
    evidence: { turns: 0, corrections: 0, explicit: 0, refinements: 0 },
    userChars: 0,
    updatedAt: now,
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

/** EWMA: `current` moves a fraction of the way to `target`. */
export function approach(current: number, target: number, alpha: number): number {
  return clamp01(current + (clamp01(target) - clamp01(current)) * clamp01(alpha))
}

/**
 * Removes anything that looks like a credential before a string is stored.
 *
 * The profile keeps the *names* of keys a person mentions (they are useful:
 * "the NPM_TOKEN is set") and never their values. This is the last line of
 * defence, not the only one - nothing here should ever receive a value.
 */
export function redactSecrets(text: string): string {
  let out = text
  // `NAME=value` / `NAME: value`: keep the name, drop the value.
  out = out.replace(
    /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PAT|CREDENTIAL|AUTH))\s*[:=]\s*\S+/g,
    "$1=<redacted>",
  )
  // Well-known token shapes.
  out = out.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "<redacted>")
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<redacted>")
  out = out.replace(/\bnpm_[A-Za-z0-9]{16,}/g, "<redacted>")
  out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted>")
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "<redacted>")
  // A long opaque blob on its own is a credential until proven otherwise.
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "<redacted>")
  return out
}

function uniqueInstructions(existing: string[], incoming: string[]): string[] {
  const out: string[] = []
  for (const raw of [...existing, ...incoming]) {
    const text = redactSecrets(raw).replace(/\s+/g, " ").trim().slice(0, 160)
    if (!text) continue
    if (out.some((item) => item.toLowerCase() === text.toLowerCase())) continue
    out.push(text)
  }
  // Oldest fall away: a person's current wishes are the recent ones.
  return out.slice(-6)
}

/**
 * Merges a proposal into the profile.
 *
 * The model's proposal is blended rather than assigned (half the distance),
 * so a single strange reading cannot rewrite months of evidence. Explicit
 * instructions are additive and are kept verbatim (after redaction).
 */
export function mergeProfile(
  current: ResponseProfile,
  proposal: Partial<ResponseProfile>,
  options: { alpha?: number; fromModel?: boolean; now?: number } = {},
): ResponseProfile {
  const alpha = options.alpha ?? (options.fromModel ? 0.5 : 0.2)
  const now = options.now ?? Date.now()
  const next: ResponseProfile = {
    ...current,
    brevity: approach(current.brevity, proposal.brevity ?? current.brevity, alpha),
    depth: approach(current.depth, proposal.depth ?? current.depth, alpha),
    stepwise: approach(current.stepwise, proposal.stepwise ?? current.stepwise, alpha),
    codeFirst: approach(current.codeFirst, proposal.codeFirst ?? current.codeFirst, alpha),
    formality: approach(current.formality, proposal.formality ?? current.formality, alpha),
    verification: approach(current.verification, proposal.verification ?? current.verification, alpha),
    instructions: uniqueInstructions(current.instructions, proposal.instructions ?? []),
    evidence: {
      ...current.evidence,
      ...(proposal.evidence ?? {}),
      refinements: current.evidence.refinements + (options.fromModel ? 1 : 0),
    },
    turns: Math.max(current.turns, proposal.turns ?? current.turns),
    userChars: proposal.userChars ?? current.userChars,
    updatedAt: now,
    refined: options.fromModel ? true : current.refined,
  }
  return next
}

/**
 * The directive that goes into the system prompt.
 *
 * Short on purpose: this competes with the actual task for the model's
 * attention, and a page of style rules is worse than six clear lines. Lines
 * only appear when the evidence is strong enough to be worth saying.
 */
export function responseDirective(profile: ResponseProfile): string | undefined {
  const lines: string[] = []

  if (profile.brevity >= 0.62) {
    lines.push("Be brief. Lead with the answer; keep prose to one to three sentences unless the work itself needs more.")
  } else if (profile.brevity <= 0.3) {
    lines.push("Be thorough. Give the reasoning and the trade-offs, then the recommendation.")
  }

  if (profile.depth >= 0.62) {
    lines.push("Explain why, not only what: the cause, the alternative you rejected, and what would change the answer.")
  } else if (profile.depth <= 0.28) {
    lines.push("Do not explain what was not asked. The answer, and the next action, are enough.")
  }

  if (profile.stepwise >= 0.58) {
    lines.push("When there is more than one action, number the steps in the order they must be done.")
  }
  if (profile.codeFirst >= 0.58) {
    lines.push("Put the command, the diff, or the code first; the explanation follows it.")
  }
  if (profile.verification >= 0.66) {
    lines.push("Check what you claim before you say it - run it, read the file, or say plainly that you did not.")
  }
  if (profile.formality >= 0.62) {
    lines.push("Use a neutral, professional register. No slang, no filler.")
  }

  for (const instruction of profile.instructions.slice(-4)) {
    lines.push(`They asked for this explicitly, and it still stands: ${instruction}`)
  }

  if (lines.length === 0) return undefined
  return ["## How to answer this person", ...lines.map((line) => `- ${line}`)].join("\n")
}

/** The dimensions, for `/response` and for tests. */
export const PROFILE_DIMENSIONS = [
  "brevity",
  "depth",
  "stepwise",
  "codeFirst",
  "formality",
  "verification",
] as const

export type ProfileDimension = (typeof PROFILE_DIMENSIONS)[number]

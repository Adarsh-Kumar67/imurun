/**
 * Learning from a turn, without a model call.
 *
 * Every message carries evidence about how its writer wants to be answered:
 * a correction ("shorter", "just the command", "explain why") is a direct
 * signal, a standing instruction ("always run the tests") is a durable one,
 * and the length of what they write is a weak prior on how much they want
 * back.
 *
 * This is deliberately cheap and deterministic: it runs on every turn, in
 * milliseconds, and can never fail. The model's slower reading of the same
 * conversation lives in `refine.ts` and is merged on top.
 *
 * Corrections only count after an assistant has answered. "Explain the
 * borrow checker" is a question, not a complaint about length.
 */
import { approach, redactSecrets, type ResponseProfile } from "./profile"

/** A correction is short and direct; a long message is a new request. */
const CORRECTION_MAX_CHARS = 240

interface Signal {
  /** Move this dimension toward this value. */
  dimension: "brevity" | "depth" | "stepwise" | "codeFirst" | "formality" | "verification"
  toward: number
  /** How strongly; corrections are one weight, a standing instruction another. */
  weight: number
}

/**
 * Corrections are anchored at the start, so a passing mention in the middle
 * of a long request ("...and if the answer is too long, split it") is not
 * mistaken for a preference about this conversation.
 */
const CORRECTIONS: Array<{ pattern: RegExp; signal: Signal }> = [
  {
    pattern: /^\s*(?:please\s+)?(?:be\s+(?:more\s+)?(?:brief|concise|shorter|terse)|shorter|too long|less detail|trim (?:it|that)|cut it down|just the answer|get to the point|no fluff|keep it short)\b/i,
    signal: { dimension: "brevity", toward: 0.85, weight: 0.3 },
  },
  {
    pattern: /^\s*(?:please\s+)?(?:more detail|more context|explain (?:that|this|it|why|more)|elaborate|go deeper|in depth|walk me through|too short|not enough detail|why\?)\b/i,
    signal: { dimension: "depth", toward: 0.8, weight: 0.3 },
  },
  {
    pattern: /\b(?:step[- ]by[- ]step|numbered steps|as a (?:numbered )?list|checklist|in order)\b/i,
    signal: { dimension: "stepwise", toward: 0.85, weight: 0.25 },
  },
  {
    pattern: /^\s*(?:just (?:the )?(?:code|command|diff)|code only|no explanation|show me the (?:code|command|diff))\b/i,
    signal: { dimension: "codeFirst", toward: 0.85, weight: 0.3 },
  },
  {
    pattern: /\b(?:check (?:it|that|this) (?:first|before)|verify (?:it|that)|test (?:it|that) before|make sure it works|double[- ]check|before you answer)\b/i,
    signal: { dimension: "verification", toward: 0.85, weight: 0.25 },
  },
  {
    pattern: /^\s*(?:be (?:more )?professional|more formal|no slang|business tone)\b/i,
    signal: { dimension: "formality", toward: 0.85, weight: 0.25 },
  },
]

/** The opposite direction, so "shorter" also means "less depth". */
const OPPOSITES: Record<Signal["dimension"], Signal["dimension"]> = {
  brevity: "depth",
  depth: "brevity",
  stepwise: "stepwise",
  codeFirst: "codeFirst",
  formality: "formality",
  verification: "verification",
}

/**
 * Standing instructions. These are quoted back in the system prompt, so they
 * are captured close to verbatim - and redacted before they are stored.
 */
const STANDING = /(?:^|[\n.;]\s*)((?:always|never|from now on|prefer|please always|please never|don't|do not|keep (?:it|answers?|responses?|replies?))\s[^.\n]{3,150})/gi

export interface TurnObservation {
  /** The user's message. */
  userText: string
  /** True when this message followed an assistant answer. */
  afterAssistant?: boolean
}

export interface LearnedTurn {
  profile: ResponseProfile
  /** A correction was recognised (the model should refine sooner). */
  corrected: boolean
  /** New standing instructions captured this turn. */
  instructions: string[]
}

/** Applies one turn's evidence. Pure: the input is not mutated. */
export function observeTurn(profile: ResponseProfile, turn: TurnObservation): LearnedTurn {
  const text = turn.userText.trim()
  if (!text) return { profile, corrected: false, instructions: [] }

  // Bound the scan: a pasted file is not a style signal, and a huge input
  // should not turn a cheap step into a slow one.
  const scan = text.slice(0, 4_000)
  const short = scan.length <= CORRECTION_MAX_CHARS
  let next: ResponseProfile = { ...profile, evidence: { ...profile.evidence } }
  let corrected = false

  if (turn.afterAssistant && short) {
    for (const { pattern, signal } of CORRECTIONS) {
      if (!pattern.test(scan)) continue
      corrected = true
      const opposite = OPPOSITES[signal.dimension]
      next = {
        ...next,
        [signal.dimension]: approach(
          next[signal.dimension] as number,
          signal.toward,
          signal.weight,
        ),
      }
      // "shorter" also means "less depth"; "step by step" has no opposite, and
      // applying one to the same dimension would cancel the signal it just saw.
      if (opposite !== signal.dimension) {
        next = {
          ...next,
          [opposite]: approach(next[opposite] as number, 1 - signal.toward, signal.weight * 0.6),
        }
      }
    }
  }

  const captured: string[] = []
  for (const match of scan.matchAll(STANDING)) {
    const clause = redactSecrets(match[1] ?? "").trim()
    if (!clause) continue
    if (captured.some((item) => item.toLowerCase() === clause.toLowerCase())) continue
    captured.push(clause)
    if (captured.length >= 3) break
  }

  // Length is a weak prior, not a verdict: it drifts, it never jumps.
  const mean =
    next.userChars === 0 ? scan.length : next.userChars + (scan.length - next.userChars) * 0.2
  const lengthTarget = mean < 70 ? 0.68 : mean > 360 ? 0.3 : 0.45
  const mergedInstructions = [...next.instructions]
  for (const item of captured) {
    if (!mergedInstructions.some((existing) => existing.toLowerCase() === item.toLowerCase())) {
      mergedInstructions.push(item)
    }
  }
  next = {
    ...next,
    brevity: approach(next.brevity, lengthTarget, 0.06),
    userChars: Math.round(mean),
    turns: next.turns + 1,
    evidence: {
      ...next.evidence,
      turns: next.evidence.turns + 1,
      corrections: next.evidence.corrections + (corrected ? 1 : 0),
      explicit: next.evidence.explicit + captured.length,
    },
    instructions: mergedInstructions.slice(-6),
    updatedAt: Date.now(),
  }

  return { profile: next, corrected, instructions: captured }
}

/**
 * True when a profile is worth sending to the deep refiner: either the
 * counters disagree with each other, or enough turns have gone by that a
 * reading of the actual conversation would add something.
 */
export function shouldRefine(profile: ResponseProfile, sinceLastRefinement: number): boolean {
  if (profile.evidence.turns < 4) return false
  if (sinceLastRefinement >= 6) return true
  return profile.evidence.corrections >= 2 && sinceLastRefinement >= 2
}

/**
 * The slow half of the response engine: a model reads the conversation and
 * proposes a profile update.
 *
 * It runs in the background, on its own messages, and emits nothing - no
 * stream, no transcript entry, no notice. The user should never see it, and
 * it must never be able to break a turn. Every failure path returns
 * `undefined`; the deterministic counters in `learn.ts` remain the profile.
 *
 * The model is an adviser, not an authority: its proposal is blended into the
 * existing profile by `mergeProfile`, so one odd reading cannot rewrite a
 * person's preferences.
 */
import { generateText, type LanguageModel } from "ai"
import { logger } from "@imurun/util"
import { clamp01, mergeProfile, redactSecrets, responseDirective, type ResponseProfile } from "./profile"
import { observeTurn, shouldRefine } from "./learn"

const log = logger.child("response")

export interface RefineTurn {
  role: "user" | "assistant"
  text: string
}

export interface RefineOptions {
  model: LanguageModel
  profile: ResponseProfile
  /** The recent exchanges, oldest first. */
  turns: RefineTurn[]
  signal?: AbortSignal
}

const SYSTEM = [
  "You are a silent analyst inside a coding tool.",
  "You are not talking to the user, and nothing you write is shown to them.",
  "Read the exchanges and infer how this particular person wants to be answered.",
  "Return ONE JSON object and nothing else - no markdown fence, no commentary.",
].join(" ")

function buildPrompt(profile: ResponseProfile, turns: RefineTurn[]): string {
  const transcript = turns
    .map((turn) => `${turn.role === "user" ? "USER" : "ASSISTANT"}: ${redactSecrets(turn.text).slice(0, 900)}`)
    .join("\n\n")

  return [
    "Return this shape, with every dimension a number from 0 to 1:",
    '{"brevity":0.5,"depth":0.5,"stepwise":0.5,"codeFirst":0.5,"formality":0.5,"verification":0.5,"instructions":["..."],"why":"one line"}',
    "",
    "What each dimension means:",
    "- brevity: 1 = wants the shortest answer that works; 0 = wants the full treatment.",
    "- depth: 1 = wants the why, the trade-offs and the alternatives; 0 = wants only the action.",
    "- stepwise: 1 = wants numbered steps for multi-part work.",
    "- codeFirst: 1 = wants the command or the diff before any explanation.",
    "- formality: 1 = neutral and professional; 0 = relaxed and direct.",
    "- verification: 1 = expects claims to be checked (tests run, files read) before being made.",
    "",
    `The profile so far, from counting signals: ${JSON.stringify({
      brevity: round(profile.brevity),
      depth: round(profile.depth),
      stepwise: round(profile.stepwise),
      codeFirst: round(profile.codeFirst),
      formality: round(profile.formality),
      verification: round(profile.verification),
      turns: profile.turns,
    })}`,
    "",
    "Rules:",
    "- Infer only from what is in the transcript. Do not invent preferences.",
    "- Prefer the existing profile unless the transcript clearly disagrees.",
    "- `instructions` are standing wishes in the user's own words, at most 5, at most 120 characters each.",
    "- Never include secrets, keys, tokens, passwords or personal data in any field.",
    "- `why` is one short sentence, for the developer log only.",
    "",
    "Transcript:",
    transcript,
  ].join("\n")
}

function round(value: number): number {
  return Math.round(clamp01(value) * 100) / 100
}

/** Pulls the first JSON object out of a reply that may include prose. */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function numberField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key]
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : undefined
}

/**
 * Reads the conversation and merges the proposal. Never throws.
 */
export async function refineResponseProfile(options: RefineOptions): Promise<ResponseProfile | undefined> {
  if (options.turns.length < 2) return undefined

  try {
    const result = await generateText({
      model: options.model,
      system: SYSTEM,
      prompt: buildPrompt(options.profile, options.turns.slice(-12)),
      temperature: 0,
      // A profile is a small object; a long answer means it misunderstood.
      maxOutputTokens: 400,
      maxRetries: 0,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    })

    const raw = extractJsonObject(result.text ?? "")
    if (!raw) {
      log.debug("the refiner returned no JSON; keeping the counted profile")
      return undefined
    }

    const instructions = Array.isArray(raw.instructions)
      ? raw.instructions
          .filter((item): item is string => typeof item === "string")
          .map((item) => redactSecrets(item).replace(/\s+/g, " ").trim().slice(0, 120))
          .filter((item) => item.length > 0)
          .slice(0, 5)
      : []

    const proposal: Partial<ResponseProfile> = {
      brevity: numberField(raw, "brevity"),
      depth: numberField(raw, "depth"),
      stepwise: numberField(raw, "stepwise"),
      codeFirst: numberField(raw, "codeFirst"),
      formality: numberField(raw, "formality"),
      verification: numberField(raw, "verification"),
      instructions,
    }

    // If the reply contained nothing usable, do not bump the refinement counter.
    const usable = Object.entries(proposal).some(([key, value]) =>
      key === "instructions" ? Array.isArray(value) && value.length > 0 : value !== undefined,
    )
    if (!usable) return undefined

    const next = mergeProfile(options.profile, proposal, { fromModel: true })
    log.debug(`profile refined from ${options.turns.length} turns (${String(raw.why ?? "no reason given")})`)
    return next
  } catch (error) {
    // A background adviser that breaks a turn is worse than no adviser.
    log.debug(`refinement skipped: ${(error as Error).message}`)
    return undefined
  }
}

/**
 * The response engine as the TUI holds it: a profile, a debounced background
 * refinement, and no visible output.
 */
export class ResponseEngine {
  private profile: ResponseProfile
  private readonly model: LanguageModel
  private readonly onChange?: (profile: ResponseProfile) => void
  private sinceRefinement = 0
  private running = false
  private queued = false

  constructor(input: {
    profile: ResponseProfile
    model: LanguageModel
    onChange?: (profile: ResponseProfile) => void
  }) {
    this.profile = input.profile
    this.model = input.model
    this.onChange = input.onChange
  }

  get current(): ResponseProfile {
    return this.profile
  }

  /** The system-prompt section, when the profile has something to say. */
  get directive(): string | undefined {
    return responseDirective(this.profile)
  }

  /** Applies one turn immediately; the cheap, always-on half. */
  observe(turn: { userText: string; afterAssistant?: boolean }): void {
    const learned = observeTurn(this.profile, turn)
    this.profile = learned.profile
    this.sinceRefinement += 1
    this.onChange?.(this.profile)
  }

  /**
   * Asks the model to read the conversation, in the background.
   *
   * Single-flight: a second request while one is running is remembered and
   * run once afterwards, not queued up per turn.
   */
  refine(turns: RefineTurn[]): void {
    if (this.running) {
      this.queued = true
      return
    }
    this.running = true
    void (async () => {
      try {
        const next = await refineResponseProfile({ model: this.model, profile: this.profile, turns })
        if (next) {
          this.profile = next
          this.sinceRefinement = 0
          this.onChange?.(this.profile)
        }
      } finally {
        this.running = false
        if (this.queued) {
          this.queued = false
          this.refine(turns)
        }
      }
    })()
  }

  /** Whether the model should be asked now. */
  get due(): boolean {
    return shouldRefine(this.profile, this.sinceRefinement)
  }

  replace(profile: ResponseProfile): void {
    this.profile = profile
    this.sinceRefinement = 0
    this.onChange?.(this.profile)
  }
}

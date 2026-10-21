/**
 * Where the response profile lives.
 *
 * `~/.imurun/models/response.json` - the same directory as the other learned
 * engines, written atomically so a crash mid-write cannot leave a half
 * profile. A corrupt or older file is repaired into a neutral profile rather
 * than thrown away: losing a style preference is a small loss, but failing to
 * start is not.
 */
import { join } from "node:path"
import { ensureDir, imurunDir, logger, readJson, writeJsonAtomic } from "@imurun/util"
import { emptyProfile, PROFILE_VERSION, clamp01, redactSecrets, type ResponseProfile } from "./profile"

const log = logger.child("response")

export function responseProfilePath(): string {
  return join(imurunDir("models"), "response.json")
}

function coerce(raw: unknown): ResponseProfile {
  const base = emptyProfile()
  if (typeof raw !== "object" || raw === null) return base
  const value = raw as Record<string, unknown>
  const evidence = (typeof value.evidence === "object" && value.evidence !== null
    ? value.evidence
    : {}) as Record<string, unknown>

  const number = (key: keyof ResponseProfile, fallback: number): number => {
    const candidate = value[key as string]
    return typeof candidate === "number" && Number.isFinite(candidate) ? clamp01(candidate) : fallback
  }

  const instructions = Array.isArray(value.instructions)
    ? value.instructions
        .filter((item): item is string => typeof item === "string")
        .map((item) => redactSecrets(item).trim().slice(0, 160))
        .filter((item) => item.length > 0)
        .slice(-6)
    : []

  return {
    version: PROFILE_VERSION,
    turns: typeof value.turns === "number" && value.turns >= 0 ? Math.floor(value.turns) : 0,
    brevity: number("brevity", base.brevity),
    depth: number("depth", base.depth),
    stepwise: number("stepwise", base.stepwise),
    codeFirst: number("codeFirst", base.codeFirst),
    formality: number("formality", base.formality),
    verification: number("verification", base.verification),
    instructions,
    evidence: {
      turns: typeof evidence.turns === "number" ? evidence.turns : 0,
      corrections: typeof evidence.corrections === "number" ? evidence.corrections : 0,
      explicit: typeof evidence.explicit === "number" ? evidence.explicit : 0,
      refinements: typeof evidence.refinements === "number" ? evidence.refinements : 0,
    },
    userChars: typeof value.userChars === "number" && value.userChars >= 0 ? value.userChars : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    refined: value.refined === true,
  }
}

export async function loadResponseProfile(): Promise<ResponseProfile> {
  try {
    const raw = await readJson<unknown>(responseProfilePath())
    if (raw === undefined) return emptyProfile()
    return coerce(raw)
  } catch (error) {
    log.debug(`could not read the response profile: ${(error as Error).message}`)
    return emptyProfile()
  }
}

export async function saveResponseProfile(profile: ResponseProfile): Promise<void> {
  try {
    await ensureDir(imurunDir("models"))
    await writeJsonAtomic(responseProfilePath(), profile)
  } catch (error) {
    // A profile is an optimisation; failing to save it must never break a turn.
    log.debug(`could not save the response profile: ${(error as Error).message}`)
  }
}

/** Forgets everything learned. Used by `/response reset`. */
export async function resetResponseProfile(): Promise<ResponseProfile> {
  const fresh = emptyProfile()
  await saveResponseProfile(fresh)
  return fresh
}

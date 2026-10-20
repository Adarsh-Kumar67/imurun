/**
 * The skill router — an engine, not a word list.
 *
 * The first version scored every skill by counting how many of the request's
 * words appeared in the skill's name, tags, description and body. It worked,
 * but it never improved: the same request always got the same skill, even
 * after that skill had proved useless.
 *
 * This version keeps the scoring as a starting point and learns from what
 * happened. Each skill gets its own small classifier over the request's
 * features. When a turn finishes, the skill that was applied is labelled:
 *
 *   - the turn produced an answer and nothing failed  →  the skill helped
 *   - the turn ended in errors, or in nothing at all →  the skill did not
 *
 * A skill that keeps leading to failures is down-weighted, and one that keeps
 * helping is up-weighted. Nothing here is a hard-coded trigger: the initial
 * weights are the overlap score, and every outcome replaces them.
 *
 * State: one file, `~/.imurun/models/skills.json`, written atomically with a
 * version field. A corrupt or foreign file falls back to the overlap score.
 */
import { imurunDir } from "@imurun/util"
import { readJson, writeJsonAtomic } from "@imurun/util"
import { LinearModel, MODEL_VERSION, textFeatures, type FeatureVector, type ModelState } from "../engines/linear"
import { scoreSkill, type ScoredSkill, type SkillDefinition } from "./skills"

export interface SkillRouterState {
  version: number
  /** One classifier per skill id. */
  models: Record<string, ModelState>
  /** How many times each skill was applied, and how often it helped. */
  applied: Record<string, { used: number; helped: number }>
}

export const SKILL_ROUTER_VERSION = MODEL_VERSION

export function defaultSkillRouterPath(): string {
  return imurunDir("models", "skills.json")
}

/** The features of a request, shared by every skill's classifier. */
export function requestFeatures(query: string): FeatureVector {
  const features: Array<readonly [string, number]> = [["bias", 1]]
  for (const [name, value] of textFeatures(query, { prefix: "w:", bigrams: true, limit: 200 })) {
    features.push([name, value])
  }
  const length = query.length
  if (length > 400) features.push(["len:long", 1])
  if (query.includes("?")) features.push(["shape:question", 1])
  return features
}

/**
 * The features that describe *this skill* for a request: how well the request
 * matches the skill's own words, and the shape of the request.
 */
function skillFeatures(query: string, skill: SkillDefinition): FeatureVector {
  const features: Array<readonly [string, number]> = [["bias", 1]]
  const overlap = scoreSkill(query, skill)
  // The overlap score is the cold-start signal: it says "these are about the
  // same thing", and the learned weights then refine it.
  features.push(["overlap", overlap])
  if (overlap > 0) features.push(["shape:overlaps", 1])
  for (const [name, value] of requestFeatures(query)) {
    if (name === "bias") continue
    features.push([name, value])
  }
  return features
}

export interface SkillRouterOptions {
  path?: string
  state?: SkillRouterState
}

/**
 * Chooses the skills that apply, and remembers what happened to them.
 */
export class SkillRouter {
  private readonly models = new Map<string, LinearModel>()
  private readonly applied = new Map<string, { used: number; helped: number }>()
  private readonly path: string | undefined

  constructor(options: SkillRouterOptions = {}) {
    this.path = options.path
    const state = options.state
    if (state) {
      for (const [id, modelState] of Object.entries(state.models ?? {})) {
        const model = LinearModel.fromJson(modelState, { priors: {} })
        if (model) this.models.set(id, model)
      }
      for (const [id, counts] of Object.entries(state.applied ?? {})) {
        this.applied.set(id, { used: counts.used ?? 0, helped: counts.helped ?? 0 })
      }
    }
  }

  static async load(path = defaultSkillRouterPath()): Promise<SkillRouter> {
    const raw = await readJson<unknown>(path)
    if (!raw || typeof raw !== "object") return new SkillRouter({ path })
    const data = raw as Partial<SkillRouterState>
    if (data.version !== SKILL_ROUTER_VERSION) return new SkillRouter({ path })
    return new SkillRouter({
      path,
      state: {
        version: data.version,
        models: data.models ?? {},
        applied: data.applied ?? {},
      },
    })
  }

  private modelFor(id: string): LinearModel {
    let model = this.models.get(id)
    if (!model) {
      model = new LinearModel({ priors: { bias: -0.4 } })
      this.models.set(id, model)
    }
    return model
  }

  /**
   * The skills that apply to a request.
   *
   * The overlap score still decides the candidates — a skill nobody's words
   * appear in is not a candidate — and the learned model then re-ranks them,
   * so a skill that has repeatedly led to failure can be passed over even when
   * the words match.
   */
  select(query: string, skills: SkillDefinition[], limit = 1): ScoredSkill[] {
    const candidates = skills
      .map((skill) => ({ skill, overlap: scoreSkill(query, skill) }))
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, Math.max(limit * 4, 8))

    const scored: ScoredSkill[] = []
    for (const candidate of candidates) {
      const model = this.models.get(candidate.skill.id)
      const features = skillFeatures(query, candidate.skill)
      // Without a learned model the overlap decides; with one, the model has
      // the last word.
      const score = model ? model.probability(features) : candidate.overlap / 4
      scored.push({ skill: candidate.skill, score })
    }

    return scored
      .filter((entry) => entry.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * Records what happened to a skill that was applied.
   *
   * `helped` is the label: the turn produced an answer and nothing failed.
   */
  learn(skillId: string, query: string, skill: SkillDefinition, helped: boolean, strength = 0.6): void {
    const model = this.modelFor(skillId)
    model.learn(skillFeatures(query, skill), helped, strength)
    const counts = this.applied.get(skillId) ?? { used: 0, helped: 0 }
    counts.used++
    if (helped) counts.helped++
    this.applied.set(skillId, counts)
  }

  /** How a skill has done, for the diagnostics. */
  stats(skillId: string): { used: number; helped: number; rate: number } {
    const counts = this.applied.get(skillId) ?? { used: 0, helped: 0 }
    return { ...counts, rate: counts.used === 0 ? 0 : counts.helped / counts.used }
  }

  toJson(): SkillRouterState {
    const models: Record<string, ModelState> = {}
    for (const [id, model] of this.models) models[id] = model.toJson()
    const applied: Record<string, { used: number; helped: number }> = {}
    for (const [id, counts] of this.applied) applied[id] = counts
    return { version: SKILL_ROUTER_VERSION, models, applied }
  }

  async save(): Promise<void> {
    if (!this.path) return
    await writeJsonAtomic(this.path, this.toJson())
  }
}

/** One router per path, so a session does not re-read the file per turn. */
const routerCache = new Map<string, Promise<SkillRouter>>()

export function skillRouterFor(path = defaultSkillRouterPath()): Promise<SkillRouter> {
  let router = routerCache.get(path)
  if (!router) {
    router = SkillRouter.load(path)
    routerCache.set(path, router)
  }
  return router
}

/**
 * A small, persisted linear classifier — the one engine behind every
 * "should I do X?" decision IMURUN makes on its own.
 *
 * Routing research, deciding whether a sentence is a durable note, and
 * classifying what kind of note it is all have the same shape: a handful of
 * features, a weight per feature, a probability, and a label that can be
 * learned from. Keeping one implementation means one atomic-write path, one
 * corruption story, one feature cap, and one explanation format.
 *
 * Nothing here is a keyword gate. Strings appear only as *priors*: starting
 * weights, written down so a cold install behaves sensibly. A learned weight
 * for the same feature replaces the prior, and features nobody wrote a prior
 * for still count once they have been seen against a label.
 */
import { readJson, writeJsonAtomic } from "@imurun/util"

export type FeatureVector = ReadonlyArray<readonly [string, number]>

export interface LinearOptions {
  /** Starting weights for a cold install. Numbers, never gates. */
  priors: Readonly<Record<string, number>>
  /** Upper bound on the vocabulary; weakest weights are dropped first. */
  maxFeatures?: number
  learningRate?: number
  /** Weight decay per update, so stale evidence fades. */
  decay?: number
  maxWeight?: number
}

export interface ModelState {
  version: number
  trained: number
  weights: Record<string, number>
}

export const MODEL_VERSION = 1
export const DEFAULT_MAX_FEATURES = 20_000
export const DEFAULT_LEARNING_RATE = 0.15
export const DEFAULT_DECAY = 0.999
export const DEFAULT_MAX_WEIGHT = 4

/** Sigmoid that does not overflow for large negative scores. */
export function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exponent = Math.exp(value)
  return exponent / (1 + exponent)
}

/** Lowercased word pieces. Single letters are kept: "i" is a useful feature. */
export function featureWords(text: string): string[] {
  const out: string[] = []
  const pattern = /[a-z][a-z0-9'_-]*/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) out.push(match[0].toLowerCase())
  return out
}

/**
 * Word unigrams plus adjacent bigrams, prefixed so callers can combine several
 * feature families in one vector without collisions.
 */
export function textFeatures(
  text: string,
  options: { prefix?: string; bigrams?: boolean; limit?: number } = {},
): FeatureVector {
  const prefix = options.prefix ?? "w:"
  const limit = options.limit ?? 400
  const words = featureWords(text).slice(0, limit)
  const counts = new Map<string, number>()
  const bump = (key: string, amount = 1): void => {
    counts.set(key, (counts.get(key) ?? 0) + amount)
  }
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    bump(`${prefix}${word}`)
    if (options.bigrams !== false && index + 1 < words.length) {
      bump(`${prefix}${word} ${words[index + 1]!}`)
    }
  }
  return [...counts.entries()].map(([name, value]) => [name, value] as const)
}

/** Term-frequency cosine similarity over two token lists. */
export function cosineSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const a = new Map<string, number>()
  const b = new Map<string, number>()
  for (const token of left) a.set(token, (a.get(token) ?? 0) + 1)
  for (const token of right) b.set(token, (b.get(token) ?? 0) + 1)
  let dot = 0
  let normA = 0
  let normB = 0
  for (const value of a.values()) normA += value * value
  for (const value of b.values()) normB += value * value
  for (const [token, value] of a) {
    const other = b.get(token)
    if (other) dot += value * other
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export class LinearModel {
  private readonly weights = new Map<string, number>()
  private readonly options: Required<LinearOptions>
  trained = 0

  constructor(options: LinearOptions, state?: { weights?: Record<string, number>; trained?: number }) {
    this.options = {
      maxFeatures: options.maxFeatures ?? DEFAULT_MAX_FEATURES,
      learningRate: options.learningRate ?? DEFAULT_LEARNING_RATE,
      decay: options.decay ?? DEFAULT_DECAY,
      maxWeight: options.maxWeight ?? DEFAULT_MAX_WEIGHT,
      priors: options.priors,
    }
    for (const [name, value] of Object.entries(options.priors)) {
      if (isFiniteNumber(value)) this.weights.set(name, value)
    }
    if (state?.weights) {
      for (const [name, value] of Object.entries(state.weights)) {
        if (isFiniteNumber(value)) this.weights.set(name, value)
      }
    }
    this.trained = state?.trained && state.trained > 0 ? Math.floor(state.trained) : 0
  }

  /** Raw dot product, before the sigmoid. */
  score(features: FeatureVector): number {
    let total = 0
    for (const [name, value] of features) {
      const weight = this.weights.get(name)
      if (weight) total += weight * value
    }
    return total
  }

  probability(features: FeatureVector): number {
    return sigmoid(this.score(features))
  }

  /** The feature contributions that produced a score, largest first. */
  contributions(features: FeatureVector): Array<{ name: string; contribution: number }> {
    const out: Array<{ name: string; contribution: number }> = []
    for (const [name, value] of features) {
      const weight = this.weights.get(name)
      if (weight === undefined || weight === 0) continue
      out.push({ name, contribution: weight * value })
    }
    out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    return out
  }

  /**
   * One gradient step toward `label` (1 = positive). Returns the new
   * probability for the same features, which makes feedback loops easy to test.
   */
  learn(features: FeatureVector, label: number | boolean, strength = 1): number {
    if (strength <= 0) return this.probability(features)
    const target = label === true ? 1 : label === false ? 0 : Math.min(1, Math.max(0, label))
    const gradient = target - this.probability(features)
    const rate = this.options.learningRate * strength

    for (const [name, value] of features) {
      const current = (this.weights.get(name) ?? 0) * this.options.decay
      const updated = Math.max(
        -this.options.maxWeight,
        Math.min(this.options.maxWeight, current + rate * value * gradient),
      )
      if (Math.abs(updated) < 1e-4) this.weights.delete(name)
      else this.weights.set(name, updated)
    }
    this.trained++
    this.prune()
    return this.probability(features)
  }

  /** Keeps a bounded vocabulary without discarding the cold-start priors. */
  private prune(): void {
    if (this.weights.size <= this.options.maxFeatures) return
    const priorNames = new Set(Object.keys(this.options.priors))
    const entries = [...this.weights.entries()]
    const ordered = entries.sort((a, b) => {
      const byMagnitude = Math.abs(b[1]) - Math.abs(a[1])
      if (byMagnitude !== 0) return byMagnitude
      const aPrior = priorNames.has(a[0]) ? 0 : 1
      const bPrior = priorNames.has(b[0]) ? 0 : 1
      if (aPrior !== bPrior) return aPrior - bPrior
      return a[0].localeCompare(b[0])
    })
    this.weights.clear()
    for (const [name, value] of ordered.slice(0, this.options.maxFeatures)) this.weights.set(name, value)
  }

  weightOf(name: string): number | undefined {
    return this.weights.get(name)
  }

  vocabularySize(): number {
    return this.weights.size
  }

  toJson(): ModelState {
    const weights: Record<string, number> = {}
    for (const [name, value] of [...this.weights.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      weights[name] = value
    }
    return { version: MODEL_VERSION, trained: this.trained, weights }
  }

  /** Reads a state, or undefined for anything suspicious. */
  static fromJson(raw: unknown, options: LinearOptions): LinearModel | undefined {
    if (!raw || typeof raw !== "object") return undefined
    const data = raw as Partial<ModelState>
    if (data.version !== MODEL_VERSION) return undefined
    if (typeof data.trained !== "number" || !Number.isFinite(data.trained) || data.trained < 0) return undefined
    if (!data.weights || typeof data.weights !== "object" || Array.isArray(data.weights)) return undefined
    const weights: Record<string, number> = {}
    for (const [name, value] of Object.entries(data.weights)) {
      if (!name || !isFiniteNumber(value)) return undefined
      if (Math.abs(value) > (options.maxWeight ?? DEFAULT_MAX_WEIGHT) * 2) return undefined
      weights[name] = value
    }
    if (Object.keys(weights).length === 0) return undefined
    return new LinearModel(options, { weights, trained: data.trained })
  }

  /** A missing, corrupt or foreign-version file means the priors. */
  static async load(path: string, options: LinearOptions): Promise<LinearModel> {
    const raw = await readJson<unknown>(path)
    return LinearModel.fromJson(raw, options) ?? new LinearModel(options)
  }

  async save(path: string): Promise<void> {
    await writeJsonAtomic(path, this.toJson())
  }
}

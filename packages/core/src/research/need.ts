/**
 * "Does this request need the internet?"
 *
 * A coding agent should not search for "rename this function". It should search
 * for "what is the current Node.js LTS version", because the answer changed
 * after the model was trained — and a small local model will happily answer
 * from memory instead of looking.
 *
 * The decision is a learned classifier, not a list of trigger words. It looks
 * at the shape of the request (a question, a year, a number, a stack trace, a
 * file path) and at its words. Cold-start priors encode the obvious cases;
 * every outcome adjusts them, so a user whose work is mostly "which release
 * supports X" gets a router that searches sooner, and a user who asks for
 * codebase edits gets one that stays local.
 */
import { imurunDir } from "@imurun/util"
import {
  LinearModel,
  textFeatures,
  type FeatureVector,
  type LinearOptions,
  type ModelState,
} from "../engines/linear"

export interface ResearchContext {
  /** Chunks of the project were already injected. */
  projectHits?: number
  /** Characters of conversation the model is carrying. */
  historyChars?: number
}

export interface ResearchAssessment {
  needed: boolean
  probability: number
  reasons: string[]
}

const THRESHOLD = 0.5
const PRIORS: Record<string, number> = {
  bias: -1.5,
  "len:long": 0.15,
  "len:very-long": 0.3,
  "shape:question": 0.25,
  "shape:year": 0.8,
  "shape:url": 0.7,
  "shape:code": -0.6,
  "shape:stack": -0.9,
  "shape:file-path": -0.5,
  "shape:first-person": -0.3,
  "shape:list": 0.1,
  "num:some": 0.4,
  "num:many": 0.5,
  "ctx:project": -0.15,
  "ctx:long-history": 0.1,
  // Things that change after training.
  "w:latest": 1.4,
  "w:newest": 1.2,
  "w:current": 0.9,
  "w:currently": 0.8,
  "w:today": 1.0,
  "w:recent": 0.9,
  "w:now": 0.5,
  "w:still": 0.5,
  "w:yet": 0.6,
  "w:stable": 0.9,
  "w:version": 0.8,
  "w:release": 0.7,
  "w:released": 0.8,
  "w:changelog": 0.9,
  "w:docs": 0.5,
  "w:documentation": 0.6,
  "w:news": 1.3,
  "w:price": 1.1,
  "w:pricing": 1.0,
  "w:cost": 0.8,
  "w:weather": 1.4,
  "w:stock": 1.2,
  "w:benchmark": 0.8,
  "w:lts": 0.9,
  "w:eol": 0.9,
  "w:deprecated": 0.8,
  "w:compatible": 0.6,
  "w:supports": 0.4,
  "w:support": 0.3,
  // Questions about the world.
  "w:who": 0.7,
  "w:when": 0.6,
  "w:where": 0.5,
  "w:which": 0.4,
  "w:compare": 0.6,
  "w:versus": 0.7,
  "w:vs": 0.6,
  "w:best": 0.7,
  "w:api": 0.4,
  "w:according": 0.9,
  "w:source": 0.5,
  "w:sources": 0.6,
  "w:cite": 0.8,
  "w:verify": 0.5,
  "w:fact": 0.6,
  "w:factual": 0.7,
  "w:actually": 0.4,
  // Work on this codebase.
  "w:fix": -0.9,
  "w:rename": -0.9,
  "w:refactor": -0.7,
  "w:implement": -0.8,
  "w:add": -0.6,
  "w:remove": -0.7,
  "w:file": -0.5,
  "w:function": -0.4,
  "w:test": -0.4,
  "w:tests": -0.4,
  "w:bug": -0.6,
  "w:error": -0.4,
  "w:stack": -0.4,
  "w:trace": -0.5,
  "w:compile": -0.5,
  "w:build": -0.3,
  "w:repo": -0.5,
  "w:project": -0.4,
  "w:my": -0.3,
  "w:this": -0.2,
  "w:code": -0.4,
  "w:codebase": -0.7,
  "w:commit": -0.6,
  "w:branch": -0.5,
}

const OPTIONS: LinearOptions = { priors: PRIORS }

export function defaultResearchModelPath(): string {
  return imurunDir("models", "research-need.json")
}

function shapeFeatures(message: string): FeatureVector {
  const features: Array<readonly [string, number]> = [["bias", 1]]
  const length = message.length
  if (length > 400) features.push(["len:long", 1])
  if (length > 1_200) features.push(["len:very-long", 1])
  if (message.includes("?")) features.push(["shape:question", 1])
  if (/\b(?:19|20)\d{2}\b/.test(message)) features.push(["shape:year", 1])
  if (/https?:\/\/\S+/i.test(message)) features.push(["shape:url", 1])
  if (/```|=>|\bfunction\b\s*\(/.test(message)) features.push(["shape:code", 1])
  if (/\n\s+at\s+\S+\s+\(?[\w./-]+:\d+\)?/.test(message)) features.push(["shape:stack", 1])
  if (/\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|php|cs|cpp|c|h|json|yaml|yml|toml|md)\b/i.test(message)) {
    features.push(["shape:file-path", 1])
  }
  if (/\b(?:i|we|my|our|me)\b/i.test(message)) features.push(["shape:first-person", 1])
  if ((message.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? []).length >= 3) features.push(["shape:list", 1])
  const numbers = (message.match(/\b\d+(?:\.\d+)*\b/g) ?? []).length
  if (numbers >= 1) features.push(["num:some", 1])
  if (numbers >= 4) features.push(["num:many", 1])
  return features
}

function cleanFeatureName(name: string): string {
  if (name.startsWith("w:")) return `word "${name.slice(2)}"`
  if (name === "shape:year") return "a year in the request"
  if (name === "shape:question") return "a question"
  if (name === "shape:url") return "a link"
  if (name === "shape:code") return "code in the request"
  if (name === "shape:stack") return "a stack trace"
  if (name === "shape:file-path") return "a file path"
  if (name === "shape:first-person") return "first-person framing"
  if (name === "ctx:project") return "project context already found"
  return name.replace(":", " ")
}

export class ResearchNeedEngine {
  private model: LinearModel
  private readonly path: string | undefined

  constructor(options: { path?: string; state?: ModelState } = {}) {
    this.path = options.path
    this.model = options.state
      ? (LinearModel.fromJson(options.state, OPTIONS) ?? new LinearModel(OPTIONS))
      : new LinearModel(OPTIONS)
  }

  static async load(path = defaultResearchModelPath()): Promise<ResearchNeedEngine> {
    const model = await LinearModel.load(path, OPTIONS)
    return new ResearchNeedEngine({ path, state: model.toJson() })
  }

  features(message: string, context: ResearchContext = {}): FeatureVector {
    const features: Array<readonly [string, number]> = [
      ...shapeFeatures(message),
      ...textFeatures(message, { prefix: "w:", limit: 200 }),
    ]
    if ((context.projectHits ?? 0) > 0) features.push(["ctx:project", 1])
    if ((context.historyChars ?? 0) > 20_000) features.push(["ctx:long-history", 1])
    return features
  }

  assess(message: string, context: ResearchContext = {}): ResearchAssessment {
    const features = this.features(message, context)
    const probability = this.model.probability(features)
    const reasons = this.model
      .contributions(features)
      .filter((entry) => Math.abs(entry.contribution) >= 0.15)
      .slice(0, 3)
      .map(
        (entry) =>
          `${cleanFeatureName(entry.name)} ${entry.contribution > 0 ? "+" : "-"}${Math.abs(entry.contribution).toFixed(2)}`,
      )
    reasons.push(`need probability ${probability.toFixed(2)}`)
    return { needed: probability >= THRESHOLD, probability, reasons }
  }

  /** A label from what happened: the model searched, or the answer failed. */
  learn(message: string, needed: boolean, strength = 0.5, context: ResearchContext = {}): number {
    const probability = this.model.learn(this.features(message, context), needed, strength)
    return probability
  }

  async save(): Promise<void> {
    if (!this.path) return
    await this.model.save(this.path)
  }

  toJson(): ModelState {
    return this.model.toJson()
  }

  /** True when the state file is still the cold-start prior. */
  trained(): number {
    return this.model.trained
  }
}

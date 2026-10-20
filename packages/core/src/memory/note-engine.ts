/**
 * Taking notes as an engine, not a set of patterns.
 *
 * The old version matched five regular expressions. It caught the five
 * phrasings the author thought of and silently dropped everything else — and a
 * phrase that *looked* like a rule was kept whether or not it said anything.
 *
 * This version is a small classifier over the sentence itself: word features,
 * length, whether it is first-person, whether it reads like an explicit
 * request to remember, whether it carries something that looks like a secret.
 * A message is split into clauses, each clause is scored, and only the clauses
 * the model believes are durable become notes. The same model decides what
 * kind of note it is (a preference, a personal fact, or a credential).
 *
 * The priors exist so a fresh install behaves sensibly. From the first
 * explicit "remember that …", every label is fed back in, so the engine
 * adapts to how this user actually talks.
 *
 * Storage is the memory store's job. This module decides *what* to keep, how
 * to merge a near-duplicate, and what kind it is.
 */
import { imurunDir } from "@imurun/util"
import { readJson, writeJsonAtomic } from "@imurun/util"
import {
  LinearModel,
  MODEL_VERSION,
  cosineSimilarity,
  featureWords,
  textFeatures,
  type FeatureVector,
  type LinearOptions,
  type ModelState,
} from "../engines/linear"
import { tokenize } from "./search"
import type { MemoryKind, MemoryRecord } from "./store"
import type { MemoryStore } from "./store"

export interface LearnedNote {
  kind: MemoryKind
  text: string
}

export interface NoteCandidate extends LearnedNote {
  /** Probability that this clause is worth keeping. */
  confidence: number
  /** The user asked for it in so many words. A clear training label. */
  explicit: boolean
  /** The clause as written, including any "remember that" preamble. */
  raw: string
}

/** Longest message worth scanning; anything bigger is a pasted document. */
const MAX_SCAN_CHARS = 4_000
const MAX_CLAUSE_CHARS = 280
const DURABLE_THRESHOLD = 0.5
const KIND_THRESHOLD = 0.5
/** Two notes this close in meaning are the same note, written twice. */
const MERGE_SIMILARITY = 0.85
export const NOTE_MODEL_VERSION = MODEL_VERSION

export function defaultNoteModelPath(): string {
  return imurunDir("models", "note.json")
}

const DURABLE_OPTIONS: LinearOptions = {
  priors: {
    bias: -1.6,
    // Short clauses ("always use tabs") are common standing rules, not noise;
    // the penalty nudges but does not veto.
    "len:tiny": -0.2,
    "len:long": 0.1,
    "shape:first-person": 0.5,
    "shape:second-person": 0.1,
    "shape:explicit": 1.6,
    "shape:repo-scope": 0.5,
    "shape:secret-value": 1.5,
    "shape:quoted": 0.2,
    "shape:number": 0.1,
    // Explicit memory requests.
    "w:remember": 2.4,
    "w:remember that": 1.0,
    "w:note": 0.6,
    "w:note that": 0.6,
    "w:forget": 1.2,
    "w:dont forget": 1.0,
    "w:keep in mind": 1.2,
    "w:keep in": 0.8,
    // Standing instructions.
    "w:always": 1.4,
    "w:never": 1.4,
    "w:prefer": 1.2,
    "w:i prefer": 1.0,
    "w:instead": 0.5,
    "w:instead of": 0.8,
    "w:use": 0.5,
    "w:in this": 0.8,
    "w:repo": 0.3,
    "w:project": 0.3,
    "w:codebase": 0.4,
    "w:from now": 1.0,
    "w:every time": 1.0,
    "w:make sure": 0.7,
    "w:going forward": 1.1,
    // Personal facts.
    "w:i": 0.9,
    "w:my": 0.9,
    "w:we": 1.1,
    "w:our": 0.8,
    "w:name": 1.4,
    "w:my name": 1.0,
    "w:call": 1.0,
    "w:call me": 1.6,
    "w:work": 0.9,
    "w:i work": 1.2,
    "w:based": 0.9,
    "w:located": 0.9,
    "w:email": 1.2,
    "w:timezone": 1.2,
    "w:username": 1.1,
    // Secrets.
    "w:token": 0.8,
    "w:key": 0.6,
    "w:password": 1.3,
    "w:secret": 1.2,
    "w:passphrase": 1.2,
    // Ordinary work requests.
    "w:fix": -1.2,
    "w:fix the": -1.2,
    "w:rename": -1.2,
    "w:refactor": -1.0,
    "w:implement": -1.0,
    "w:run": -0.8,
    "w:run the": -1.2,
    "w:test": -0.8,
    "w:tests": -0.8,
    "w:add": -0.8,
    "w:add a": -1.0,
    "w:remove": -0.8,
    "w:update": -0.6,
    "w:write": -0.7,
    "w:create": -0.8,
    "w:file": -0.7,
    "w:function": -0.8,
    "w:error": -0.8,
    "w:bug": -0.8,
    "w:why": -0.6,
    "w:how": -0.5,
    "w:what": -0.5,
    "w:please": -0.3,
    "w:can": -0.3,
    "w:could": -0.3,
    "w:be careful": -2.0,
  },
}

const STYLE_OPTIONS: LinearOptions = {
  priors: {
    bias: -1.2,
    "w:always": 1.0,
    "w:never": 1.0,
    "w:prefer": 1.2,
    "w:i prefer": 0.8,
    "w:instead": 0.8,
    "w:instead of": 0.8,
    "w:use": 0.5,
    "w:style": 1.2,
    "w:formatting": 1.0,
    "w:tabs": 1.0,
    "w:spaces": 0.8,
    "w:convention": 1.0,
    "w:from now": 0.8,
    "w:every time": 0.8,
    "w:in this": 0.6,
    "w:name": -0.8,
    "w:email": -0.8,
    "w:password": -0.8,
  },
}

const FACT_OPTIONS: LinearOptions = {
  priors: {
    bias: -1.0,
    "w:my": 0.9,
    "w:name": 1.2,
    "w:my name": 1.0,
    "w:i": 0.5,
    "w:work": 0.9,
    "w:i work": 0.9,
    "w:based": 1.0,
    "w:located": 1.0,
    "w:email": 1.3,
    "w:timezone": 1.3,
    "w:username": 1.2,
    "w:am": 0.5,
    "w:call me": 1.2,
    "w:always": -0.8,
    "w:never": -0.8,
    "w:prefer": -0.8,
    "w:use": -0.4,
  },
}

const CREDENTIAL_OPTIONS: LinearOptions = {
  priors: {
    bias: -2,
    "w:token": 1.2,
    "w:key": 1.0,
    "w:password": 1.6,
    "w:secret": 1.4,
    "w:passphrase": 1.4,
    "w:is": 0.2,
    "shape:secret-value": 2.0,
  },
}

/** Splits a message into candidate clauses without rewriting them. */
export function noteClauses(message: string): string[] {
  if (!message || message.length > MAX_SCAN_CHARS) return []
  const withoutCode = message.replace(/```[\s\S]*?```/g, " ")
  const blocks = withoutCode.split(/\n+|(?<=[.!?;])\s+|,\s*and\s+|\s+and\s+(?=i\s|we\s|my\s|our\s)/i)
  const clauses: string[] = []
  for (const block of blocks) {
    const stripped = block
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
      .trim()
    if (stripped.length < 4) continue
    if (stripped.length > MAX_CLAUSE_CHARS) continue
    clauses.push(stripped)
  }
  return clauses
}

const EXPLICIT_CUE = /^(?:remember|note|keep in mind|don'?t forget|forget)\b[,\s]*(?:that\s+)?/i

function stripCue(clause: string): string {
  const stripped = clause.replace(EXPLICIT_CUE, "").replace(/^that\s+/i, "").trim()
  return stripped.length >= 4 ? stripped : clause
}

function looksLikeSecretValue(clause: string): boolean {
  const match = /\bis\s+(\S{6,200})\s*$/i.exec(clause) ?? /\b(?:token|key|password|secret|passphrase)\s*(?:=|:)\s*(\S{6,200})/i.exec(clause)
  if (!match?.[1]) return false
  const value = match[1].replace(/[.,;:]+$/, "")
  if (value.length < 6) return false
  const letters = (value.match(/[a-z]/gi) ?? []).length
  const digits = (value.match(/\d/g) ?? []).length
  const symbols = (value.match(/[^a-z0-9]/gi) ?? []).length
  // A random-looking value: mixed classes, or long and not a common word.
  return (letters > 0 && (digits > 0 || symbols > 0)) || value.length >= 24
}

function hasQuotedText(clause: string): boolean {
  return /"[^"]{2,}"|'[^']{2,}'|`[^`]{2,}`/.test(clause)
}

function noteFeatures(raw: string, clean: string, explicit: boolean): FeatureVector {
  const words = featureWords(clean)
  const features: Array<readonly [string, number]> = [
    ["bias", 1],
    ...textFeatures(raw, { prefix: "w:", bigrams: true, limit: 120 }),
  ]
  if (words.length <= 3) features.push(["len:tiny", 1])
  if (words.length > 40) features.push(["len:long", 1])
  if (/\b(?:i|we|my|our|me)\b/i.test(clean)) features.push(["shape:first-person", 1])
  if (/\byou(?:r)?\b/i.test(clean)) features.push(["shape:second-person", 1])
  if (explicit) features.push(["shape:explicit", 1])
  if (/\b(?:in this|this)\s+(?:repo|project|codebase)\b/i.test(clean)) features.push(["shape:repo-scope", 1])
  if (looksLikeSecretValue(raw)) features.push(["shape:secret-value", 1])
  if (hasQuotedText(clean)) features.push(["shape:quoted", 1])
  if (/\d/.test(clean)) features.push(["shape:number", 1])
  return features
}

export interface NoteEngineState {
  durable: ModelState
  kinds: Partial<Record<"user_style" | "fact" | "credential", ModelState>>
}

export class NoteEngine {
  private readonly durable: LinearModel
  private readonly kinds: Record<"user_style" | "fact" | "credential", LinearModel>
  private readonly path: string | undefined

  constructor(options: { path?: string; state?: NoteEngineState } = {}) {
    this.path = options.path
    this.durable = options.state
      ? (LinearModel.fromJson(options.state.durable, DURABLE_OPTIONS) ?? new LinearModel(DURABLE_OPTIONS))
      : new LinearModel(DURABLE_OPTIONS)
    this.kinds = {
      user_style: options.state?.kinds.user_style
        ? (LinearModel.fromJson(options.state.kinds.user_style, STYLE_OPTIONS) ?? new LinearModel(STYLE_OPTIONS))
        : new LinearModel(STYLE_OPTIONS),
      fact: options.state?.kinds.fact
        ? (LinearModel.fromJson(options.state.kinds.fact, FACT_OPTIONS) ?? new LinearModel(FACT_OPTIONS))
        : new LinearModel(FACT_OPTIONS),
      credential: options.state?.kinds.credential
        ? (LinearModel.fromJson(options.state.kinds.credential, CREDENTIAL_OPTIONS) ??
          new LinearModel(CREDENTIAL_OPTIONS))
        : new LinearModel(CREDENTIAL_OPTIONS),
    }
  }

  static async load(path = defaultNoteModelPath()): Promise<NoteEngine> {
    const raw = await readJson<unknown>(path)
    if (!raw || typeof raw !== "object") return new NoteEngine({ path })
    const data = raw as Partial<NoteEngineState> & { version?: number }
    if (data.version !== NOTE_MODEL_VERSION || !data.durable) return new NoteEngine({ path })
    const kinds = data.kinds && typeof data.kinds === "object" ? data.kinds : {}
    return new NoteEngine({ path, state: { durable: data.durable, kinds } })
  }

  /** Classifies one clause. */
  classify(clause: string): NoteCandidate | undefined {
    const explicit = EXPLICIT_CUE.test(clause)
    const clean = stripCue(clause).replace(/\s+/g, " ").trim()
    if (clean.length < 4) return undefined
    const features = noteFeatures(clause, clean, explicit)
    const confidence = this.durable.probability(features)
    if (confidence < DURABLE_THRESHOLD) return undefined

    const style = this.kinds.user_style.probability(features)
    const fact = this.kinds.fact.probability(features)
    const credential = this.kinds.credential.probability(features)
    let kind: MemoryKind = "note"
    if (credential >= KIND_THRESHOLD && credential >= style && credential >= fact) kind = "credential"
    else if (style >= KIND_THRESHOLD && style >= fact) kind = "user_style"
    else if (fact >= KIND_THRESHOLD) kind = "fact"
    else if (explicit) kind = "fact"

    return { kind, text: clean, confidence, explicit, raw: clause }
  }

  /** Every durable clause in a message, de-duplicated by meaning. */
  detect(message: string): NoteCandidate[] {
    const found: NoteCandidate[] = []
    for (const clause of noteClauses(message)) {
      const candidate = this.classify(clause)
      if (!candidate) continue
      const duplicate = found.find(
        (existing) =>
          existing.kind === candidate.kind &&
          cosineSimilarity(tokenize(existing.text), tokenize(candidate.text)) >= 0.9,
      )
      if (duplicate) {
        if (candidate.text.length > duplicate.text.length) duplicate.text = candidate.text
        continue
      }
      found.push(candidate)
    }
    return found
  }

  /** Train from a label: the user said it, or the user asked us to keep it. */
  learn(candidate: { raw: string; text: string; explicit: boolean; kind: MemoryKind }, strength = 0.5): void {
    const clean = candidate.text
    const features = noteFeatures(candidate.raw, clean, candidate.explicit)
    this.durable.learn(features, true, strength)
    if (candidate.kind === "credential" || candidate.kind === "fact" || candidate.kind === "user_style") {
      const target = candidate.kind
      for (const kind of ["user_style", "fact", "credential"] as const) {
        this.kinds[kind].learn(features, kind === target, strength * 0.6)
      }
    }
  }

  async save(): Promise<void> {
    if (!this.path) return
    const state: NoteEngineState & { version: number } = {
      version: NOTE_MODEL_VERSION,
      durable: this.durable.toJson(),
      kinds: {
        user_style: this.kinds.user_style.toJson(),
        fact: this.kinds.fact.toJson(),
        credential: this.kinds.credential.toJson(),
      },
    }
    await writeJsonAtomic(this.path, state)
  }

  toJson(): NoteEngineState & { version: number } {
    return {
      version: NOTE_MODEL_VERSION,
      durable: this.durable.toJson(),
      kinds: {
        user_style: this.kinds.user_style.toJson(),
        fact: this.kinds.fact.toJson(),
        credential: this.kinds.credential.toJson(),
      },
    }
  }
}

/** One cached engine per model path, so a session does not re-read it per turn. */
const engineCache = new Map<string, Promise<NoteEngine>>()

export function noteEngineFor(path = defaultNoteModelPath()): Promise<NoteEngine> {
  let engine = engineCache.get(path)
  if (!engine) {
    engine = NoteEngine.load(path)
    engineCache.set(path, engine)
  }
  return engine
}

/** For tests and for callers that only need a synchronous cold-start answer. */
let priorEngine: NoteEngine | undefined
export function detectDurableNotes(message: string): LearnedNote[] {
  priorEngine ??= new NoteEngine()
  return priorEngine.detect(message).map((note) => ({ kind: note.kind, text: note.text }))
}

/** Opposite of merging: finds the note a candidate is saying again. */
export function findNearDuplicate(
  candidate: { kind: MemoryKind; text: string },
  existing: readonly MemoryRecord[],
): MemoryRecord | undefined {
  const tokens = tokenize(candidate.text)
  let best: { record: MemoryRecord; score: number } | undefined
  for (const record of existing) {
    if (record.kind !== candidate.kind) continue
    const score = cosineSimilarity(tokens, tokenize(record.text))
    if (score < MERGE_SIMILARITY) continue
    if (!best || score > best.score) best = { record, score }
  }
  return best?.record
}

export interface RememberOutcome {
  saved: string[]
  merged: string[]
}

/**
 * Stores a message's durable clauses, merging near-duplicates and learning
 * from explicit requests. Returns human-readable lines for the UI notice.
 */
export async function rememberMessage(
  store: MemoryStore,
  message: string,
  options: { learnStyle: boolean; projectPath?: string; sessionId?: string; modelPath?: string },
): Promise<RememberOutcome> {
  const engine = await noteEngineFor(options.modelPath)
  const candidates = engine.detect(message)
  const saved: string[] = []
  const merged: string[] = []
  if (candidates.length === 0) return { saved, merged }
  const existing = await store.all()

  for (const candidate of candidates) {
    if (candidate.kind === "user_style" && !options.learnStyle) continue
    const tags =
      candidate.kind === "credential" ? ["secret"] : candidate.kind === "user_style" ? ["style"] : ["personal"]
    try {
      const duplicate = findNearDuplicate(candidate, existing)
      if (duplicate) {
        if (candidate.text.length > duplicate.text.length * 1.15) {
          await store.remember({
            text: candidate.text,
            kind: candidate.kind,
            tags,
            projectPath: options.projectPath,
            sessionId: options.sessionId,
          })
          await store.forget(duplicate.id)
          merged.push(candidate.text)
        } else {
          await store.remember({
            text: duplicate.text,
            kind: duplicate.kind,
            tags: [...new Set([...duplicate.tags, ...tags])],
            projectPath: duplicate.projectPath,
            sessionId: duplicate.sessionId,
          })
        }
      } else {
        await store.remember({
          text: candidate.text,
          kind: candidate.kind,
          tags,
          projectPath: options.projectPath,
          sessionId: options.sessionId,
        })
        saved.push(candidate.text)
      }
      if (candidate.explicit) engine.learn(candidate, 0.8)
    } catch {
      // A note is never worth failing a turn over.
    }
  }

  if (candidates.some((candidate) => candidate.explicit)) {
    try {
      await engine.save()
    } catch {
      // Same: persistence is best-effort.
    }
  }
  return { saved, merged }
}

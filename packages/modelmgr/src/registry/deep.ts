/**
 * Models that only the deep engine can run.
 *
 * The GGUF catalog is deliberately made of models that fit in memory, because
 * llama.cpp holds every weight it loads. The deep engine (AirLLM) streams a
 * layer at a time from disk, so these are the models that would otherwise be
 * impossible on a laptop: 32B, 70B, and anything else the card cannot hold.
 *
 * They are not in the main catalog for a reason: downloading one is tens of
 * gigabytes, and it answers in minutes rather than seconds. That is a choice
 * to make on purpose, which is why it has its own list.
 */

export interface DeepModel {
  id: string
  /** The original Hugging Face repo (or a local directory). */
  repo: string
  displayName: string
  paramsB: number
  description: string
  contextLength: number
  license: string
  /** Repos behind a licence wall need `huggingface-cli login` first. */
  gated?: boolean
}

export const DEEP_MODELS: readonly DeepModel[] = [
  {
    id: "qwen2.5-coder-32b-deep",
    repo: "Qwen/Qwen2.5-Coder-32B-Instruct",
    displayName: "Qwen2.5 Coder 32B (deep)",
    paramsB: 32,
    description:
      "Near-frontier coding, streamed layer by layer. Roughly 19 GB on disk, and minutes per answer.",
    contextLength: 32768,
    license: "apache-2.0",
  },
  {
    id: "qwen3-32b-deep",
    repo: "Qwen/Qwen3-32B",
    displayName: "Qwen3 32B (deep)",
    paramsB: 32,
    description: "Strong reasoning with thinking mode, on a machine that could never hold it.",
    contextLength: 40960,
    license: "apache-2.0",
  },
  {
    id: "qwen2.5-72b-deep",
    repo: "Qwen/Qwen2.5-72B-Instruct",
    displayName: "Qwen2.5 72B (deep)",
    paramsB: 72,
    description: "A 72B model on a laptop. Slow, and the biggest thing that still fits on a disk.",
    contextLength: 32768,
    license: "qwen",
  },
  {
    id: "codestral-22b-deep",
    repo: "mistralai/Codestral-22B-v0.1",
    displayName: "Codestral 22B (deep)",
    paramsB: 22,
    description: "Mistral's coding model, streamed. A good middle ground for a 16 GB machine.",
    contextLength: 32768,
    license: "mnpl",
  },
  {
    id: "deepseek-coder-v2-lite-deep",
    repo: "deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct",
    displayName: "DeepSeek Coder V2 Lite (deep)",
    paramsB: 16,
    description: "Mixture-of-experts coding model; only its active experts run per token.",
    contextLength: 163840,
    license: "deepseek",
  },
  {
    id: "llama-3.3-70b-deep",
    repo: "meta-llama/Llama-3.3-70B-Instruct",
    displayName: "Llama 3.3 70B (deep)",
    paramsB: 70,
    description: "Meta's 70B, streamed from disk. Needs access accepted on Hugging Face.",
    contextLength: 131072,
    license: "llama-3.3",
    gated: true,
  },
]

/** Finds a deep model by id or repo, case-insensitively. */
export function findDeepModel(query: string): DeepModel | undefined {
  const lower = query.trim().toLowerCase()
  return (
    DEEP_MODELS.find((m) => m.id.toLowerCase() === lower) ??
    DEEP_MODELS.find((m) => m.repo.toLowerCase() === lower) ??
    DEEP_MODELS.find((m) => m.repo.toLowerCase().endsWith(`/${lower}`)) ??
    DEEP_MODELS.find((m) => m.displayName.toLowerCase().includes(lower))
  )
}

/**
 * True when a reference looks like a Hugging Face repo rather than a local
 * name: `Owner/Name`, with no spaces and no drive letter.
 */
export function looksLikeRepo(ref: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(ref.trim())
}

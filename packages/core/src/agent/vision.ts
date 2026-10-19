/**
 * Can the model in use actually see images?
 *
 * This matters because it decides whether a screenshot or a PNG read is worth
 * anything: a vision model gets the pixels, a text-only model gets a sentence
 * saying what the picture is and where it lives. Handing pixels to a model that
 * cannot see them wastes thousands of tokens and produces confident nonsense.
 *
 * A local model from the catalogue declares `capabilities.vision`, but an
 * endpoint model does not: OpenAI-compatible APIs publish no capability list, so
 * the model id is all there is. The families below are the well-known ones, and
 * `vision` in config is the override for everything else — for a self-hosted
 * vision model IMURUN does not recognise (`vision: true`) or a text-only model
 * with a vision-sounding name (`vision: false`).
 */

/** Model-id fragments that mean "this model has eyes". */
export const VISION_MODEL_PATTERNS: readonly string[] = [
  // Open-weight vision families.
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "qvq",
  "llava",
  "bakllava",
  "minicpm-v",
  "moondream",
  "smolvlm",
  "internvl",
  "pixtral",
  "paligemma",
  "cogvlm",
  "idefics",
  "fuyu",
  "molmo",
  "granite-vision",
  "phi-3-vision",
  "phi-3.5-vision",
  "phi-4-multimodal",
  // Multimodal generalists.
  "gemma-3",
  "gemma3",
  "llama-3.2-11b-vision",
  "llama-3.2-90b-vision",
  "llama-4",
  "mistral-medium-3",
  // Hosted families that accept images.
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "o3",
  "o4",
  "claude-3",
  "claude-4",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gemini",
  "grok-2-vision",
  "grok-4",
]

export interface VisionOptions {
  /** `config.vision`: forces the answer when set. */
  force?: boolean
  /** `config.visionModels`: extra fragments that mean vision-capable. */
  extra?: readonly string[]
}

/**
 * True when `modelRef` names a model that can look at an image. A light-free
 * function on purpose: it is called once per run and never throws.
 */
export function modelSeesImages(modelRef: string | undefined, options: VisionOptions = {}): boolean {
  if (options.force !== undefined) return options.force
  const id = (modelRef ?? "").toLowerCase()
  if (!id) return false

  const patterns = [...VISION_MODEL_PATTERNS, ...(options.extra ?? [])]
  return patterns.some((pattern) => id.includes(pattern.toLowerCase()))
}

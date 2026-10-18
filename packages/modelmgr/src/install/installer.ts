/**
 * One-click model installer.
 *
 *   installModel("qwen2.5-coder-7b")
 *     → detects hardware (when no quant was chosen)
 *     → picks the best quantization that fits
 *     → verifies free disk space
 *     → ensures the llama.cpp engine binary exists
 *     → downloads + checksums the GGUF (resumable)
 *     → downloads the vision projector for VL models
 *     → registers the model as installed
 *
 * Every step reports a structured event so the CLI can draw live progress.
 */
import { join } from "node:path"
import type { HardwareProfile, InstalledModel, QuantType } from "@imurun/schema"
import { freeDiskBytes, formatBytes, logger } from "@imurun/util"
import { detectHardware } from "../hardware/detect"
import { downloadFile, type DownloadProgress } from "../huggingface/download"
import { headFile, resolveFileUrl } from "../huggingface/client"
import { getCatalogModel } from "../registry/catalog"
import { pickQuant } from "../registry/filter"
import { ensureLlamaCppEngine } from "./engine"
import { addInstalled, getInstalled, ggufDir, installedBytes } from "./store"

export type InstallPhase =
  | "resolve"
  | "disk-check"
  | "engine"
  | "download"
  | "mmproj"
  | "register"
  | "done"

/** Storage impact of an install, reported before anything is downloaded. */
export interface InstallStorageInfo {
  /** Directory the model will live in. */
  path: string
  /** Size of the file being downloaded. */
  sizeBytes: number
  /** sizeBytes × safety factor + headroom — the space actually required. */
  requiredBytes: number
  /** Free space on the target volume, when it can be determined. */
  freeBytes?: number
  /** Estimated free space once the download finishes. */
  freeAfterBytes?: number
  /** Total bytes currently used by installed models. */
  installedBytes: number
  /** Total bytes used by installed models after this install. */
  installedAfterBytes: number
}

export interface InstallEvent {
  phase: InstallPhase
  message?: string
  progress?: DownloadProgress
  /** Present on the disk-check event: the storage impact of this install. */
  storage?: InstallStorageInfo
  /** 0-1 overall completion estimate across all phases. */
  overall?: number
}

export interface InstallModelOptions {
  modelId: string
  quant?: QuantType
  hardware?: HardwareProfile
  /** Skip ensuring the llama.cpp binary (tests, ollama-only setups). */
  skipEngine?: boolean
  /** Which llama.cpp build to prefer: "auto" (default) or cuda/vulkan/cpu/rocm/metal. */
  engineVariant?: string
  onEvent?: (event: InstallEvent) => void
  signal?: AbortSignal
  /** Free-space safety multiple over the raw file size. Default 1.25 + 1 GB. */
  diskSafetyFactor?: number
}

const PHASE_WEIGHT: Record<InstallPhase, number> = {
  resolve: 0.02,
  "disk-check": 0.03,
  engine: 0.1,
  download: 0.72,
  mmproj: 0.08,
  register: 0.03,
  done: 0.02,
}

export interface ResolvedInstall {
  modelId: string
  displayName: string
  quant: QuantType
  repo: string
  file: string
  url: string
  sizeBytes?: number
  sha256?: string
  mmproj?: { repo: string; file: string }
  /** The model's trained context window, used for YaRN context extension. */
  contextLength?: number
}

/** Resolves catalog + hardware + HF metadata into a concrete download plan. */
export async function resolveInstall(
  options: InstallModelOptions,
): Promise<{ plan: ResolvedInstall; hardware: HardwareProfile }> {
  const model = getCatalogModel(options.modelId)
  if (!model) {
    throw new Error(
      `Unknown model "${options.modelId}". Browse the catalog with \`imurun models\`, ` +
        `or search Hugging Face with \`imurun models search <query>\`.`,
    )
  }

  const hardware = options.hardware ?? (await detectHardware())
  const quant = options.quant ?? pickQuant(model, hardware).recommendedQuant
  const variant = model.quantizations.find((q) => q.type === quant)
  if (!variant) {
    const available = model.quantizations.map((q) => q.type).join(", ")
    throw new Error(`${model.displayName} has no ${quant} build. Available: ${available}`)
  }

  const url = resolveFileUrl(variant.huggingface.repo, variant.huggingface.file)
  const info = await headFile(url)
  if (info.sizeBytes === undefined) {
    throw new Error(`Could not determine the size of ${variant.huggingface.file} on Hugging Face`)
  }

  return {
    hardware,
    plan: {
      modelId: model.id,
      displayName: model.displayName,
      quant,
      repo: variant.huggingface.repo,
      file: variant.huggingface.file,
      url,
      sizeBytes: info.sizeBytes,
      sha256: info.sha256,
      mmproj: variant.mmproj,
      contextLength: model.capabilities.contextLength,
    },
  }
}

/** Human-readable target path for a model+quant. */
export function modelFilePath(modelId: string, quant: QuantType): string {
  return join(ggufDir(), `${modelId}-${quant}.gguf`)
}

export async function installModel(options: InstallModelOptions): Promise<InstalledModel> {
  const { onEvent, signal } = options
  let overall = 0
  const emit = (event: InstallEvent, weight: InstallPhase | "partial" = "done", fraction = 1): void => {
    const w = weight === "partial" ? 0 : PHASE_WEIGHT[weight as InstallPhase]
    onEvent?.({ ...event, overall: Math.min(1, overall + w * fraction) })
  }

  // already installed?
  const existing = await getInstalled(options.modelId)
  if (existing && (!options.quant || existing.quant === options.quant)) {
    onEvent?.({ phase: "done", message: `${existing.modelId} ${existing.quant} is already installed`, overall: 1 })
    return existing
  }

  emit({ phase: "resolve", message: "resolving model and checking Hugging Face" }, "resolve")
  overall += PHASE_WEIGHT.resolve
  const { plan, hardware } = await resolveInstall(options)

  // storage — measure the impact before a single byte is downloaded
  const safety = options.diskSafetyFactor ?? 1.25
  const headroom = 1024 ** 3
  const requiredBytes = (plan.sizeBytes ?? 0) * safety + headroom
  const free = await freeDiskBytes(ggufDir()).catch(() => undefined)
  const usedBytes = await installedBytes().catch(() => 0)
  const storage: InstallStorageInfo = {
    path: ggufDir(),
    sizeBytes: plan.sizeBytes ?? 0,
    requiredBytes,
    freeBytes: free,
    freeAfterBytes: free !== undefined ? free - (plan.sizeBytes ?? 0) : undefined,
    installedBytes: usedBytes,
    installedAfterBytes: usedBytes + (plan.sizeBytes ?? 0),
  }
  emit(
    {
      phase: "disk-check",
      storage,
      message:
        `needs ${formatBytes(plan.sizeBytes ?? 0)} · ` +
        (free !== undefined
          ? `${formatBytes(free)} free → ~${formatBytes(Math.max(0, storage.freeAfterBytes ?? 0))} left after`
          : "free space unknown"),
    },
    "disk-check",
  )
  overall += PHASE_WEIGHT["disk-check"]
  if (free !== undefined && free < requiredBytes) {
    throw new Error(
      `Not enough disk space: ${plan.file} needs about ${formatBytes(requiredBytes)} ` +
        `(including headroom) but only ${formatBytes(free)} is free. ` +
        `Free space or install a smaller quantization.`,
    )
  }

  // engine binary
  if (!options.skipEngine) {
    emit({ phase: "engine", message: "checking the llama.cpp engine" }, "engine")
    const engine = await ensureLlamaCppEngine({
      hardware,
      signal,
      preferVariant: options.engineVariant,
      onStatus: (message) => emit({ phase: "engine", message }, "partial"),
      onProgress: (progress) => emit({ phase: "engine", progress, message: `downloading ${progress.file ?? "engine"}` }, "partial"),
    })
    overall += PHASE_WEIGHT.engine
    logger.debug(engine.installed ? `engine installed: ${engine.binaryPath}` : `engine present: ${engine.binaryPath}`)
  } else {
    overall += PHASE_WEIGHT.engine
  }

  // model download
  const destination = modelFilePath(plan.modelId, plan.quant)
  emit({ phase: "download", message: `downloading ${plan.file} (${formatBytes(plan.sizeBytes ?? 0)})` }, "partial")
  const result = await downloadFile({
    url: plan.url,
    destination,
    signal,
    sha256: plan.sha256,
    expectedSizeBytes: plan.sizeBytes,
    onProgress: (progress) => emit({ phase: "download", progress, message: plan.file }, "partial"),
  })
  overall += PHASE_WEIGHT.download

  // vision projector
  let mmprojPath: string | undefined
  if (plan.mmproj) {
    const mmprojDestination = join(ggufDir(), `${plan.modelId}-mmproj.gguf`)
    emit({ phase: "mmproj", message: "downloading the vision projector" }, "partial")
    const mmprojInfo = await headFile(resolveFileUrl(plan.mmproj.repo, plan.mmproj.file))
    await downloadFile({
      url: resolveFileUrl(plan.mmproj.repo, plan.mmproj.file),
      destination: mmprojDestination,
      signal,
      sha256: mmprojInfo.sha256,
      expectedSizeBytes: mmprojInfo.sizeBytes,
      onProgress: (progress) => emit({ phase: "mmproj", progress }, "partial"),
    })
    mmprojPath = mmprojDestination
    overall += PHASE_WEIGHT.mmproj
  } else {
    overall += PHASE_WEIGHT.mmproj
  }

  // register
  emit({ phase: "register", message: "registering the model" }, "register")
  overall += PHASE_WEIGHT.register
  const installed: InstalledModel = {
    id: `${plan.modelId}-${plan.quant}`,
    modelId: plan.modelId,
    quant: plan.quant,
    path: result.path,
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    mmprojPath,
    contextLength: plan.contextLength,
    hugginfaceRepo: plan.repo,
    installedAt: Date.now(),
  }
  await addInstalled(installed)

  onEvent?.({
    phase: "done",
    message: `${plan.displayName} (${plan.quant}) installed`,
    overall: 1,
  })
  return installed
}

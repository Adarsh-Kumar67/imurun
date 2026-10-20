/**
 * Setting a machine up, without asking questions.
 *
 * Installing IMURUN is only half of it: to *run* a model you also need the
 * inference engine and a model file. This module does that part, with no
 * questionnaire — it looks at the machine, picks what fits, installs the
 * engine and downloads the model.
 *
 * It is used from three places, which is why it lives here and not in a
 * command:
 *
 *   - `imurun setup`, for a person who wants it now;
 *   - the npm `postinstall` hook, so a fresh install leaves the machine
 *     ready rather than half-installed;
 *   - the Python launcher, which sets the machine up the first time it runs.
 *
 * Nothing here is destructive: an already-working machine is left alone, and
 * a failure is reported rather than thrown, so an install never breaks
 * because the network was down.
 */
import type { ImurunConfig, InstalledModel, QuantType } from "@imurun/schema"
import { loadHardware } from "./hardware/detect"
import { CATALOG } from "./registry/catalog"
import { fittingModels } from "./registry/filter"
import { installModel, type InstallEvent } from "./install/installer"
import { listInstalled } from "./install/store"

export interface AutoSetupOptions {
  config: ImurunConfig
  /** Install even when a model is already there. */
  force?: boolean
  /** The model to install; the best fit for the machine by default. */
  modelId?: string
  /** The quantization to install; the best fit by default. */
  quant?: QuantType
  /** Progress and status. */
  onEvent?: (event: InstallEvent) => void
  /** Reports what is being done, in plain language. */
  onStatus?: (message: string) => void
}

export interface AutoSetupResult {
  /** `ready` means the machine was already set up. */
  status: "ready" | "installed" | "failed" | "nothing-fits"
  /** The model that is installed, when there is one. */
  model?: InstalledModel
  /** Why nothing was installed. */
  reason?: string
}

/**
 * Makes the machine ready to run a model.
 *
 * Safe to call more than once: a machine that already has a model is left
 * exactly as it is unless `force` is set.
 */
export async function autoSetup(options: AutoSetupOptions): Promise<AutoSetupResult> {
  const installed = await listInstalled().catch(() => [] as InstalledModel[])

  if (installed.length > 0 && !options.force) {
    options.onStatus?.(`${installed.length} model(s) already installed — nothing to do`)
    return { status: "ready", model: installed[0] }
  }

  const hardware = await loadHardware()
  const fitting = fittingModels(hardware, CATALOG)
  if (fitting.length === 0) {
    const reason = "No catalog model fits this machine's available memory."
    options.onStatus?.(reason)
    return { status: "nothing-fits", reason }
  }

  const pick = options.modelId
    ? fitting.find((entry) => entry.model.id === options.modelId)
    : fitting[0]
  if (!pick) {
    const reason = `"${options.modelId}" is not among the models that fit this machine.`
    options.onStatus?.(reason)
    return { status: "nothing-fits", reason }
  }

  const { model, recommendedQuant } = pick
  const variant = model.quantizations.find((q) => q.type === recommendedQuant)
  const size = variant ? `, about ${variant.sizeGB.toFixed(1)} GB` : ""
  options.onStatus?.(`setting up ${model.displayName} (${model.id} ${recommendedQuant}${size})`)

  try {
    const result = await installModel({
      modelId: model.id,
      quant: options.quant ?? recommendedQuant,
      hardware,
      engineVariant: options.config.runtime.engineVariant,
      onEvent: options.onEvent,
    })
    options.onStatus?.(`${result.modelId} ${result.quant} is ready`)
    return { status: "installed", model: result }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    options.onStatus?.(`the setup did not finish: ${reason}`)
    return { status: "failed", reason }
  }
}

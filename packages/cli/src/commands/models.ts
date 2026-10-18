/**
 * imurun models — discover, install, and manage local models.
 *
 *   imurun models                       recommended models for this machine
 *   imurun models list [--all]          full catalog with fit marks
 *   imurun models recommend             ranked recommendations
 *   imurun models info <id>             details + per-quant fit
 *   imurun models install <id>          one-click download & install
 *   imurun models remove <id>           delete a model and free disk space
 *   imurun models search <query>        search Hugging Face for GGUFs
 *   imurun models engine                install/update the llama.cpp engine
 */
import chalk from "chalk"
import { loadConfigSafe } from "@imurun/core"
import { formatBytes, formatDuration } from "@imurun/util"
import {
  CATALOG,
  createInstallRenderer,
  dirSize,
  ensureLlamaCppEngine,
  evaluateQuantFits,
  findInstalledEngineBinary,
  fittingModels,
  getCatalogModel,
  installModel,
  listInstalled,
  llamaCppEngineDir,
  loadHardware,
  pickQuant,
  prunePartialDownloads,
  readActiveEngine,
  removeAllInstalled,
  removeInstalled,
  removeLlamaCppEngines,
  searchHfModels,
  summarizeHardware,
  type InstallEvent,
} from "@imurun/modelmgr"
import type { InstalledModel, QuantType } from "@imurun/schema"
import type { Command } from "../framework/command"

const TIER_COLORS: Record<string, (s: string) => string> = {
  minimal: chalk.gray,
  low: chalk.yellow,
  mid: chalk.cyan,
  high: chalk.green,
  extreme: chalk.magenta,
}

function fitBadge(fits: boolean): string {
  return fits ? chalk.green("✔ fits") : chalk.gray("✖ too big")
}

function specLine(model: (typeof CATALOG)[number]): string {
  const caps = model.capabilities
  const bits = [`${model.paramsB}B`, `ctx ${Math.round(caps.contextLength / 1024)}k`, `coding ${caps.coding}`]
  if (caps.vision) bits.push("vision")
  if (caps.toolCalling) bits.push("tools")
  return bits.join(" · ")
}

export const modelsCommand: Command = {
  name: "models",
  summary: "Discover, install, and manage local models",
  usage:
    "imurun models [list|recommend|info <id>|install <id>|remove [<id>|--all]|search <query>|engine|clean] [--quant Q4_K_M] [--all] [--yes] [--keep-files] [--engine] [--refresh]",
  options: [
    { name: "quant", type: "string", description: "Quantization to install (e.g. Q4_K_M, Q5_K_M)" },
    { name: "all", type: "boolean", description: "Show the whole catalog, or remove every installed model" },
    { name: "refresh", type: "boolean", description: "Re-detect hardware instead of using the cache" },
    { name: "yes", short: "y", type: "boolean", description: "Confirm destructive actions (remove --all, clean)" },
    { name: "keep-files", type: "boolean", description: "Unregister models but keep the GGUF files on disk" },
    { name: "engine", type: "boolean", description: "With clean: also remove the llama.cpp engine binaries" },
  ],

  async run({ args, options }) {
    const sub = args[0] ?? "recommend"
    const refresh = options.refresh === true
    const hardware = await loadHardware({ refresh })
    const { loaded } = await loadConfigSafe(process.cwd())
    const engineVariant = loaded.config.runtime.engineVariant

    switch (sub) {
      case "list":
      case "ls":
        return listModels(hardware, options.all === true)

      case "recommend":
      case "rec":
        return recommend(hardware)

      case "info": {
        const id = args[1]
        if (!id) {
          console.error("  Usage: imurun models info <id>")
          return 1
        }
        return modelInfo(id, hardware)
      }

      case "install": {
        const id = args[1]
        if (!id) {
          console.error("  Usage: imurun models install <id> [--quant Q4_K_M]")
          return 1
        }
        const quant = options.quant ? (String(options.quant).toUpperCase() as QuantType) : undefined
        return installOne(id, quant, refresh, engineVariant)
      }

      case "remove":
      case "rm":
        return removeOne(args[1], {
          all: options.all === true,
          keepFiles: options["keep-files"] === true,
          yes: options.yes === true,
        })

      case "search": {
        const query = args.slice(1).join(" ")
        if (!query) {
          console.error("  Usage: imurun models search <query>")
          return 1
        }
        return searchHf(query)
      }

      case "engine":
        return installEngine(hardware, engineVariant)

      case "clean":
        return clean({ yes: options.yes === true, engine: options.engine === true })

      default:
        console.error(`  ✖ Unknown subcommand: ${sub}`)
        console.error(
          "  Try: imurun models list | recommend | info <id> | install <id> | remove [<id>|--all] | search <q> | engine | clean",
        )
        return 1
    }
  },
}

// ── Subcommand implementations ──────────────────────────────────────────────

async function printHardwareHeader(hardware: Awaited<ReturnType<typeof loadHardware>>): Promise<void> {
  const tierColor = TIER_COLORS[hardware.tier] ?? chalk.white
  const installed = await listInstalled()
  const used = installed.reduce((sum, m) => sum + m.sizeBytes, 0)
  console.log("")
  console.log(`  ${chalk.gray("Detected:")} ${summarizeHardware(hardware)}`)
  console.log(
    `  ${chalk.gray("Tier:")}     ${tierColor(hardware.tier)} ${chalk.gray(`(score ${hardware.score}/100)`)}`,
  )
  console.log(
    `  ${chalk.gray("Storage:")}  ${chalk.white(formatBytes(used))} used by ${installed.length} model(s)  ` +
      `${chalk.gray(`· ${hardware.disk.freeGB} GB free`)}`,
  )
}

async function listModels(hardware: Awaited<ReturnType<typeof loadHardware>>, showAll: boolean): Promise<number> {
  await printHardwareHeader(hardware)
  const installed = await listInstalled()
  const installedIds = new Set(installed.map((m) => m.modelId))

  console.log("")
  if (installed.length > 0) {
    console.log(`  ${chalk.bold("Installed")}`)
    for (const entry of installed) {
      const model = getCatalogModel(entry.modelId)
      console.log(
        `    ${chalk.green("●")} ${chalk.white(entry.modelId.padEnd(28))} ${chalk.cyan(entry.quant.padEnd(8))}` +
          ` ${chalk.gray(formatBytes(entry.sizeBytes))}${model ? chalk.gray(`  ${model.displayName}`) : ""}`,
      )
    }
    console.log("")
  }

  const rows = showAll ? CATALOG.map((m) => ({ model: m, fit: pickQuant(m, hardware) })) : fittingModels(hardware, CATALOG).map((r) => ({ model: r.model, fit: r }))

  console.log(`  ${chalk.bold(showAll ? "Catalog" : "Recommended for this machine")}`)
  for (const { model, fit } of rows) {
    const marker = installedIds.has(model.id) ? chalk.green("●") : fit.fits ? chalk.white("○") : chalk.gray("○")
    const name = `${model.id.padEnd(28)}`
    const quant = chalk.cyan(fit.recommendedQuant.padEnd(8))
    console.log(`    ${marker} ${chalk.white(name)} ${quant} ${fitBadge(fit.fits)}  ${chalk.gray(specLine(model))}`)
  }

  console.log("")
  console.log(`  ${chalk.gray("install one with:")} ${chalk.cyan("imurun models install <id>")}`)
  if (!showAll) console.log(`  ${chalk.gray("see everything with:")} ${chalk.cyan("imurun models list --all")}`)
  console.log("")
  return 0
}

async function recommend(hardware: Awaited<ReturnType<typeof loadHardware>>): Promise<number> {
  await printHardwareHeader(hardware)
  const fitting = fittingModels(hardware, CATALOG)
  const total = fitting.length

  console.log("")
  console.log(`  ${chalk.bold("Best for this machine")}`)
  for (const rec of fitting.slice(0, 8)) {
    const model = rec.model
    console.log("")
    console.log(`  ${chalk.green("★")} ${chalk.bold(model.displayName)} ${chalk.gray(`(${model.id})`)}`)
    console.log(`    ${chalk.gray(specLine(model))}`)
    console.log(`    ${chalk.white(rec.reason)}`)
    console.log(`    ${chalk.gray("install:")} ${chalk.cyan(`imurun models install ${model.id}`)}`)
  }
  console.log("")
  console.log(`  ${chalk.gray(`${total} model(s) fit this machine — full list: imurun models list`)}`)
  console.log("")
  return 0
}

async function modelInfo(id: string, hardware: Awaited<ReturnType<typeof loadHardware>>): Promise<number> {
  const model = getCatalogModel(id)
  if (!model) {
    console.error(`  ✖ Unknown model "${id}". See the catalog with \`imurun models list --all\`.`)
    return 1
  }

  const fits = evaluateQuantFits(model, hardware)
  const installed = (await listInstalled()).find((m) => m.modelId === id)

  console.log("")
  console.log(`  ${chalk.bold(model.displayName)} ${chalk.gray(`(${model.id})`)}`)
  console.log(`  ${chalk.gray(model.description)}`)
  console.log("")
  console.log(`  family       ${model.family}`)
  console.log(`  parameters   ${model.paramsB}B`)
  console.log(`  context      ${model.capabilities.contextLength.toLocaleString()} tokens`)
  console.log(`  coding       ${model.capabilities.coding}/100    reasoning ${model.capabilities.reasoning}/100`)
  console.log(`  tools        ${model.capabilities.toolCalling ? chalk.green("yes") : chalk.gray("no")}`)
  console.log(`  vision       ${model.capabilities.vision ? chalk.green("yes") : chalk.gray("no")}`)
  console.log(`  license      ${model.license}`)
  if (installed) {
    console.log(`  ${chalk.green("● installed")} ${installed.quant} ${chalk.gray(formatBytes(installed.sizeBytes))}`)
  }

  console.log("")
  console.log(`  ${chalk.bold("Quantizations on this machine")}`)
  for (const fit of fits) {
    const badge = fit.fits ? chalk.green("✔") : chalk.gray("✖")
    console.log(
      `    ${badge} ${fit.quant.padEnd(8)} ${chalk.gray(`${(fit.sizeMB / 1024).toFixed(2)} GB`)}  ${chalk.white(`~${fit.estimatedTokensPerSec} t/s`)}  ${chalk.gray(fit.reason)}`,
    )
  }

  console.log("")
  console.log(`  ${chalk.gray("install:")} ${chalk.cyan(`imurun models install ${model.id}`)}`)
  console.log("")
  return 0
}

async function installOne(id: string, quant: QuantType | undefined, refresh: boolean, engineVariant?: string): Promise<number> {
  const model = getCatalogModel(id)
  if (!model) {
    console.error(`  ✖ Unknown model "${id}". Try \`imurun models search <query>\` for Hugging Face, or \`imurun models list --all\`.`)
    return 1
  }

  const hardware = await loadHardware({ refresh })
  const chosen = quant ?? pickQuant(model, hardware).recommendedQuant

  console.log("")
  console.log(`  ${chalk.bold(`Installing ${model.displayName}`)} ${chalk.cyan(chosen)}`)
  console.log(`  ${chalk.gray("from")} ${chalk.gray(model.quantizations.find((q) => q.type === chosen)?.huggingface.repo ?? "")}`)
  console.log("")

  const renderer = createInstallRenderer()
  const startedAt = Date.now()
  try {
    const installed = await installModel({
      modelId: id,
      quant,
      hardware,
      engineVariant,
      onEvent: (event: InstallEvent) => renderer.onEvent(event),
    })
    renderer.dispose()
    console.log("")
    console.log(
      `  ${chalk.green("✔")} ${chalk.bold(installed.modelId)} ${chalk.cyan(installed.quant)} ready ` +
        chalk.gray(`(${formatBytes(installed.sizeBytes)} in ${formatDuration(Date.now() - startedAt)})`),
    )
    console.log(`  ${chalk.gray("file:")} ${installed.path}`)
    console.log("")
    console.log(`  ${chalk.gray("chat with it:")} ${chalk.cyan(`imurun run "${promptFor(model.id)}"`)}`)
    console.log(`  ${chalk.gray("or start it:")}   ${chalk.cyan(`imurun runtime start --model ${installed.path}`)}`)
    console.log("")
    return 0
  } catch (error) {
    renderer.dispose()
    throw error
  }
}

function promptFor(modelId: string): string {
  switch (modelId) {
    case "qwen2.5-vl-7b":
      return "describe what you see on my screen"
    case "qwen2.5-coder-1.5b":
      return "write a hello world in Rust"
    default:
      return "explain what this project does"
  }
}

interface RemoveOptions {
  all: boolean
  keepFiles: boolean
  yes: boolean
}

/** Prints the installed models as a numbered list with sizes. */
async function printInstalled(): Promise<InstalledModel[]> {
  const installed = await listInstalled()
  if (installed.length === 0) {
    console.log(`  ${chalk.gray("no models installed")}`)
    return installed
  }
  for (const m of installed) {
    console.log(
      `    ${chalk.green("●")} ${chalk.white(m.modelId.padEnd(28))} ${chalk.cyan(m.quant.padEnd(8))} ` +
        `${chalk.gray(formatBytes(m.sizeBytes))}  ${chalk.gray(m.path)}`,
    )
  }
  return installed
}

async function removeOne(id: string | undefined, opts: RemoveOptions): Promise<number> {
  // remove everything
  if (opts.all) {
    const installed = await listInstalled()
    console.log("")
    if (installed.length === 0) {
      console.log(`  ${chalk.gray("no models installed")}`)
      console.log("")
      return 0
    }
    const total = installed.reduce((sum, m) => sum + m.sizeBytes, 0)
    if (!opts.yes) {
      console.log(`  ${chalk.yellow("This removes all")} ${installed.length} model(s)` + (opts.keepFiles ? "" : ` and frees ${chalk.bold(formatBytes(total))}`) + ":")
      await printInstalled()
      console.log("")
      console.log(`  ${chalk.gray("re-run with --yes to confirm:")} ${chalk.cyan("imurun models remove --all --yes")}`)
      console.log("")
      return 0
    }
    const result = await removeAllInstalled(!opts.keepFiles)
    console.log(
      `  ${chalk.green("✔")} removed ${result.count} model(s)` +
        (opts.keepFiles ? chalk.gray(" (kept the GGUF files)") : ` — freed ${chalk.bold(formatBytes(result.freedBytes))}`),
    )
    console.log("")
    return 0
  }

  // no id → show what can be removed
  if (!id) {
    console.log("")
    console.log(`  ${chalk.bold("Installed models")}`)
    const installed = await printInstalled()
    console.log("")
    if (installed.length > 0) {
      console.log(`  ${chalk.gray("remove one with:")}  ${chalk.cyan("imurun models remove <id>")}`)
      console.log(`  ${chalk.gray("remove all with:")} ${chalk.cyan("imurun models remove --all --yes")}`)
      console.log(`  ${chalk.gray("reclaim space:")}   ${chalk.cyan("imurun models clean")}`)
      console.log("")
    }
    return 0
  }

  const entry = await removeInstalled(id, !opts.keepFiles)
  if (!entry) {
    console.error(`  ✖ "${id}" is not installed`)
    const installed = await listInstalled()
    if (installed.length > 0) {
      console.error(`    installed: ${installed.map((m) => m.modelId).join(", ")}`)
    } else {
      console.error(`    nothing is installed yet — add one with \`imurun models install <id>\``)
    }
    return 1
  }
  console.log("")
  console.log(
    `  ${chalk.green("✔")} removed ${chalk.bold(entry.modelId)} ${entry.quant}` +
      (opts.keepFiles ? chalk.gray(" (kept the GGUF file)") : ` — freed ${chalk.bold(formatBytes(entry.sizeBytes))}`),
  )
  console.log("")
  return 0
}

/** `imurun models clean` — reclaim storage with an explicit confirmation. */
async function clean(opts: { yes: boolean; engine: boolean }): Promise<number> {
  const installed = await listInstalled()
  const modelsBytes = installed.reduce((sum, m) => sum + m.sizeBytes, 0)
  const engineBytes = opts.engine ? await dirSize(llamaCppEngineDir()).catch(() => 0) : 0
  const reclaimable = modelsBytes + engineBytes

  console.log("")
  if (modelsBytes === 0 && engineBytes === 0) {
    console.log(
      `  ${chalk.gray(
        "nothing to clean" + (opts.engine ? " — no models or engine binaries installed" : " — no models installed"),
      )}`,
    )
    console.log("")
    return 0
  }

  console.log(`  ${chalk.bold("Reclaimable storage")}`)
  if (installed.length > 0) {
    console.log(`    ${chalk.white(formatBytes(modelsBytes).padEnd(11))} ${chalk.gray(`${installed.length} model(s)`)}`)
  }
  if (opts.engine && engineBytes > 0) {
    console.log(`    ${chalk.white(formatBytes(engineBytes).padEnd(11))} ${chalk.gray("llama.cpp engine binaries")}`)
  }
  console.log(`    ${chalk.gray("─────────────")}`)
  console.log(`    ${chalk.bold(formatBytes(reclaimable))} ${chalk.gray("total")}`)
  console.log("")

  if (!opts.yes) {
    console.log(`  ${chalk.gray("this deletes the files above. re-run with --yes to confirm:")}`)
    console.log(`    ${chalk.cyan(`imurun models clean --yes${opts.engine ? " --engine" : ""}`)}`)
    console.log("")
    return 0
  }

  const removed = await removeAllInstalled(true)
  const partials = await prunePartialDownloads()
  let engineFreed = 0
  if (opts.engine) {
    const result = await removeLlamaCppEngines()
    engineFreed = result.freedBytes
  }
  const parts = [`${removed.count} model(s)`]
  if (partials.count > 0) parts.push(`${partials.count} partial download(s)`)
  if (opts.engine) parts.push("engine binaries")
  console.log(`  ${chalk.green("✔")} removed ${parts.join(", ")}`)
  console.log(`  ${chalk.gray("freed")} ${chalk.bold(formatBytes(removed.freedBytes + partials.freedBytes + engineFreed))}`)
  console.log("")
  return 0
}

async function searchHf(query: string): Promise<number> {
  console.log("")
  console.log(`  ${chalk.gray("searching Hugging Face for GGUF repositories:")} ${chalk.bold(query)}`)
  const results = await searchHfModels(query)
  console.log("")
  if (results.length === 0) {
    console.log(`  ${chalk.gray("no results")}`)
    console.log("")
    return 0
  }
  for (const entry of results) {
    const downloads = entry.downloads !== undefined ? `${(entry.downloads / 1000).toFixed(0)}k` : "?"
    const badge = entry.gated ? chalk.yellow(" gated") : ""
    console.log(`    ${chalk.white(entry.id.padEnd(56))} ${chalk.gray(`↓ ${downloads}`)}${badge}`)
  }
  console.log("")
  console.log(`  ${chalk.gray("these are raw repositories — model the ones in the catalog install automatically with `imurun models install <id>`")}`)
  console.log("")
  return 0
}

async function installEngine(hardware: Awaited<ReturnType<typeof loadHardware>>, engineVariant?: string): Promise<number> {
  const existing = findInstalledEngineBinary()
  const active = await readActiveEngine()
  console.log("")
  if (existing) {
    const variant = active?.variant ? ` ${chalk.cyan(active.variant)}` : ""
    console.log(`  ${chalk.green("✔")} llama.cpp engine present${variant}: ${chalk.gray(existing)}`)
  }
  console.log(`  ${chalk.gray("checking for updates from the official llama.cpp releases…")}`)
  const result = await ensureLlamaCppEngine({
    hardware,
    preferVariant: engineVariant,
    onStatus: (message) => console.log(`  ${chalk.gray("•")} ${message}`),
  })
  console.log("")
  const variant = result.variant ? ` ${chalk.cyan(result.variant)}` : ""
  console.log(`  ${chalk.green("✔")} llama.cpp ${result.version ?? ""}${variant} ${result.installed ? "installed" : "up to date"}`)
  console.log(`  ${chalk.gray("binary:")} ${result.binaryPath}`)
  console.log("")
  return 0
}

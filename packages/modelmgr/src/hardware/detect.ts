/**
 * Hardware detection — probes the machine once and produces the profile that
 * drives model recommendations: CPU, RAM, GPUs (NVIDIA/AMD/Intel/Apple), free
 * disk space, and an overall tier.
 *
 * Every probe is best-effort: a missing tool must never break detection.
 */
import { cpus, freemem, platform, totalmem, arch as osArch } from "node:os"
import { execSync } from "node:child_process"
import type { CpuInfo, GpuInfo, HardwareProfile, RamInfo } from "@imurun/schema"
import { computeTier, scoreHardware } from "@imurun/schema"
import { freeDiskBytes, imurunDir, modelsDir, readJson, writeJsonAtomic } from "@imurun/util"

const MB = 1024 * 1024

function run(command: string, timeoutMs = 4000): string | undefined {
  try {
    const output = execSync(command, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
    })
    return output.trim() || undefined
  } catch {
    return undefined
  }
}

export function detectCpu(): CpuInfo {
  const list = cpus()
  const first = list[0]
  const name = first?.model?.trim() || `${osArch()} CPU`
  return {
    name,
    cores: Math.max(1, Math.ceil(list.length / 2)),
    threads: Math.max(1, list.length),
    flags: [],
  }
}

export function detectRam(): RamInfo {
  return {
    totalMB: Math.round(totalmem() / MB),
    availableMB: Math.round(freemem() / MB),
  }
}

// ── GPU probes ──────────────────────────────────────────────────────────────

function parseVram(text: string | undefined): number {
  if (!text) return 0
  const cleaned = text.replace(/[^\d]/g, "")
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : 0
}

function detectNvidia(): GpuInfo[] {
  const output = run(
    "nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits",
    6000,
  )
  if (!output) return []
  const gpus: GpuInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim())
    if (parts.length < 2 || !parts[0]) continue
    gpus.push({
      vendor: "nvidia",
      name: parts[0],
      vramMB: parseVram(parts[1]),
      unified: false,
      computeCap: parts[2] || undefined,
      usable: true,
    })
  }
  return gpus
}

function detectWindowsDisplayAdapters(): GpuInfo[] {
  const output = run(
    'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -Property Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress"',
    8000,
  )
  if (!output) return []
  let entries: Array<{ Name?: string; AdapterRAM?: number }>
  try {
    const parsed = JSON.parse(output) as
      | Array<{ Name?: string; AdapterRAM?: number }>
      | { Name?: string; AdapterRAM?: number }
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }

  const gpus: GpuInfo[] = []
  for (const entry of entries) {
    const name = entry.Name?.trim()
    if (!name) continue
    // skip virtual/remote adapters
    if (/microsoft basic|remote|virtual|meta|parsec|citrix/i.test(name)) continue

    let vendor: GpuInfo["vendor"] = "unknown"
    if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) vendor = "nvidia"
    else if (/amd|radeon|rx\s?\d/i.test(name)) vendor = "amd"
    else if (/intel|arc|iris|uhd/i.test(name)) vendor = "intel"
    if (vendor === "unknown") continue

    // AdapterRAM is a signed 32-bit value in WMI and wraps above 4 GB; use it
    // only as a floor and let nvidia-smi/other tools refine real VRAM.
    let vramMB = Math.max(0, Math.round((entry.AdapterRAM ?? 0) / MB))
    if (entry.AdapterRAM !== undefined && entry.AdapterRAM < 0) vramMB = 4095

    gpus.push({
      vendor,
      name,
      vramMB,
      unified: vendor === "intel" || /integrated/i.test(name),
      usable: vendor === "nvidia" || vendor === "amd",
    })
  }
  return gpus
}

function detectMacGpus(ram: RamInfo): GpuInfo[] {
  if (osArch() === "arm64") {
    const cpu = detectCpu()
    return [
      {
        vendor: "apple",
        name: cpu.name.replace(/^Apple\s+/i, "Apple "),
        vramMB: 0, // unified memory — scored against total RAM
        unified: true,
        usable: true,
      },
    ]
  }
  // Intel Macs: system_profiler lists AMD Radeon dGPUs
  const output = run("system_profiler SPDisplaysDataType 2>/dev/null", 8000)
  if (!output) return []
  const gpus: GpuInfo[] = []
  const nameMatch = output.match(/Chipset Model:\s*(.+)/i)
  const vramMatch = output.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i)
  if (nameMatch?.[1]) {
    const name = nameMatch[1].trim()
    let vramMB = 0
    if (vramMatch) {
      const value = Number(vramMatch[1])
      vramMB = /gb/i.test(vramMatch[2] ?? "") ? value * 1024 : value
    }
    const vendor: GpuInfo["vendor"] = /amd|radeon/i.test(name) ? "amd" : /intel/i.test(name) ? "intel" : "unknown"
    if (vendor !== "unknown") gpus.push({ vendor, name, vramMB, unified: false, usable: vendor === "amd" })
  }
  return gpus
}

function detectLinuxGpus(): GpuInfo[] {
  const output = run("lspci 2>/dev/null | grep -Ei 'vga|3d|display'", 5000)
  if (!output) return []
  const gpus: GpuInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const name = line.replace(/^[^:]*:\s*/, "").trim()
    let vendor: GpuInfo["vendor"] = "unknown"
    if (/nvidia/i.test(name)) vendor = "nvidia"
    else if (/amd|ati|radeon/i.test(name)) vendor = "amd"
    else if (/intel/i.test(name)) vendor = "intel"
    if (vendor === "unknown") continue
    gpus.push({
      vendor,
      name,
      vramMB: 0,
      unified: vendor === "intel" || /integrated/i.test(name),
      usable: vendor === "nvidia" || vendor === "amd",
    })
  }
  return gpus
}

export function detectGpus(ram: RamInfo = detectRam()): GpuInfo[] {
  const os = platform()
  if (os === "darwin") return detectMacGpus(ram)

  const nvidia = detectNvidia()
  if (os === "win32") {
    const others = detectWindowsDisplayAdapters().filter((g) => g.vendor !== "nvidia" || nvidia.length === 0)
    return [...nvidia, ...others]
  }
  const linux = detectLinuxGpus()
  return nvidia.length > 0 ? [...nvidia, ...linux.filter((g) => g.vendor !== "nvidia")] : linux
}

// ── Profile ─────────────────────────────────────────────────────────────────

export type PlatformId = "windows" | "macos" | "linux"

export function detectPlatform(): PlatformId {
  const os = platform()
  if (os === "win32") return "windows"
  if (os === "darwin") return "macos"
  return "linux"
}

export async function detectHardware(): Promise<HardwareProfile> {
  const cpu = detectCpu()
  const ram = detectRam()
  const gpu = detectGpus(ram)

  const diskPath = modelsDir()
  const freeBytes = await freeDiskBytes(diskPath).catch(() => undefined)

  const score = scoreHardware({ ram, cpu, gpu })
  return {
    os: detectPlatform(),
    arch: osArch(),
    cpu,
    ram,
    gpu,
    disk: { freeGB: freeBytes !== undefined ? Number((freeBytes / 1024 ** 3).toFixed(1)) : 0, path: diskPath },
    tier: computeTier(score),
    score,
    detectedAt: Date.now(),
  }
}

/** Human-readable one-liner used by the CLI header, e.g. "RTX 4090 24GB · 32GB RAM · 12 cores". */
export function summarizeHardware(profile: HardwareProfile): string {
  const parts: string[] = []
  const best = [...profile.gpu].filter((g) => g.usable).sort((a, b) => b.vramMB - a.vramMB)[0]
  if (best) {
    const vram = best.unified ? "unified" : best.vramMB > 0 ? `${Math.round(best.vramMB / 1024)}GB` : ""
    parts.push(`${best.name}${vram ? ` ${vram}` : ""}`)
  }
  parts.push(`${Math.round(profile.ram.totalMB / 1024)}GB RAM`)
  parts.push(`${profile.cpu.cores} cores`)
  return parts.join(" · ")
}

const HARDWARE_CACHE_MS = 7 * 24 * 60 * 60 * 1000

function hardwareCachePath(): string {
  return imurunDir("hardware.json")
}

/**
 * Loads the hardware profile, caching it for a week so `imurun models` stays
 * fast. Pass refresh to force a fresh probe.
 */
export async function loadHardware(options: { refresh?: boolean } = {}): Promise<HardwareProfile> {
  if (!options.refresh) {
    const cached = await readJson<HardwareProfile>(hardwareCachePath()).catch(() => undefined)
    if (cached && Date.now() - cached.detectedAt < HARDWARE_CACHE_MS) return cached
  }
  const fresh = await detectHardware()
  await writeJsonAtomic(hardwareCachePath(), fresh).catch(() => {})
  return fresh
}

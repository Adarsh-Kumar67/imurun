/**
 * Formatting helpers — human-readable bytes, durations, speeds, progress bars.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const

/** 6291456 -> "6.00 MB". */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const d = unit === 0 ? 0 : decimals
  return `${value.toFixed(d)} ${BYTE_UNITS[unit]}`
}

/** 13631488 -> "13.0 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 80000 -> "1m 20s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
}

export interface EtaInput {
  downloadedBytes: number
  totalBytes: number
  bytesPerSecond: number
}

/** Estimated seconds remaining, or undefined when unknown/stalled. */
export function estimateEta({ downloadedBytes, totalBytes, bytesPerSecond }: EtaInput): number | undefined {
  if (bytesPerSecond <= 0 || totalBytes <= 0) return undefined
  const remaining = totalBytes - downloadedBytes
  if (remaining <= 0) return 0
  return Math.round(remaining / bytesPerSecond)
}

/** 3, 10 -> "30.0%". */
export function formatPercent(current: number, total: number, decimals = 1): string {
  if (total <= 0) return "0%"
  return `${((current / total) * 100).toFixed(decimals)}%`
}

/** Renders a textual progress bar: "██████░░░░░░ 50.0%". */
export function formatProgressBar(current: number, total: number, width = 30): string {
  const ratio = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0
  const filled = Math.round(ratio * width)
  const percent = `${(ratio * 100).toFixed(1)}%`
  return `\u2588${"\u2588".repeat(Math.max(filled - 1, 0))}${"\u2591".repeat(width - filled)} ${percent}`
}

/** 1234 -> "1,234"; 12345 -> "12,345". */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US")
}

/** 12800 -> "12.8k"; 3450000 -> "3.5M". */
export function formatCompact(n: number): string {
  if (Math.abs(n) < 1000) return String(n)
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

/** Truncates with an ellipsis: truncate("abcdef", 4) -> "abc…". */
export function truncate(text: string, max: number, ellipsis = "\u2026"): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  if (max <= ellipsis.length) return ellipsis.slice(0, max)
  return text.slice(0, max - ellipsis.length) + ellipsis
}

/** Middle-truncation for paths: "C:\very\long\path\file.ts" -> "C:\very\…\file.ts". */
export function truncateMiddle(text: string, max: number, ellipsis = "\u2026"): string {
  if (text.length <= max) return text
  const keep = Math.max(Math.floor((max - ellipsis.length) / 2), 1)
  return text.slice(0, keep) + ellipsis + text.slice(-keep)
}

/** "2026-10-17 14:03" style local timestamp. */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

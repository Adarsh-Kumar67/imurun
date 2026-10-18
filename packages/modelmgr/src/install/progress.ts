/**
 * Terminal progress rendering for model installs.
 *
 * Everything happens on ONE animated line: a spinner, the current phase, a bar,
 * bytes, speed and ETA all update in place. Nothing scrolls while a download
 * runs — the line is overwritten at a steady frame rate so the animation keeps
 * moving even when a phase stalls.
 *
 * On a non-TTY (pipes, CI, logs) it degrades to one line per phase / ~10%.
 * The full-screen UI passes `onLine`/`onMessage` so the same single line is
 * painted inside its own frame instead of written to stdout.
 */
import { formatBytes, formatDuration } from "@imurun/util"
import chalk from "chalk"
import type { DownloadProgress } from "../huggingface/download"
import type { InstallEvent } from "./installer"

/** Spinner frames from the Geometric Shapes block — safe in cmd / Consolas. */
const SPINNER = ["\u25d0", "\u25d3", "\u25d1", "\u25d2"] // ◐ ◓ ◑ ◒

const BAR_WIDTH = 20

export function spinnerFrame(tick: number): string {
  return SPINNER[Math.abs(tick) % SPINNER.length]!
}

function bar(percent: number, width = BAR_WIDTH): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${chalk.green("\u2588".repeat(filled))}${chalk.gray("\u2591".repeat(width - filled))}`
}

function eta(progress: DownloadProgress): string {
  if (!progress.totalBytes || progress.bytesPerSecond <= 0) return ""
  const remaining = (progress.totalBytes - progress.downloadedBytes) / progress.bytesPerSecond
  if (!Number.isFinite(remaining) || remaining < 0) return ""
  return ` \u00b7 ETA ${formatDuration(remaining * 1000)}`
}

/** The single, self-contained install line for a byte-counting phase. */
export function progressLine(label: string, progress: DownloadProgress, frame = 0): string {
  const percent = progress.percent ?? 0
  const transferred = progress.totalBytes
    ? `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`
    : formatBytes(progress.downloadedBytes)
  const speed = progress.bytesPerSecond > 0 ? ` \u00b7 ${formatBytes(progress.bytesPerSecond)}/s` : ""
  return (
    `  ${chalk.cyan(spinnerFrame(frame))} ${chalk.cyan(label)} ${bar(percent)} ` +
    `${chalk.bold(`${percent.toFixed(1)}%`)} ${chalk.gray(transferred + speed + eta(progress))}`
  )
}

/** A single status line for a phase with no byte counter (resolve, engine, …). */
export function statusLine(label: string, frame = 0): string {
  return `  ${chalk.cyan(spinnerFrame(frame))} ${chalk.gray(label)}`
}

export interface InstallRenderer {
  onEvent(event: InstallEvent): void
  /** Clears the live line and returns; safe to call multiple times. */
  dispose(): void
  /** The line currently being animated, if any (used by the full-screen UI). */
  current(): string | undefined
}

export interface InstallRendererOptions {
  stream?: { write: (s: string) => void; isTTY?: boolean }
  /** Live single line updates (undefined when idle). */
  onLine?: (line: string | undefined) => void
  /** Stable one-off lines (storage impact, completion). */
  onMessage?: (line: string) => void
  /** Animation frame interval in ms. Default 90. */
  intervalMs?: number
}

function isOptions(value: unknown): value is InstallRendererOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    ("stream" in value || "onLine" in value || "onMessage" in value || "intervalMs" in value)
  )
}

export function createInstallRenderer(
  input: { write: (s: string) => void; isTTY?: boolean } | InstallRendererOptions = process.stdout,
): InstallRenderer {
  const options: InstallRendererOptions = isOptions(input) ? input : { stream: input }
  const stream = options.stream ?? process.stdout
  const onLine = options.onLine
  const onMessage = options.onMessage
  const captured = Boolean(onLine || onMessage)
  const isTty = captured || Boolean(stream.isTTY)
  const intervalMs = options.intervalMs ?? 90

  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let live = false
  let line: string | undefined
  let lastPercentPrinted = -1

  const writeMessage = (text: string): void => {
    if (onMessage) {
      onMessage(text)
      return
    }
    stream.write(text + "\n")
  }

  const setLine = (text: string | undefined): void => {
    line = text
    if (onLine) {
      onLine(text)
      return
    }
    if (text === undefined) {
      if (live) {
        stream.write("\r\u001b[K")
        live = false
      }
      return
    }
    stream.write("\r\u001b[K" + text)
    live = true
  }

  const stopTimer = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const ensureTimer = (): void => {
    if (timer || !isTty || onLine) return
    timer = setInterval(() => {
      if (line !== undefined) {
        frame++
        setLine(replaceSpinner(line, frame))
      }
    }, intervalMs)
    if (typeof timer.unref === "function") timer.unref()
  }

  return {
    onEvent(event: InstallEvent): void {
      const progress = event.progress

      if (progress && (event.phase === "download" || event.phase === "mmproj" || event.phase === "engine")) {
        const label =
          event.phase === "engine" ? "engine" : event.phase === "mmproj" ? "vision projector" : (event.message ?? "model")
        if (!isTty) {
          const percent = progress.percent ?? 0
          if (percent >= lastPercentPrinted + 10 || percent >= 100) {
            lastPercentPrinted = percent
            writeMessage(progressLine(label, progress, frame))
          }
          return
        }
        setLine(progressLine(label, progress, frame))
        ensureTimer()
        return
      }

      if (event.storage) {
        const s = event.storage
        const free = s.freeBytes !== undefined ? `${formatBytes(s.freeBytes)} free` : "free space unknown"
        const after = s.freeAfterBytes !== undefined ? ` \u2192 ~${formatBytes(Math.max(0, s.freeAfterBytes))} left` : ""
        // one stable pre-flight line — the storage impact before anything downloads
        setLine(undefined)
        writeMessage(
          `  ${chalk.gray("\u25c6")} ${chalk.gray("storage")}  ${chalk.white(formatBytes(s.sizeBytes))} needed \u00b7 ` +
            `${chalk.gray(free + after + ` \u00b7 models ${formatBytes(s.installedAfterBytes)}`)}`,
        )
        return
      }

      if (event.message) {
        if (event.phase === "done") {
          stopTimer()
          setLine(undefined)
          writeMessage(`  ${chalk.green("\u2714")} ${event.message}`)
          return
        }
        if (!isTty) {
          writeMessage(statusLine(event.message, frame))
          return
        }
        setLine(statusLine(event.message, frame))
        ensureTimer()
      }
    },

    current(): string | undefined {
      return line
    },

    dispose(): void {
      stopTimer()
      setLine(undefined)
    },
  }
}

/** Replaces the spinner glyph in a rendered line with a new frame. */
function replaceSpinner(line: string, frame: number): string {
  return line.replace(/[\u25d0-\u25d3]/, spinnerFrame(frame))
}

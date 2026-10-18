/**
 * Logger — leveled, colored, stderr-first logging so stdout stays pipeable.
 *
 * Level via IMURUN_LOG_LEVEL (debug|info|warn|error|silent), default "info".
 * File sink is attached later by the daemon (logs land in ~/.imurun/logs).
 */
import chalk from "chalk"

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
}

function envLevel(): LogLevel {
  const raw = (process.env.IMURUN_LOG_LEVEL ?? "info").toLowerCase()
  if (raw in LEVEL_ORDER) return raw as LogLevel
  return "info"
}

export type LogSink = (line: { level: LogLevel; tag: string; message: string; at: number }) => void

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  /** Logger with a different tag, sharing sinks and level. */
  child(tag: string): Logger
}

const sinks: LogSink[] = []
let level: LogLevel = envLevel()

/** Registers an extra sink (e.g. file writer). Returns an unsubscribe function. */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink)
  return () => {
    const i = sinks.indexOf(sink)
    if (i >= 0) sinks.splice(i, 1)
  }
}

export function setLogLevel(next: LogLevel): void {
  level = next
}

const TAG_COLORS = [chalk.cyan, chalk.magenta, chalk.green, chalk.yellow, chalk.blue, chalk.red]

function tagColor(tag: string): (s: string) => string {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_COLORS[h % TAG_COLORS.length]!
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function log(lvl: LogLevel, tag: string, message: string, args: unknown[]): void {
  if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return
  const at = Date.now()
  const suffix = args.length > 0 ? " " + args.map(formatValue).join(" ") : ""
  const full = message + suffix

  for (const sink of sinks) {
    try {
      sink({ level: lvl, tag, message: full, at })
    } catch {
      // never let a broken sink kill the process
    }
  }

  let prefix: string
  switch (lvl) {
    case "debug":
      prefix = chalk.gray("debug")
      break
    case "info":
      prefix = chalk.blue("info ")
      break
    case "warn":
      prefix = chalk.yellow("warn ")
      break
    default:
      prefix = chalk.red("error")
      break
  }

  const coloredTag = tagColor(tag)(`[${tag}]`)
  const text = `${prefix} ${coloredTag} ${full}`
  console.error(text)
}

export function createLogger(tag = "imurun"): Logger {
  return {
    debug: (m, ...a) => log("debug", tag, m, a),
    info: (m, ...a) => log("info", tag, m, a),
    warn: (m, ...a) => log("warn", tag, m, a),
    error: (m, ...a) => log("error", tag, m, a),
    child: (childTag: string) => createLogger(`${tag}:${childTag}`),
  }
}

export const logger = createLogger("imurun")

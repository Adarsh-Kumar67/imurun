/**
 * Animation primitives — every moving part of the frame is a pure function of
 * a tick counter, so animation never becomes a source of hidden state and can
 * be tested by calling it with different numbers.
 */

/** Rotating spinner (works on terminals that lack braille box-drawing). */
export const SPINNER_FRAMES: readonly string[] = ["\u25d0", "\u25d3", "\u25d1", "\u25d2"]

/** Braille spinner, finer grained; used for the "thinking" state. */
export const BRAILLE_FRAMES: readonly string[] = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
]

/** A short voice-level style pulse used beside streaming text. */
export const PULSE_FRAMES: readonly string[] = [
  "\u2581",
  "\u2583",
  "\u2584",
  "\u2586",
  "\u2587",
  "\u2586",
  "\u2584",
  "\u2583",
]

export function spinnerFrame(tick: number, frames: readonly string[] = BRAILLE_FRAMES): string {
  const list = frames.length > 0 ? frames : SPINNER_FRAMES
  const index = ((tick % list.length) + list.length) % list.length
  return list[index]!
}

export function pulseFrame(tick: number): string {
  const index = ((tick % PULSE_FRAMES.length) + PULSE_FRAMES.length) % PULSE_FRAMES.length
  return PULSE_FRAMES[index]!
}

/** "…" / "." / ".." / "..." — the classic trailing dots. */
export function ellipsis(tick: number, max = 3): string {
  const step = Math.max(1, max)
  return ".".repeat(((tick % (step + 1)) + step + 1) % (step + 1))
}

/** A blinking caret for the end of a streaming message. */
export function caret(tick: number): string {
  return tick % 2 === 0 ? "\u258c" : "\u258e"
}

export interface SweepOptions {
  from: string
  to: string
  /** 0 → 1 as the transition plays. */
  progress: number
  /** Bar width in cells. */
  width?: number
}

/**
 * The agent-change transition: `build → plan` with a bar that fills as the
 * change settles. Callers advance `progress`; when it reaches 1 they can stop
 * animating.
 */
export function agentSwitchLine(options: SweepOptions): string {
  const cells = Math.max(options.width ?? 12, 4)
  const progress = Math.min(Math.max(options.progress, 0), 1)
  const filled = Math.round(progress * cells)
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(Math.max(0, cells - filled))
  return `agent  ${options.from} \u2192 ${options.to}  ${bar}`
}

/** Eases a linear 0→1 ramp so motion starts and stops softly. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(Math.max(t, 0), 1)
  return 1 - Math.pow(1 - clamped, 3)
}

/** Normalises elapsed milliseconds to a 0→1 progress over `durationMs`. */
export function progress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  return Math.min(Math.max(elapsedMs / durationMs, 0), 1)
}

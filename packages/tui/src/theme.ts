/**
 * TUI theme — colors and glyphs in one place so the chat surface stays
 * consistent. chalk degrades gracefully when the terminal has no color.
 */
import chalk from "chalk"

export const theme = {
  brand: chalk.bold.cyan,
  accent: chalk.cyan,
  bold: chalk.bold,
  dim: chalk.gray,
  muted: chalk.dim,
  path: chalk.hex("#8ab4f8"),
  ok: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
} as const

export const sym = {
  arrow: "\u276f", // ❯
  bullet: "\u25cf", // ●
  ok: "\u2714", // ✔
  fail: "\u2716", // ✖
  warn: "\u26a0", // ⚠
  star: "\u2605", // ★
  sub: "\u21b3", // ↳
  diamond: "\u25c6", // ◆
  queued: "\u25cb", // ○ a message that is waiting its turn
  undone: "\u2298", // ⊘ a queued message that was taken back
} as const

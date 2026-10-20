/**
 * Clickable hyperlinks — the OSC 8 escape sequence.
 *
 * A terminal that supports OSC 8 turns a URL in the text into a real link:
 * ctrl-click opens it, the mouse cursor changes over it, and the browser
 * handles it. A terminal that does not support it ignores the sequence
 * completely and shows the text as it is — so this is safe to emit
 * everywhere.
 *
 * The sequence is:
 *
 *     ESC ] 8 ; params ; URI BEL     opens the link
 *     ESC ] 8 ; ; BEL               closes it
 *
 * BEL (0x07) is used rather than the ST form (ESC \), because it is what
 * every terminal emulator in practice understands, and it keeps the sequence
 * to a single byte at the end.
 *
 * The one rule that matters: the escape adds **no visible characters**, so
 * every width calculation in the TUI has to ignore it. `stripAnsi` in
 * ./text does that, and this module's output must always go through it.
 */

/** Opens a link on the given URL. */
export function linkStart(url: string): string {
  return `\u001b]8;;${url}\u0007`
}

/** Closes the link that is open. */
export const LINK_END = "\u001b]8;;\u0007"

/**
 * Wraps text in a hyperlink.
 *
 * The text is left exactly as it is: no styling is applied here, so the
 * caller can style it afterwards and the link still works.
 */
export function hyperlink(url: string, text: string): string {
  if (!url) return text
  return `${linkStart(url)}${text}${LINK_END}`
}

/** True when the terminal emulator is likely to understand OSC 8. */
export function supportsHyperlinks(): boolean {
  const term = process.env.TERM ?? ""
  if (process.env.NO_HYPERLINKS) return false
  // The Windows Terminal, iTerm2, WezTerm, kitty, VTE and foot all support it.
  return /iterm|wezterm|kitty|foot|vte|xterm-256|alacritty|ghostty|hyper|vscode/i.test(term)
}

/**
 * Finds bare URLs in a line of text.
 *
 * Used for tool output and notices, where the text is not markdown and the
 * URL is the whole point of the line.
 */
export function findUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>()[\]"'`]+/g)
  if (!matches) return []
  // Trailing punctuation is almost always sentence punctuation, not part of
  // the address.
  return matches.map((url) => url.replace(/[.,;:!?]+$/, ""))
}

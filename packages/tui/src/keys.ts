/**
 * Key parsing — turns raw terminal input chunks into discrete key events.
 *
 * Terminals only hand us bytes, so this is where escape sequences (arrow keys,
 * function keys, shift+tab) are decoded. Keeping it pure makes it testable
 * without a terminal.
 */

export type KeyName =
  | "enter"
  | "escape"
  | "tab"
  | "shift-tab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "space"

export interface MouseEvent {
  kind: "press" | "release" | "wheel-up" | "wheel-down"
  /** 1-based column and row, as reported by the terminal. */
  x: number
  y: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

export interface KeyEvent {
  /** A named key, or undefined for plain printable input. */
  name?: KeyName
  /** Control modifier (Ctrl+C, Ctrl+U, …). */
  ctrl?: boolean
  /** Printable characters (possibly several for a paste). */
  input?: string
  /** Set for a mouse event (clicks and wheel), when mouse reporting is on. */
  mouse?: MouseEvent
}

/** CSI/SS3 sequences for special keys, without the leading escape. */
const SEQUENCES: Record<string, KeyName> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[Z": "shift-tab",
  "[1~": "home",
  "[4~": "end",
  "[7~": "home",
  "[8~": "end",
  "[3~": "delete",
  "[5~": "pageup",
  "[6~": "pagedown",
  "OA": "up",
  "OB": "down",
  "OC": "right",
  "OD": "left",
  "OH": "home",
  "OF": "end",
}

export class KeyParser {
  /**
   * A sequence that arrived in pieces. The terminal can split a mouse report
   * or an escape sequence across two reads, and a half-sequence that is
   * treated as text ends up *typed into the prompt* — which is how a click
   * turns into a line of gibberish.
   */
  private pending = ""

  /**
   * Returns every key event contained in a raw chunk. Multi-byte escape
   * sequences are matched greedily; anything unrecognised falls through as
   * printable input so nothing is silently dropped.
   */
  push(chunk: string): KeyEvent[] {
    const data = this.pending + chunk
    this.pending = ""
    const events: KeyEvent[] = []
    let i = 0

    while (i < data.length) {
      const char = data[i]!

      if (char === "\u001b") {
        // SGR mouse reporting: ESC [ < button ; x ; y M (press) or m (release).
        const sgr = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i))
        if (sgr) {
          const code = Number(sgr[1])
          const wheel = (code & 64) !== 0
          const kind: MouseEvent["kind"] = wheel
            ? (code & 1) === 0
              ? "wheel-up"
              : "wheel-down"
            : sgr[4] === "m"
              ? "release"
              : "press"
          events.push({
            mouse: {
              kind,
              x: Number(sgr[2]),
              y: Number(sgr[3]),
              shift: (code & 4) !== 0,
              alt: (code & 8) !== 0,
              ctrl: (code & 16) !== 0,
            },
          })
          i += sgr[0].length
          continue
        }

        // The older X10 encoding: ESC [ M, then three bytes holding the
        // button and the position, each offset by 32. Some terminals still
        // send this, and without it their clicks arrive as nothing.
        const legacy = /^\u001b\[M(.)(.)(.)/.exec(data.slice(i))
        if (legacy) {
          const button = legacy[1]!.charCodeAt(0) - 32
          const wheel = (button & 64) !== 0
          const kind: MouseEvent["kind"] = wheel
            ? (button & 1) === 0
              ? "wheel-up"
              : "wheel-down"
            : "press"
          events.push({
            mouse: {
              kind,
              x: legacy[2]!.charCodeAt(0) - 32,
              y: legacy[3]!.charCodeAt(0) - 32,
              shift: (button & 4) !== 0,
              alt: (button & 8) !== 0,
              ctrl: (button & 16) !== 0,
            },
          })
          i += legacy[0].length
          continue
        }

        // try the longest matching escape sequence first
        let matched = false
        for (let len = 4; len >= 1; len--) {
          const seq = data.slice(i + 1, i + 1 + len)
          const name = SEQUENCES[seq]
          if (name) {
            events.push({ name })
            i += 1 + len
            matched = true
            break
          }
        }
        if (matched) continue

        // The sequence may simply not have arrived in full yet. Hold it back
        // rather than typing it into the prompt; the rest arrives in the next
        // chunk, or `flush` gives up and calls it an Escape key.
        if (isPartialEscape(data.slice(i))) {
          this.pending = data.slice(i)
          break
        }

        events.push({ name: "escape" })
        i += 1
        continue
      }

      if (char === "\r" || char === "\n") {
        events.push({ name: "enter" })
        i += 1
        continue
      }
      if (char === "\t") {
        events.push({ name: "tab" })
        i += 1
        continue
      }
      if (char === "\u007f" || char === "\b") {
        events.push({ name: "backspace" })
        i += 1
        continue
      }
      if (char === " ") {
        events.push({ name: "space", input: " " })
        i += 1
        continue
      }

      const code = char.charCodeAt(0)
      if (code > 0 && code < 27) {
        // control character — pair it with the letter so the caller can match
        const letter = String.fromCharCode(code + 96)
        events.push({ ctrl: true, input: letter })
        i += 1
        continue
      }

      // printable run (also covers pasted text)
      let run = ""
      while (i < chunk.length) {
        const c = chunk[i]!
        const cc = c.charCodeAt(0)
        if (c === "\u001b" || c === "\r" || c === "\n" || c === "\t" || c === " " || c === "\u007f" || c === "\b" || cc < 27) break
        run += c
        i += 1
      }
      if (run) events.push({ input: run })
    }

    return events
  }

  /**
   * True when something is waiting for the rest of a sequence.
   *
   * The caller uses this to decide whether to wait a moment before treating
   * a lone Escape as the Escape key.
   */
  get hasPending(): boolean {
    return this.pending.length > 0
  }

  /**
   * Gives up on the incomplete sequence and reports it as the Escape key.
   *
   * This is what the Escape key itself ends up being: one byte that never
   * grew into a sequence.
   */
  flushPending(): KeyEvent[] {
    if (this.pending.length === 0) return []
    this.pending = ""
    return [{ name: "escape" }]
  }
}

/**
 * True when the text looks like the beginning of an escape sequence whose
 * rest has not arrived yet.
 *
 * A CSI sequence is finished by a byte in the 0x40–0x7E range, so anything
 * after `ESC [` that has no such byte is incomplete. A mouse report is the
 * same shape with a `<` in front of it.
 */
function isPartialEscape(text: string): boolean {
  if (text === "\u001b") return true
  if (text.length < 2) return false
  // ESC O is the start of the cursor keys (OA, OB, …).
  if (text === "\u001bO") return true
  if (!text.startsWith("\u001b[")) return false
  const body = text.slice(2)
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index)
    // A final byte ends the sequence. Parameters and intermediate bytes do
    // not, so their presence means the sequence is still arriving.
    if (code >= 0x40 && code <= 0x7e) return false
  }
  return true
}

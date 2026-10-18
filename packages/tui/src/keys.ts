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
   * Returns every key event contained in a raw chunk. Multi-byte escape
   * sequences are matched greedily; anything unrecognised falls through as
   * printable input so nothing is silently dropped.
   */
  push(chunk: string): KeyEvent[] {
    const events: KeyEvent[] = []
    let i = 0

    while (i < chunk.length) {
      const char = chunk[i]!

      if (char === "\u001b") {
        // SGR mouse reporting: ESC [ < button ; x ; y M (press) or m (release).
        const sgr = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(chunk.slice(i))
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

        // try the longest matching escape sequence first
        let matched = false
        for (let len = 4; len >= 1; len--) {
          const seq = chunk.slice(i + 1, i + 1 + len)
          const name = SEQUENCES[seq]
          if (name) {
            events.push({ name })
            i += 1 + len
            matched = true
            break
          }
        }
        if (!matched) {
          events.push({ name: "escape" })
          i += 1
        }
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
}

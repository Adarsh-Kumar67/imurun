/**
 * Screen — a minimal full-screen terminal surface.
 *
 * Switches to the alternate screen buffer, enables raw input, and paints
 * whole frames. Kept deliberately small and dependency-free so it behaves the
 * same on Windows cmd, PowerShell, Windows Terminal, and Unix terminals.
 */

export interface ScreenSize {
  columns: number
  rows: number
}

type WriteStream = Pick<NodeJS.WriteStream, "write" | "columns" | "rows" | "on" | "off">
type ReadStream = Pick<NodeJS.ReadStream, "setRawMode" | "resume" | "pause" | "on" | "off" | "isTTY">

const ALT_SCREEN_ON = "\u001b[?1049h"
const ALT_SCREEN_OFF = "\u001b[?1049l"
const CURSOR_HIDE = "\u001b[?25l"
const CURSOR_SHOW = "\u001b[?25h"
const CLEAR = "\u001b[2J"
const HOME = "\u001b[H"
const MOUSE_ON = "\u001b[?1000h\u001b[?1006h"
const MOUSE_OFF = "\u001b[?1006l\u001b[?1000l"
/** Bracketed paste, so a multi-line paste is not read as keystrokes. */
const BRACKETED_PASTE_ON = "\u001b[?2004h"
const BRACKETED_PASTE_OFF = "\u001b[?2004l"

export class Screen {
  private active = false
  private mouseActive = false
  private readonly dataHandlers = new Set<(chunk: string) => void>()
  private readonly resizeHandlers = new Set<(size: ScreenSize) => void>()
  private readonly handleData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
    for (const handler of this.dataHandlers) handler(text)
  }
  private readonly handleResize = (): void => {
    const size = this.size()
    for (const handler of this.resizeHandlers) handler(size)
  }

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
  ) {}

  get isActive(): boolean {
    return this.active
  }

  start(): void {
    if (this.active) return
    this.active = true
    if (this.input.isTTY && typeof this.input.setRawMode === "function") {
      this.input.setRawMode(true)
    }
    this.input.on("data", this.handleData)
    this.input.resume?.()
    this.output.on("resize", this.handleResize)
    // Mouse reporting: 1000 = clicks, 1006 = SGR coordinates (also the wheel).
    // Held for the whole session so the prompt box is clickable.
    this.output.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR + HOME + BRACKETED_PASTE_ON + MOUSE_ON)
    this.mouseActive = true
  }

  /**
   * Turns mouse reporting off without leaving the screen.
   *
   * While the terminal is reporting the mouse, a drag selects nothing — the
   * terminal sends the events to the program instead of to the user. This
   * releases the mouse so the text can be selected and copied the ordinary
   * way, without leaving the interface. The program keeps running; only the
   * mouse is handed back.
   */
  setMouseEnabled(enabled: boolean): void {
    if (!this.active || this.mouseActive === enabled) return
    this.mouseActive = enabled
    this.output.write(enabled ? MOUSE_ON : MOUSE_OFF)
  }

  /** True while the terminal is reporting the mouse to the program. */
  get mouseEnabled(): boolean {
    return this.mouseActive
  }

  stop(): void {
    if (!this.active) return
    this.active = false
    this.output.write(MOUSE_OFF + BRACKETED_PASTE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF)
    this.mouseActive = false
    this.input.off("data", this.handleData)
    this.output.off("resize", this.handleResize)
    if (this.input.isTTY && typeof this.input.setRawMode === "function") {
      this.input.setRawMode(false)
    }
    this.input.pause?.()
  }

  size(): ScreenSize {
    const columns = Math.max(this.output.columns ?? 80, 20)
    const rows = Math.max(this.output.rows ?? 24, 5)
    return { columns, rows }
  }

  onData(handler: (chunk: string) => void): () => void {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onResize(handler: (size: ScreenSize) => void): () => void {
    this.resizeHandlers.add(handler)
    return () => this.resizeHandlers.delete(handler)
  }

  /**
   * Paints a full frame. Lines are padded/cleared to the terminal width, so a
   * shorter frame never leaves stale characters behind. The cursor is placed
   * last so the writing position never drifts.
   */
  draw(lines: string[], cursor?: { row: number; col: number }): void {
    const { columns, rows } = this.size()
    const frame = lines.slice(0, rows)
    while (frame.length < rows) frame.push("")

    let out = HOME
    for (let i = 0; i < rows; i++) {
      const line = frame[i] ?? ""
      out += line
      // clear the remainder of this row, then move to the next
      out += "\u001b[K"
      if (i < rows - 1) out += "\r\n"
    }

    if (cursor) {
      const row = Math.min(Math.max(cursor.row, 1), rows)
      const col = Math.min(Math.max(cursor.col, 1), columns)
      out += `\u001b[${row};${col}H`
    } else {
      out += CURSOR_HIDE
    }

    this.output.write(out)
  }
}

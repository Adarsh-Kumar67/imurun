/**
 * Palette — the selection list behind `/` suggestions and the model/agent
 * pickers. Handles filtering, keyboard navigation, and a scrolling window so a
 * long list never overflows the popup.
 *
 * Pure state machine: no terminal access, fully testable.
 */

export interface PaletteItem {
  /** Stable id used to act on selection. */
  id: string
  /** Primary line shown to the user. */
  label: string
  /** Secondary, dimmed line. */
  detail?: string
  /** Right-aligned hint (e.g. current marker or size). */
  hint?: string
  /** Free-form group key for sectioning. */
  group?: string
  /** Extra text considered when filtering. */
  keywords?: string
}

export interface PaletteOptions {
  title?: string
  /** Maximum number of rows visible at once. */
  maxRows?: number
}

export class Palette {
  private all: PaletteItem[]
  private filtered: PaletteItem[]
  private cursor = 0
  private q = ""
  readonly title: string
  readonly maxRows: number

  constructor(items: PaletteItem[] = [], options: PaletteOptions = {}) {
    this.all = items
    this.filtered = items
    this.title = options.title ?? ""
    this.maxRows = options.maxRows ?? 8
  }

  get query(): string {
    return this.q
  }

  get items(): PaletteItem[] {
    return this.filtered
  }

  get index(): number {
    return this.cursor
  }

  get length(): number {
    return this.filtered.length
  }

  setItems(items: PaletteItem[]): void {
    this.all = items
    this.apply()
  }

  setQuery(query: string): void {
    if (query === this.q) return
    this.q = query
    this.apply()
  }

  private apply(): void {
    const q = this.q.trim().toLowerCase()
    if (!q) {
      this.filtered = this.all
    } else {
      const scored: Array<{ item: PaletteItem; score: number }> = []
      for (const item of this.all) {
        const haystack = `${item.id} ${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase()
        const index = haystack.indexOf(q)
        if (index === -1) continue
        // prefer prefix matches on the label/id over matches deep in the text
        const startsWith = item.label.toLowerCase().startsWith(q) || item.id.toLowerCase().startsWith(q) ? 0 : 1
        scored.push({ item, score: startsWith * 1000 + index })
      }
      scored.sort((a, b) => a.score - b.score)
      this.filtered = scored.map((entry) => entry.item)
    }
    this.cursor = 0
  }

  move(delta: number): void {
    if (this.filtered.length === 0) return
    const next = (this.cursor + delta) % this.filtered.length
    this.cursor = next < 0 ? next + this.filtered.length : next
  }

  selected(): PaletteItem | undefined {
    return this.filtered[this.cursor]
  }

  /** Visible window of items, clamped so the selection stays in view. */
  window(): { items: PaletteItem[]; offset: number } {
    const total = this.filtered.length
    if (total <= this.maxRows) return { items: this.filtered, offset: 0 }
    let offset = this.cursor - Math.floor(this.maxRows / 2)
    offset = Math.max(0, Math.min(offset, total - this.maxRows))
    return { items: this.filtered.slice(offset, offset + this.maxRows), offset }
  }
}

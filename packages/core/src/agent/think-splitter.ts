/**
 * Think-tag splitter — separates a model's thinking from its answer, live.
 *
 * Local models do not all have a separate reasoning channel. The common ones
 * (Qwen, DeepSeek and their distills) open a ` think` block in the ordinary
 * text stream and close it with ` response`. That reasoning is worth showing —
 * collapsed, and never as the answer — so it has to be pulled out as the
 * deltas arrive, including the awkward case where the tag itself is split
 * across two deltas (`<thi` then `nk>`).
 *
 * The splitter never buffers visible text: anything that cannot possibly be
 * the start of one of the tags is handed straight through, so streaming stays
 * live while the tags are still matched exactly.
 */

/**
 * The opening and closing tags recognised. Qwen and the DeepSeek distills use
 * the "think" pair; some templates emit "thinking" or "reasoning" instead.
 */
const THINK_OPEN = "<" + "think>"
const THINK_CLOSE = "</" + "think>"
const OPEN_TAGS = ["<thinking>", THINK_OPEN, "<reasoning>"] as const
const CLOSE_TAGS = ["</thinking>", THINK_CLOSE, "</reasoning>"] as const

export interface SplitResult {
  /** Text for the user's transcript, or undefined when there is none. */
  text?: string
  /** Text for the collapsed thinking block, or undefined when there is none. */
  reasoning?: string
}

/** How much of a tag could still be arriving: the longest tag's tail length. */
const MAX_TAG_TAIL = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((tag) => tag.length)) - 1

export class ThinkSplitter {
  /** Undefined while outside a block; the closing tag being matched inside one. */
  private closing: (typeof CLOSE_TAGS)[number] | undefined
  /** Characters held back because they may be the start of a tag. */
  private held = ""

  get insideThink(): boolean {
    return this.closing !== undefined
  }

  /**
   * Feeds a delta and returns what can be shown. Call `flush` when the stream
   * ends so nothing held back is lost.
   */
  push(delta: string): SplitResult {
    if (!delta) return {}
    let buffer = this.held + delta
    this.held = ""

    let text = ""
    let reasoning = ""

    while (buffer.length > 0) {
      if (this.closing) {
        const at = buffer.indexOf(this.closing)
        if (at >= 0) {
          reasoning += buffer.slice(0, at)
          buffer = buffer.slice(at + this.closing.length)
          this.closing = undefined
          continue
        }
        // Hold back only a possible partial closing tag; the rest is reasoning.
        const keep = partialTail(buffer, CLOSE_TAGS)
        reasoning += buffer.slice(0, buffer.length - keep)
        this.held = buffer.slice(buffer.length - keep)
        return finish(text, reasoning)
      }

      const open = OPEN_TAGS.map((tag) => ({ tag, at: buffer.indexOf(tag) })).filter((hit) => hit.at >= 0)
      if (open.length > 0) {
        const first = open.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.tag.length > a.tag.length) ? b : a))
        text += buffer.slice(0, first.at)
        buffer = buffer.slice(first.at + first.tag.length)
        this.closing = matchingClose(first.tag)
        continue
      }
      // No opening tag in sight: emit up to the point a partial tag could start.
      const keep = partialTail(buffer, OPEN_TAGS)
      text += buffer.slice(0, buffer.length - keep)
      this.held = buffer.slice(buffer.length - keep)
      return finish(text, reasoning)
    }
    return finish(text, reasoning)
  }

  /**
   * Ends the stream: anything still held becomes visible text outside a block,
   * or reasoning inside one — an unclosed ` think` is still reasoning.
   */
  flush(): SplitResult {
    if (this.held) {
      const pending = this.held
      this.held = ""
      return this.insideThink ? { reasoning: pending } : { text: pending }
    }
    return {}
  }
}

function finish(text: string, reasoning: string): SplitResult {
  return {
    ...(text ? { text } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

function matchingClose(open: (typeof OPEN_TAGS)[number]): (typeof CLOSE_TAGS)[number] {
  const index = OPEN_TAGS.indexOf(open)
  return CLOSE_TAGS[index]!
}

/**
 * How many characters at the end of `buffer` could be the start of one of
 * `tags`? At most the longest tag's prefix — and a short tail is only held
 * back when it genuinely matches a prefix, so ordinary text is never delayed.
 */
function partialTail(buffer: string, tags: readonly string[]): number {
  const start = Math.max(buffer.length - MAX_TAG_TAIL, 0)
  for (let at = start; at < buffer.length; at++) {
    const tail = buffer.slice(at)
    if (tags.some((tag) => tag.startsWith(tail))) return buffer.length - at
  }
  return 0
}

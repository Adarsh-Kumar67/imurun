/**
 * Picking things out of the transcript to copy.
 *
 * Two things are worth copying from a chat: the answer the model just wrote, and
 * a code block — either one the model showed in its reply or one IMURUN rendered
 * as a preview of a file it wrote. Both are found here, in one pass over the
 * blocks, so `/copy` and its list are built from the same reading of the
 * transcript and cannot disagree with each other.
 *
 * Pure: no terminal, no clipboard, no app state.
 */
import type { Block } from "./render"

export interface CopyableBlock {
  /** 1-based, counted from the newest block, so `/copy 1` copies the last thing. */
  index: number
  /** Where it came from: a file path, or `reply N` for code in the answer. */
  label: string
  lang?: string
  text: string
}

/** Pulls ```-fenced blocks out of markdown. An unterminated fence runs to the end. */
export function fencedBlocks(text: string): Array<{ lang?: string; text: string }> {
  const blocks: Array<{ lang?: string; text: string }> = []
  const lines = text.split("\n")
  let open: { lang?: string; body: string[] } | undefined

  for (const line of lines) {
    const fence = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      if (open) {
        blocks.push({ lang: open.lang, text: open.body.join("\n") })
        open = undefined
      } else {
        open = { lang: fence[1] || undefined, body: [] }
      }
      continue
    }
    if (open) open.body.push(line)
  }
  if (open) blocks.push({ lang: open.lang, text: open.body.join("\n") })

  return blocks.map((block) => ({ ...block, text: block.text.replace(/\s+$/, "") }))
}

/**
 * The answer to copy when no number is given: the most recent assistant message
 * that actually has text (a streaming placeholder is skipped).
 */
export function latestAnswer(blocks: readonly Block[]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    if (block.kind === "assistant" && block.text.trim()) return block.text.trim()
  }
  return undefined
}

/**
 * Every code block in the transcript, numbered newest first. A turn that wrote
 * three files contributes three; a reply with two fenced samples contributes two.
 */
export function collectCodeBlocks(blocks: readonly Block[], options: { limit?: number } = {}): CopyableBlock[] {
  const found: Array<Omit<CopyableBlock, "index">> = []

  for (const block of blocks) {
    if (block.kind === "code" && block.text.trim()) {
      found.push({ label: block.title ?? "code", lang: block.lang, text: block.text.replace(/\s+$/, "") })
      continue
    }
    if (block.kind === "assistant" && block.text.includes("```")) {
      const fenced = fencedBlocks(block.text)
      fenced.forEach((entry, i) => {
        if (!entry.text.trim()) return
        found.push({
          label: entry.lang ? `${entry.lang} sample` : `reply sample${fenced.length > 1 ? ` ${i + 1}` : ""}`,
          lang: entry.lang,
          text: entry.text,
        })
      })
    }
  }

  const newestFirst = [...found].reverse().map((entry, i) => ({ ...entry, index: i + 1 }))
  return options.limit ? newestFirst.slice(0, options.limit) : newestFirst
}

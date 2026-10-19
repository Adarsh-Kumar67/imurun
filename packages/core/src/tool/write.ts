/**
 * write — create or overwrite a file atomically.
 *
 * There is no size cap. A model that can emit a large file should be allowed to
 * write it in one call; refusing the call only wastes the tokens it already
 * spent. What actually goes wrong with a local model and a big file is that the
 * model's *output* is cut off by its own limit, mid-argument — that call never
 * parses and so never reaches this tool. So the useful guard is not a refusal
 * but an after-the-fact check: if what landed looks structurally unfinished,
 * say so and ask for the rest, appended.
 */
import { readFile, stat } from "node:fs/promises"
import { relative } from "node:path"
import { writeFileAtomic } from "@imurun/util"
import { invalidateRag } from "../rag/index"
import type { ImurunTool } from "./types"
import { fail, ok, requireString } from "./types"
import { resolveToolPath } from "./read"

/** Extensions where balanced brackets are a real signal that a file is whole. */
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "css", "scss", "less", "go", "rs", "c", "cc", "cpp", "h", "hpp",
  "cs", "java", "kt", "kts", "swift", "php", "rb", "sh", "bash", "zsh",
  "py", "scala", "lua", "dart", "vue", "svelte", "sql",
])

interface BracketCounts {
  curly: number
  square: number
  round: number
  string: boolean
}

/**
 * Counts brackets while ignoring strings and comments, so `"}"` in a string or
 * a brace in a comment does not skew the result. Not a full parser — just
 * enough to tell a finished file from an obviously cut-off one.
 */
export function scanBrackets(text: string): BracketCounts {
  let curly = 0
  let square = 0
  let round = 0
  let quote: string | undefined
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (lineComment) {
      if (ch === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false
        i++
      }
      continue
    }
    if (quote) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "/" && next === "/") {
      lineComment = true
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      blockComment = true
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "{") curly++
    else if (ch === "}") curly--
    else if (ch === "[") square++
    else if (ch === "]") square--
    else if (ch === "(") round++
    else if (ch === ")") round--
  }

  return { curly, square, round, string: quote !== undefined }
}

/**
 * Returns a note when the written text looks structurally unfinished, else
 * undefined. Only code-like files are checked: prose is full of unmatched
 * brackets and parentheses on purpose.
 */
export function detectTruncation(relPath: string, content: string): string | undefined {
  if (content.length === 0) return undefined
  const dot = relPath.lastIndexOf(".")
  const ext = dot === -1 ? "" : relPath.slice(dot + 1).toLowerCase()
  if (!CODE_EXTENSIONS.has(ext)) return undefined

  if (ext === "json" || ext === "jsonc") {
    try {
      JSON.parse(content)
      return undefined
    } catch {
      return (
        `Note: ${relPath} is not valid JSON, so it is probably incomplete. If your output was ` +
        `cut off, call write again with mode "append" to add the rest.`
      )
    }
  }

  const counts = scanBrackets(content)
  const missing: string[] = []
  if (counts.curly > 0) missing.push(`${counts.curly} unclosed {`)
  if (counts.square > 0) missing.push(`${counts.square} unclosed [`)
  if (counts.round > 0) missing.push(`${counts.round} unclosed (`)
  if (counts.string) missing.push("an unterminated string")
  if (missing.length === 0) return undefined

  return (
    `Note: ${relPath} looks unfinished \u2014 ${missing.join(", ")}. If your output was cut off, ` +
    `call write again with mode "append" to add the rest before reading or running the file.`
  )
}

export const writeTool: ImurunTool = {
  name: "write",
  description:
    "Write content to a file, creating it (and parent directories) if needed. " +
    "Modes: overwrite (default) replaces the whole file, append adds to the end, " +
    "create refuses to touch an existing file. " +
    "There is no size limit: write a whole file in one call when you can. If your output " +
    "limit cuts the call off, nothing is written and the tool reports it \u2014 then write it " +
    "in sections instead: create the file with the first section, and append the rest with " +
    "mode \"append\". If the file you write looks structurally unfinished, the result says so; " +
    "continue with append before reading or running it. " +
    "Use edit for a targeted change inside an existing file, and shell when a command-line " +
    "tool is the better way to produce the content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to the working directory or absolute)." },
      content: { type: "string", description: "Content to write." },
      mode: {
        type: "string",
        enum: ["overwrite", "append", "create"],
        description:
          "overwrite (default) replaces the file, append adds to the end (adds a newline first if needed), " +
          "create fails if the file already exists.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  title: (args) => {
    const mode = typeof args.mode === "string" && args.mode !== "overwrite" ? ` (${args.mode})` : ""
    return `write${mode} ${String(args.path ?? "")}`
  },
  async execute(args, ctx) {
    const path = resolveToolPath(ctx.workingDir, requireString(args, "path"))
    const content = typeof args.content === "string" ? args.content : undefined
    if (content === undefined) return fail("Missing required string argument: content")
    const mode = args.mode === "append" || args.mode === "create" ? args.mode : "overwrite"

    try {
      const existing = await stat(path).catch(() => undefined)
      if (existing?.isDirectory()) {
        return fail(`Path is a directory: ${path}`)
      }
      if (mode === "create" && existing) {
        return fail(
          `${path} already exists. Use append to add to it, edit to change it, or overwrite to replace it.`,
        )
      }

      let body = content
      if (mode === "append" && existing) {
        const current = await readFile(path, "utf8").catch(() => "")
        if (current.length > 0 && !current.endsWith("\n")) body = `\n${content}`
        body = current + body
      }

      await writeFileAtomic(path, body)
      invalidateRag(ctx.workingDir)

      const rel = relative(ctx.workingDir, path) || path
      const verb = mode === "append" ? "Appended to" : existing ? "Updated" : "Created"
      const bytes = Buffer.byteLength(body, "utf8")
      const lines = body === "" ? 0 : body.split(/\r?\n/).length
      await ctx.ledger?.noteFile(rel, { bytes, lines, mode })

      // Only the text this call added matters for the completeness check: an
      // append continues an already-whole file, so check the appended part on
      // its own rather than the whole accumulated body.
      const note = mode === "append" ? detectTruncation(rel, content) : detectTruncation(rel, body)
      const message = `${verb} ${rel} (${bytes} bytes, ${lines} lines)${note ? `\n\n${note}` : ""}`
      return ok(message, {
        title: `${verb.toLowerCase()} ${rel}`,
        data: { path: rel, bytes, lines, mode, warning: note ? "unfinished" : undefined },
      })
    } catch (error) {
      return fail(`Failed to write ${path}: ${(error as Error).message}`)
    }
  },
}

/** Shared helper for tools that need to ensure the target is a text file. */
export async function readTextOrError(path: string): Promise<{ text?: string; error?: string }> {
  try {
    const buffer = await readFile(path)
    if (buffer.subarray(0, 8192).includes(0)) {
      return { error: `Binary file detected: ${path}` }
    }
    return { text: buffer.toString("utf8") }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { error: `File not found: ${path}` }
    return { error: `Failed to read ${path}: ${(error as Error).message}` }
  }
}

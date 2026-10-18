/**
 * write — create or overwrite a file atomically.
 */
import { readFile, stat } from "node:fs/promises"
import { relative } from "node:path"
import { writeFileAtomic } from "@imurun/util"
import { invalidateRag } from "../rag/index"
import type { ImurunTool } from "./types"
import { fail, ok, requireString } from "./types"
import { resolveToolPath } from "./read"

export const writeTool: ImurunTool = {
  name: "write",
  description:
    "Write content to a file, creating it (and parent directories) if needed. " +
    "Modes: overwrite (default) replaces the whole file, append adds to the end, " +
    "create refuses to touch an existing file. For a large file, write the first " +
    "section with create/overwrite and each following section with append — a " +
    "single call that runs past the output limit is cut off and wasted. " +
    "Use edit for a targeted change inside an existing file.",
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
      return ok(`${verb} ${rel} (${bytes} bytes, ${lines} lines)`, {
        title: `${verb.toLowerCase()} ${rel}`,
        data: { path: rel, bytes, lines, mode },
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

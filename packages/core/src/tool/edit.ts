/**
 * edit — exact-match string replacement with uniqueness enforcement.
 *
 * The replacement string must appear in the file. If it appears more than
 * once, the edit fails unless replaceAll is true — this prevents accidental
 * mass edits when the model meant a specific occurrence.
 */
import { stat } from "node:fs/promises"
import { relative } from "node:path"
import { writeFileAtomic } from "@imurun/util"
import { invalidateRag } from "../rag/index"
import type { ImurunTool } from "./types"
import { fail, ok, requireString, optionalBoolean } from "./types"
import { resolveToolPath } from "./read"
import { readTextOrError } from "./write"

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found === -1) break
    count++
    index = found + needle.length
  }
  return count
}

function lineOfIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length
}

export const editTool: ImurunTool = {
  name: "edit",
  description:
    "Replace an exact string in a file. The old string must match exactly (including whitespace) " +
    "and must be unique in the file unless replaceAll is true. Always read the file first to copy exact text.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to the working directory or absolute)." },
      oldString: { type: "string", description: "Exact text to find." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence (default: require uniqueness)." },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  title: (args) => `edit ${String(args.path ?? "")}`,
  async execute(args, ctx) {
    const path = resolveToolPath(ctx.workingDir, requireString(args, "path"))
    const oldString = requireString(args, "oldString")
    const newString = typeof args.newString === "string" ? args.newString : requireString(args, "newString")
    const replaceAll = optionalBoolean(args, "replaceAll") ?? false

    const info = await stat(path).catch(() => undefined)
    if (!info) return fail(`File not found: ${path}`)
    if (info.isDirectory()) return fail(`Path is a directory: ${path}`)

    const { text, error } = await readTextOrError(path)
    if (error || text === undefined) return fail(error ?? "Unable to read file")

    if (oldString === newString) return fail("oldString and newString are identical — nothing to do")

    const occurrences = countOccurrences(text, oldString)
    if (occurrences === 0) {
      return fail(
        "oldString not found in file. Read the file first and copy the exact text including whitespace and indentation.",
      )
    }
    if (occurrences > 1 && !replaceAll) {
      return fail(
        `oldString appears ${occurrences} times. Include more surrounding context to make it unique, or set replaceAll: true.`,
      )
    }

    const firstLine = lineOfIndex(text, text.indexOf(oldString))
    const updated = replaceAll
      ? text.split(oldString).join(newString)
      : text.slice(0, text.indexOf(oldString)) + newString + text.slice(text.indexOf(oldString) + oldString.length)

    try {
      await writeFileAtomic(path, updated)
      invalidateRag(ctx.workingDir)
    } catch (writeError) {
      return fail(`Failed to write ${path}: ${(writeError as Error).message}`)
    }

    const rel = relative(ctx.workingDir, path) || path
    const replaced = replaceAll ? occurrences : 1
    await ctx.ledger?.noteFile(rel, {
      bytes: Buffer.byteLength(updated, "utf8"),
      lines: updated.split(/\r?\n/).length,
      mode: "edit",
    })
    return ok(`Edited ${rel}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} at line ${firstLine}`, {
      title: `edit ${rel}`,
      data: { path: rel, firstLine, replaced },
    })
  },
}

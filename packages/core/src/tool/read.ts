/**
 * read — read a text file with line numbers, offset/limit windows, and
 * binary/image detection. Paths resolve against the working directory.
 */
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ImurunTool } from "./types"
import { fail, ok, requireString, optionalNumber } from "./types"

const MAX_BYTES = 512 * 1024
const MAX_LINE_CHARS = 2000

export function resolveToolPath(workingDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workingDir, path)
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  return sample.includes(0)
}

export const readTool: ImurunTool = {
  name: "read",
  description:
    "Read a file from the filesystem and return its contents with line numbers. " +
    "Use offset/limit for large files. Images and binary files are reported but not decoded yet.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to the working directory or absolute)." },
      offset: { type: "number", description: "1-based line number to start from." },
      limit: { type: "number", description: "Maximum number of lines to return." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  title: (args) => `read ${String(args.path ?? "")}`,
  async execute(args, ctx) {
    const path = resolveToolPath(ctx.workingDir, requireString(args, "path"))
    try {
      const info = await stat(path)
      if (info.isDirectory()) {
        return fail(`Path is a directory, not a file: ${path}`)
      }
      if (info.size > MAX_BYTES) {
        return fail(
          `File too large to read (${Math.round(info.size / 1024)} KB, limit ${Math.round(MAX_BYTES / 1024)} KB). Use grep to search within it, or shell with head/tail.`,
        )
      }

      const buffer = await readFile(path)
      if (looksBinary(buffer)) {
        return fail(`Binary file detected (${path}). Reading binary files is not supported yet.`)
      }

      const text = buffer.toString("utf8")
      const allLines = text.split(/\r?\n/)
      const offset = Math.max((optionalNumber(args, "offset") ?? 1) - 1, 0)
      const limit = optionalNumber(args, "limit") ?? allLines.length
      const selected = allLines.slice(offset, offset + limit)

      if (selected.length === 0) {
        return ok(`(no lines in range; file has ${allLines.length} lines)`)
      }

      const width = String(offset + selected.length).length
      const rendered = selected
        .map((line, i) => {
          const lineNo = offset + i + 1
          const clipped = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + " …[clipped]" : line
          return `${String(lineNo).padStart(width)}\u2502 ${clipped}`
        })
        .join("\n")

      const rangeInfo =
        offset > 0 || offset + selected.length < allLines.length
          ? `\n(showing lines ${offset + 1}-${offset + selected.length} of ${allLines.length})`
          : ""

      return ok(rendered + rangeInfo, { title: `${path} (${selected.length} lines)` })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return fail(`File not found: ${path}`)
      return fail(`Failed to read ${path}: ${(error as Error).message}`)
    }
  },
}

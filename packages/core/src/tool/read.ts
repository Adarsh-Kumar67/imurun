/**
 * read — read a text file with line numbers, offset/limit windows, and
 * image support (a picture is described in words, and shown to a model that can
 * see it). Paths resolve against the working directory.
 */
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { describeImage, formatBytes, imageInfo, isImagePath } from "@imurun/util"
import type { ImurunTool } from "./types"
import { fail, ok, requireString, optionalNumber } from "./types"

const MAX_BYTES = 512 * 1024
const MAX_LINE_CHARS = 2000
/** Images are bigger than source files and worth reading whole. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

export function resolveToolPath(workingDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workingDir, path)
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  return sample.includes(0)
}

/** What a text-only model is told about a picture it cannot be shown. */
function imageWithoutVision(path: string, description: string): string {
  return (
    `Image file: ${path} (${description}).\n` +
    `This model cannot see images, so the picture itself was not sent. If the user asked about ` +
    `what it contains, say plainly that you cannot view it and ask them to describe it or read ` +
    `the relevant text instead.`
  )
}

/** Reads an image by extension, handing it over only to a model that can see. */
async function readImage(path: string, size: number, vision: boolean) {
  if (size > MAX_IMAGE_BYTES) {
    return fail(`Image too large to read (${formatBytes(size)}, limit ${formatBytes(MAX_IMAGE_BYTES)}).`)
  }
  const bytes = await readFile(path)
  const info = imageInfo(bytes)
  const description = info ? describeImage(info, size) : `unknown format, ${formatBytes(size)}`

  if (!vision) return ok(imageWithoutVision(path, description), { title: `${path} (image)` })
  if (!info) return fail(`Could not identify the image format of ${path}.`)

  return ok(`Image: ${description}. Attached — look at it before answering.`, {
    images: [{ mime: info.mime, data: bytes.toString("base64") }],
    data: { path, ...info },
    title: `${path} (${describeImage(info)})`,
  })
}

export const readTool: ImurunTool = {
  name: "read",
  description:
    "Read a file from the filesystem and return its contents with line numbers. " +
    "Use offset/limit for large files. Images are described, and shown to you when your model " +
    "can see them; other binary files are reported but not decoded.",
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

      // An image is not text and must not be read as text. What the model gets
      // depends on whether it can see: the picture itself, or a plain sentence
      // saying what the picture is and where it is.
      if (isImagePath(path)) return readImage(path, info.size, ctx.vision === true)

      if (info.size > MAX_BYTES) {
        return fail(
          `File too large to read (${Math.round(info.size / 1024)} KB, limit ${Math.round(MAX_BYTES / 1024)} KB). Use grep to search within it, or shell with head/tail.`,
        )
      }

      const buffer = await readFile(path)
      if (looksBinary(buffer)) {
        // Not an image by extension, but it may be one all the same (a file
        // saved without a suffix). Say what it is rather than just refusing.
        const decoded = imageInfo(buffer)
        if (decoded) {
          return ctx.vision === true
            ? ok(`Image: ${describeImage(decoded, info.size)}. Attached.`, {
                images: [{ mime: decoded.mime, data: buffer.toString("base64") }],
                title: `${path} (${describeImage(decoded)})`,
              })
            : ok(imageWithoutVision(path, describeImage(decoded, info.size)))
        }
        return fail(`Binary file detected (${path}). Reading binary files is not supported.`)
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

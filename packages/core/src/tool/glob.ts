/**
 * glob — find files by pattern, newest first. Fast: backed by Bun's native
 * glob scanner.
 */
import { stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import type { ImurunTool } from "./types"
import { fail, ok, optionalNumber, optionalString, requireString } from "./types"
import { resolveToolPath } from "./read"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Directories never worth searching in a coding project. */
export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode-test",
  "coverage",
])

export function isIgnoredPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((part) => DEFAULT_IGNORE_DIRS.has(part))
}

export const globTool: ImurunTool = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. \"**/*.ts\", \"src/**/*.test.ts\"). " +
    "Returns paths sorted by modification time, newest first.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match, e.g. **/*.ts" },
      path: { type: "string", description: "Directory to search (default: project directory)." },
      limit: { type: "number", description: `Maximum results (default ${DEFAULT_LIMIT}).` },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  title: (args) => `glob ${String(args.pattern ?? "")}`,
  async execute(args, ctx) {
    const pattern = requireString(args, "pattern")
    const searchDir = resolveToolPath(ctx.workingDir, optionalString(args, "path") ?? ".")
    const limit = Math.min(optionalNumber(args, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT)

    try {
      const glob = new Bun.Glob(pattern)
      const matches: Array<{ file: string; mtime: number }> = []

      for await (const file of glob.scan({ cwd: searchDir, onlyFiles: true, dot: false })) {
        const normalized = file.replace(/\\/g, "/")
        if (isIgnoredPath(normalized)) continue
        try {
          const info = await stat(resolve(searchDir, file))
          matches.push({ file: normalized, mtime: info.mtimeMs })
        } catch {
          // vanished mid-scan; skip
        }
      }

      if (matches.length === 0) {
        return ok(`No files match pattern "${pattern}" in ${relative(ctx.workingDir, searchDir) || "."}`)
      }

      matches.sort((a, b) => b.mtime - a.mtime)
      const shown = matches.slice(0, limit)
      const listing = shown.map((m) => m.file).join("\n")
      const extra = matches.length > limit ? `\n…and ${matches.length - limit} more (${matches.length} total)` : ""
      return ok(listing + extra, { title: `${matches.length} files match ${pattern}` })
    } catch (error) {
      return fail(`Glob failed: ${(error as Error).message}`)
    }
  },
}

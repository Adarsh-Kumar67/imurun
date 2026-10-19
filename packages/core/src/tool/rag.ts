/**
 * code_search — the agent's way of finding things in a project.
 *
 * It is backed by the offline project index (see ../rag), which is kept up to
 * date automatically: the first search builds it, later ones re-check only the
 * files that changed, and a write or edit marks it stale so the next search sees
 * the new contents. The agent never has to be told to "index the project", and
 * the search works with no model, no network and nothing running.
 */
import { getRagIndex, formatRagHit, RAG_FRESH_MS } from "../rag/index"
import { projectRagIndex, refreshRagIndex } from "../rag/config"
import type { ImurunTool } from "./types"
import { fail, ok, optionalNumber, optionalString, requireString } from "./types"

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 30

export const codeSearchTool: ImurunTool = {
  name: "code_search",
  description:
    "Search the whole project at once and get back the most relevant places, with file paths, line ranges and a short excerpt. " +
    "Works offline over an index that stays up to date automatically. " +
    "Use it first, before reading files, whenever you need to find where something is defined or used.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to find — natural language or identifiers, e.g. \"where are permissions checked\" or \"runtime context size\"." },
      path: { type: "string", description: "Restrict matches to paths containing this fragment, e.g. \"packages/tui\"." },
      limit: { type: "number", description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  title: (args) => `code_search ${String(args.query ?? "").slice(0, 60)}`,

  async execute(args, ctx) {
    const query = requireString(args, "query")
    const limit = Math.min(optionalNumber(args, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT)
    const pathFragment = optionalString(args, "path")

    if (ctx.config && !ctx.config.rag.enabled) {
      return fail(
        "Project search is turned off (rag.enabled is false in your configuration). Use grep for an exact string instead.",
      )
    }

    // With no configuration in reach (a bare tool call in a test), fall back to
    // the index defaults rather than refusing to search.
    const index = ctx.config ? projectRagIndex(ctx.workingDir, ctx.config) : getRagIndex(ctx.workingDir)
    try {
      if (ctx.config) await refreshRagIndex(index, ctx.config)
      else await index.ensureFresh({ maxAgeMs: RAG_FRESH_MS })
    } catch (error) {
      return fail(`Could not index this project: ${(error as Error).message}`)
    }

    const hits = index.search(query, { limit, path: pathFragment })
    const stats = index.stats()

    if (hits.length === 0) {
      const where = pathFragment ? ` under "${pathFragment}"` : ""
      return ok(
        `No match for "${query}"${where}. The index covers ${stats.files} file(s) of this project` +
          ` (${stats.chunks} chunks); try fewer or different words, or use grep for an exact string.`,
      )
    }

    const body = hits.map(formatRagHit).join("\n\n")
    const files = new Set(hits.map((hit) => hit.path)).size
    return ok(body, { title: `${hits.length} match(es) in ${files} file(s)` })
  },
}

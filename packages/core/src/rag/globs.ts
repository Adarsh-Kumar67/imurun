/**
 * A tiny glob matcher, for the `rag.excludeGlobs` list.
 *
 * The index only needs to answer "is this project-relative path excluded?", and
 * it must do so without pulling in a dependency. `**`, `*` and `?` are
 * supported, matching the same way they do in `.gitignore`-style patterns:
 *
 *   node_modules/**   the directory and everything under it
 *   **\/*.min.*       any file with .min. in its name, at any depth
 *   *.lock            a file with that name, at any depth
 */
import { isIgnoredPath } from "../tool/glob"

/** Turns one glob into a regular-expression body. */
export function globToRegex(glob: string): string {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // A leading "**/" also matches at the root, the way .gitignore reads it.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?"
          i += 2
        } else {
          out += ".*"
          i++
        }
      } else {
        out += "[^/]*"
      }
      continue
    }
    if (char === "?") {
      out += "[^/]"
      continue
    }
    out += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
  }
  return out
}

/** True when a project-relative path matches one glob pattern. */
export function matchPathGlob(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "")
  const glob = pattern.replace(/\\/g, "/").replace(/^\.\//, "").trim()
  if (!glob) return false

  // "dir/**" means the directory itself and everything below it.
  if (glob.endsWith("/**")) {
    const dir = glob.slice(0, -3)
    const body = globToRegex(dir)
    return new RegExp(`^${body}(/|$)`).test(normalized)
  }

  const regex = new RegExp(`^${globToRegex(glob)}$`)
  // A pattern with no slash matches at any depth, like .gitignore.
  if (!glob.includes("/")) return regex.test(normalized.split("/").pop() ?? "")
  return regex.test(normalized)
}

/** True when a path is excluded by the built-in list or the configured globs. */
export function isExcludedPath(path: string, excludeGlobs: readonly string[] = []): boolean {
  if (isIgnoredPath(path)) return true
  return excludeGlobs.some((pattern) => matchPathGlob(path, pattern))
}

/**
 * JSONC support — config files may contain comments and trailing commas.
 * This is a tolerant parser for local configuration files only.
 */

/** Pass 1: strips // and block comments, respecting string literals. */
function stripComments(input: string): string {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    const next = input[i + 1]

    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }

    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }

    if (inString) {
      out += c
      if (escaped) {
        escaped = false
      } else if (c === "\\") {
        escaped = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      continue
    }

    if (c === "/" && next === "/") {
      inLine = true
      i++
      continue
    }

    if (c === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }

    out += c
  }

  return out
}

/** Pass 2: removes commas that are immediately followed by a closing brace/bracket. */
function stripTrailingCommas(input: string): string {
  let out = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!

    if (inString) {
      out += c
      if (escaped) {
        escaped = false
      } else if (c === "\\") {
        escaped = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      continue
    }

    if (c === ",") {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j]!)) j++
      const after = input[j]
      if (after === "}" || after === "]") continue // drop the comma
    }

    out += c
  }

  return out
}

/** Strips comments and trailing commas from JSONC text. */
export function stripJsonComments(input: string): string {
  return stripTrailingCommas(stripComments(input))
}

/** Parses JSON with comments and trailing commas allowed. */
export function parseJsonc<T = unknown>(input: string): T {
  return JSON.parse(stripJsonComments(input)) as T
}

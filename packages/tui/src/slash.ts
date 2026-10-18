/**
 * Slash command plumbing — parsing, a registry, and completion.
 *
 * Kept free of app internals (the command body receives the app as an
 * argument) so it can be unit tested on its own.
 */
import type { TuiApp } from "./app"

export interface SlashCommand {
  name: string
  aliases?: string[]
  summary: string
  usage?: string
  run?(app: TuiApp, args: string[]): Promise<void> | void
}

export interface ParsedSlash {
  /** Lower-cased command name, or "" when the user typed a bare "/". */
  name: string
  args: string[]
}

/** Splits a line into tokens, honoring single and double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (current !== "") tokens.push(current)
  return tokens
}

/** Parses a slash command line; returns undefined for normal input. */
export function parseSlash(line: string): ParsedSlash | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return undefined
  const tokens = tokenize(trimmed.slice(1))
  if (tokens.length === 0) return { name: "", args: [] }
  return { name: tokens[0]!.toLowerCase(), args: tokens.slice(1) }
}

export class SlashRegistry {
  private readonly commands = new Map<string, SlashCommand>()

  register(command: SlashCommand): this {
    this.commands.set(command.name, command)
    for (const alias of command.aliases ?? []) this.commands.set(alias, command)
    return this
  }

  find(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase())
  }

  /** Commands once each (aliases collapsed), in registration order. */
  unique(): SlashCommand[] {
    return [...new Set(this.commands.values())]
  }

  names(): string[] {
    return [...this.commands.keys()].sort()
  }

  complete(prefix: string): string[] {
    const p = prefix.toLowerCase()
    return this.names().filter((name) => name.startsWith(p))
  }
}

/**
 * Progress vocabulary — what to say while a tool is running.
 *
 * A spinner that only says "working" tells the user nothing; the words are the
 * cheapest way to make a long tool call legible. The phrase is chosen from the
 * tool *and its target* (a `.css` write talks about colour, a `.ts` write talks
 * about logic), and it advances on a timer so the line keeps moving.
 *
 * Pure functions only: given elapsed time and a word list the output is
 * deterministic, which keeps it testable and keeps animations from becoming
 * hidden state.
 */

/** Words used while writing, picked by what kind of file is being written. */
const WRITE_WORDS: Record<string, readonly string[]> = {
  style: ["starting", "setting the base", "adding colour", "spacing things out", "polishing the details", "branding"],
  markup: ["starting", "laying out the structure", "filling the sections", "hooking up the styles", "polishing"],
  script: ["starting", "setting the base", "wiring the logic", "handling the edges", "tightening it up"],
  data: ["starting", "setting the keys", "filling the values", "checking the shape"],
  prose: ["starting", "drafting", "filling the sections", "editing for clarity"],
  default: ["starting", "setting the base", "writing it out", "finishing"],
}

/** Tool name → generic phrase list, used when the target says nothing useful. */
const TOOL_WORDS: Record<string, readonly string[]> = {
  read: ["finding the file", "opening it", "reading through it", "scanning the details"],
  glob: ["scanning the project", "matching names", "narrowing the list"],
  grep: ["searching the contents", "matching the pattern", "narrowing the hits", "ranking what fits"],
  code_search: ["searching by meaning", "querying the index", "picking the best matches", "reading the excerpts"],
  write: WRITE_WORDS.default,
  edit: ["reading the target", "finding the spot", "applying the change", "checking the result"],
  shell: ["thinking the command through", "spinning it up", "running", "waiting on output"],
  web_search: ["reaching the network", "collecting results", "picking out the useful bits"],
  web_fetch: ["reaching the network", "downloading", "reading it down", "pulling out the text"],
  task: ["briefing a subagent", "delegating the work", "waiting on the subagent"],
  memory: ["checking memory", "saving the note"],
  progress: ["checking what is done", "updating the ledger"],
  skill: ["loading the method", "reading the steps"],
}

const DEFAULT_WORDS: readonly string[] = ["working", "still working", "shaping it up", "finishing"]

/** Maps a file extension to a WRITE_WORDS family. */
const EXTENSION_FAMILY: Record<string, keyof typeof WRITE_WORDS> = {
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  styl: "style",
  html: "markup",
  htm: "markup",
  vue: "markup",
  svelte: "markup",
  jsx: "markup",
  tsx: "markup",
  ts: "script",
  js: "script",
  mjs: "script",
  cjs: "script",
  py: "script",
  go: "script",
  rs: "script",
  java: "script",
  kt: "script",
  swift: "script",
  c: "script",
  h: "script",
  cpp: "script",
  hpp: "script",
  cs: "script",
  rb: "script",
  php: "script",
  sh: "script",
  ps1: "script",
  json: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  ini: "data",
  env: "data",
  md: "prose",
  mdx: "prose",
  txt: "prose",
  rst: "prose",
}

/** Rough wall-clock estimate per tool; only drives the fill rate of the bar. */
const TOOL_ESTIMATE_MS: Record<string, number> = {
  read: 700,
  glob: 900,
  grep: 1500,
  code_search: 1800,
  write: 1800,
  edit: 1400,
  shell: 6000,
  web_search: 3000,
  web_fetch: 3000,
  task: 12000,
  memory: 600,
  progress: 500,
}

const DEFAULT_ESTIMATE_MS = 1500

function extensionOf(path: string | undefined): string {
  if (!path) return ""
  const base = path.replace(/\\/g, "/").split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return ""
  return base.slice(dot + 1).toLowerCase()
}

/**
 * The words shown under a running tool call. `write`/`edit` look at the target
 * extension so the vocabulary matches the work.
 */
export function progressWords(name: string, args: Record<string, unknown> = {}): readonly string[] {
  if (name === "write" || name === "edit") {
    const path = typeof args.path === "string" ? args.path : undefined
    const family = EXTENSION_FAMILY[extensionOf(path)]
    if (family) return WRITE_WORDS[family]!
    return WRITE_WORDS.default!
  }
  return TOOL_WORDS[name] ?? DEFAULT_WORDS
}

/** How long one phrase is held before moving to the next. */
export const PHRASE_MS = 1600

/**
 * The phrase for a given elapsed time: it steps through the list and then stays
 * on the last one ("finishing"), so a slow tool never loops back to "starting".
 */
export function progressPhrase(words: readonly string[], elapsedMs: number, msPerWord = PHRASE_MS): string {
  if (words.length === 0) return ""
  const index = Math.min(Math.floor(Math.max(elapsedMs, 0) / Math.max(msPerWord, 1)), words.length - 1)
  return words[index]!
}

/**
 * Fill fraction for the bar: an exponential approach that flattens just under
 * 100%, so the bar never claims to be finished before the tool really is.
 */
export function progressFraction(elapsedMs: number, estimateMs: number): number {
  if (estimateMs <= 0) return 0.5
  const fraction = 1 - Math.exp(-Math.max(elapsedMs, 0) / (estimateMs * 0.9))
  return Math.min(Math.max(fraction, 0), 0.97)
}

export function progressBar(fraction: number, width: number): string {
  const cells = Math.max(Math.round(width), 1)
  const filled = Math.min(Math.max(Math.round(cells * Math.min(Math.max(fraction, 0), 1)), 0), cells)
  return `${"\u2588".repeat(filled)}${"\u2591".repeat(cells - filled)}`
}

export function estimateToolMs(name: string): number {
  return TOOL_ESTIMATE_MS[name] ?? DEFAULT_ESTIMATE_MS
}

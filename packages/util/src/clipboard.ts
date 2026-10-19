/**
 * Clipboard — put text where the user can paste it.
 *
 * There is no portable clipboard API for a plain terminal process, so IMURUN
 * asks the platform's own tool: `clip` on Windows, `pbcopy` on macOS, and on
 * Linux whichever of `wl-copy`, `xclip`, or `xsel` is installed. When none of
 * them exists, or the one that does fails, the text is written to a file and the
 * path is returned — so "copy" always ends with the user holding the text, and
 * the caller is never told a copy happened when it did not.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { currentOS, whichCommand, type OS } from "./platform"

export interface ClipboardCommand {
  /** Executable and arguments. The text is piped to its standard input. */
  command: string[]
  /** Short name for notices: "clip", "pbcopy", "wl-copy". */
  label: string
}

interface Lookup {
  os?: OS
  find?: (name: string) => string | undefined
}

/**
 * How to put text on the clipboard on this platform, or undefined when nothing
 * is installed that can. `os` and the PATH lookup are injectable for tests.
 */
export function clipboardCommand(options: Lookup = {}): ClipboardCommand | undefined {
  const os = options.os ?? currentOS()
  const find = options.find ?? whichCommand

  if (os === "windows") {
    const clip = find("clip.exe") ?? find("clip")
    return clip ? { command: [clip], label: "clip" } : undefined
  }

  if (os === "macos") {
    const pbcopy = find("pbcopy") ?? "/usr/bin/pbcopy"
    return { command: [pbcopy], label: "pbcopy" }
  }

  const linux: Array<{ names: string[]; args: string[]; label: string }> = [
    { names: ["wl-copy"], args: [], label: "wl-copy" },
    { names: ["xclip"], args: ["-selection", "clipboard"], label: "xclip" },
    { names: ["xsel"], args: ["--clipboard", "--input"], label: "xsel" },
  ]
  for (const tool of linux) {
    const found = tool.names.map((name) => find(name)).find(Boolean)
    if (found) return { command: [found, ...tool.args], label: tool.label }
  }
  return undefined
}

export interface CopyResult {
  ok: boolean
  /** How it ended: a tool name, `file`, or `none`. */
  via: string
  /** Set when the text went to a file instead of the clipboard. */
  fallbackPath?: string
  /** Why the clipboard was not used, when it was not. */
  error?: string
}

export interface CopyOptions extends Lookup {
  /** Pipes `input` to the command and reports the exit status. */
  run?: (command: string[], input: string) => Promise<{ code: number; stderr: string }>
  /** Write the text here when no clipboard tool works. */
  fallbackDir?: string
  /** File-name stem for the fallback file. Defaults to "imurun-copy". */
  fallbackName?: string
}

async function runWithStdin(command: string[], input: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "pipe", windowsHide: true })
  proc.stdin.write(input)
  await proc.stdin.end()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, stderr }
}

/**
 * Copies `text` to the clipboard, falling back to a file when it cannot. Never
 * throws: a failure is reported in the result so the caller can tell the user
 * where the text actually went.
 */
export async function copyToClipboard(text: string, options: CopyOptions = {}): Promise<CopyResult> {
  const plan = clipboardCommand(options)
  const run = options.run ?? runWithStdin
  let error: string | undefined

  if (plan) {
    try {
      const { code, stderr } = await run(plan.command, text)
      if (code === 0) return { ok: true, via: plan.label }
      error = `${plan.label} exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
    } catch (cause) {
      error = `${plan.label} failed: ${(cause as Error).message}`
    }
  } else {
    error = "no clipboard tool is installed on this machine"
  }

  if (!options.fallbackDir) return { ok: false, via: "none", error }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = join(options.fallbackDir, `${options.fallbackName ?? "imurun-copy"}-${stamp}.txt`)
  try {
    await mkdir(options.fallbackDir, { recursive: true })
    await writeFile(path, text, "utf8")
    return { ok: false, via: "file", fallbackPath: path, error }
  } catch (cause) {
    return { ok: false, via: "none", error: `${error}; could not write a file either: ${(cause as Error).message}` }
  }
}

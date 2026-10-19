/**
 * shell — run a command through a real shell with a timeout and output caps.
 * Runs in the working directory unless a different one is given.
 *
 * The shell is POSIX wherever one exists (Git bash on Windows, `sh`/`$SHELL`
 * elsewhere), so `grep`, `sed`, `cat` and friends work the same on every
 * platform. Only a machine with no POSIX shell at all falls back to cmd, and
 * then the tool says so rather than letting the model guess.
 */
import { resolveShell } from "@imurun/util"
import type { ImurunTool } from "./types"
import { fail, ok, requireString, optionalNumber, optionalString } from "./types"
import { resolveToolPath } from "./read"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 100_000
const MAX_TIMEOUT_MS = 10 * 60_000

/** The shell commands run in, detected once per process. */
const SHELL = resolveShell()

const SHELL_NOTE = SHELL.posix
  ? "Commands run in " +
    SHELL.label +
    ", a POSIX shell: grep, sed, cat, head, tail, awk, find, pipes, && and $VAR all work as they do on Linux and macOS."
  : SHELL.label +
    " is the only shell on this machine, so use its own syntax; grep, sed and cat are not available unless installed."

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const head = text.slice(0, MAX_OUTPUT_CHARS / 2)
  const tail = text.slice(-MAX_OUTPUT_CHARS / 2)
  return `${head}\n…[output clipped: ${text.length - MAX_OUTPUT_CHARS} chars omitted]…\n${tail}`
}

/** The full argv for a command, e.g. ["bash", "-c", "ls"] . */
function shellArgv(command: string): string[] {
  return [SHELL.shell, ...SHELL.args, command]
}

export const shellTool: ImurunTool = {
  name: "shell",
  description:
    "Run a command through a real shell in the project directory and return stdout, stderr, and the exit code. " +
    SHELL_NOTE +
    " " +
    "Use it for builds, tests, git, package managers, and anything without a dedicated tool.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      workdir: { type: "string", description: "Directory to run in (default: project directory)." },
      timeoutMs: { type: "number", description: "Timeout in milliseconds (default 120000)." },
      background: {
        type: "boolean",
        description:
          "Start the command detached and return immediately instead of waiting for it. " +
          "Use for dev servers, watchers, and opening applications or URLs.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  title: (args) => `$ ${String(args.command ?? "").slice(0, 120)}`,
  async execute(args, ctx) {
    const command = requireString(args, "command")
    const workdirArg = optionalString(args, "workdir")
    const cwd = workdirArg ? resolveToolPath(ctx.workingDir, workdirArg) : ctx.workingDir
    const timeoutMs = Math.min(optionalNumber(args, "timeoutMs") ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const argv = shellArgv(command)

    // Detached: hand the command to the OS and return at once. Nothing is
    // captured, which is what makes it usable for servers and for opening apps.
    if (args.background === true) {
      try {
        const proc = Bun.spawn(argv, {
          cwd,
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: { ...process.env },
          windowsHide: true,
        })
        proc.unref()
        return ok(`Started in the background (pid ${proc.pid}); it keeps running after this call returns.`, {
          title: `$ ${command.slice(0, 80)} (background)`,
          data: { pid: proc.pid, background: true },
        })
      } catch (error) {
        return fail(`Failed to start the command: ${(error as Error).message}`)
      }
    }

    try {
      const proc = Bun.spawn(argv, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
        windowsHide: true,
      })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeoutMs)

      let onAbort: (() => void) | undefined
      if (ctx.signal) {
        onAbort = () => proc.kill()
        if (ctx.signal.aborted) proc.kill()
        else ctx.signal.addEventListener("abort", onAbort, { once: true })
      }

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      clearTimeout(timer)
      if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort)

      const sections: string[] = []
      if (stdout.trim()) sections.push(clip(stdout.trimEnd()))
      if (stderr.trim()) sections.push(`[stderr]\n${clip(stderr.trimEnd())}`)

      if (timedOut) {
        return fail(
          `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}\n${sections.join("\n")}`,
          undefined,
          { title: `${command.slice(0, 80)} (timeout)` },
        )
      }

      const body = sections.length > 0 ? sections.join("\n") : "(no output)"

      if (exitCode !== 0) {
        return fail(`Command exited with code ${exitCode}`, `${body}\n[exit code ${exitCode}]`, {
          title: `${command.slice(0, 80)} (exit ${exitCode})`,
          data: { exitCode, stdout, stderr },
        })
      }

      return ok(body, {
        title: `$ ${command.slice(0, 80)}`,
        data: { exitCode, stdout, stderr },
      })
    } catch (error) {
      return fail(`Failed to run command: ${(error as Error).message}`)
    }
  },
}

/**
 * shell — run a command through the platform shell with a timeout and output
 * caps. Runs in the working directory unless a different one is given.
 */
import { defaultShell } from "@imurun/util"
import type { ImurunTool } from "./types"
import { fail, ok, requireString, optionalNumber, optionalString } from "./types"
import { resolveToolPath } from "./read"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 100_000
const MAX_TIMEOUT_MS = 10 * 60_000

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const head = text.slice(0, MAX_OUTPUT_CHARS / 2)
  const tail = text.slice(-MAX_OUTPUT_CHARS / 2)
  return `${head}\n…[output clipped: ${text.length - MAX_OUTPUT_CHARS} chars omitted]…\n${tail}`
}

function shellInvocation(command: string): string[] {
  const { shell } = defaultShell()
  const lower = shell.toLowerCase()
  if (lower.includes("powershell") || lower.includes("pwsh")) {
    return [shell, "-NoProfile", "-Command", command]
  }
  if (process.platform === "win32") {
    return [shell, "/d", "/s", "/c", command]
  }
  return [shell, "-c", command]
}

export const shellTool: ImurunTool = {
  name: "shell",
  description:
    "Execute a shell command in the project directory and return stdout, stderr, and the exit code. " +
    "Use for builds, tests, git, package managers, and anything without a dedicated tool.",
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

    const { shell } = defaultShell()
    const finalArgs = shellInvocation(command).slice(1)

    // Detached: hand the command to the OS and return at once. Nothing is
    // captured, which is what makes it usable for servers and for opening apps.
    if (args.background === true) {
      try {
        const proc = Bun.spawn([shell, ...finalArgs], {
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
      const proc = Bun.spawn([shell, ...finalArgs], {
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

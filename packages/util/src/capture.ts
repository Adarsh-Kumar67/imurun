/**
 * Screen capture — the command that takes a screenshot on this machine, and
 * nothing else. The tool that calls it lives in `@imurun/core`; keeping the
 * platform split here means the differences are in one file, testable without a
 * screen.
 *
 * Each platform is asked in the order a user would reach for:
 *   Windows  PowerShell, through .NET's own screen-copy API (always present).
 *   macOS    `screencapture`, which ships with the OS.
 *   Linux    whichever of the common tools is installed — there is no single
 *            answer, so the first one found wins.
 */
import { join } from "node:path"
import { currentOS, whichCommand, type OS } from "./platform"

export interface CaptureCommand {
  /** Executable and arguments. The last argument is always the output path. */
  command: string[]
  /** Short name for notices: "screencapture", "PowerShell", "grim". */
  label: string
}

/** The PowerShell one-liner that copies the whole virtual desktop to a PNG. */
export function windowsCaptureScript(outputPath: string): string {
  // Single-quoted for PowerShell; a path containing ' is doubled, per PS rules.
  const quoted = `'${outputPath.replace(/'/g, "''")}'`
  return (
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; " +
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; " +
    "$g = [System.Drawing.Graphics]::FromImage($bmp); " +
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); " +
    `$bmp.Save(${quoted}, [System.Drawing.Imaging.ImageFormat]::Png); ` +
    "$g.Dispose(); $bmp.Dispose()"
  )
}

const LINUX_CAPTURE_TOOLS: Array<{ commands: string[]; args: string[]; label: string }> = [
  { commands: ["grim"], args: [], label: "grim" },
  { commands: ["scrot"], args: ["-o"], label: "scrot" },
  { commands: ["gnome-screenshot"], args: ["-f"], label: "gnome-screenshot" },
  { commands: ["spectacle"], args: ["-b", "-n", "-o"], label: "spectacle" },
  { commands: ["import"], args: ["-window", "root"], label: "ImageMagick import" },
]

/**
 * How to capture the screen into `outputPath` on this platform, or undefined
 * when no capture tool is available (a headless machine, a bare terminal).
 *
 * `os` and the lookup are injectable so the platform branches can be tested on
 * any machine.
 */
export function screenshotCommand(
  outputPath: string,
  options: { os?: OS; find?: (name: string) => string | undefined } = {},
): CaptureCommand | undefined {
  const os = options.os ?? currentOS()
  const find = options.find ?? whichCommand

  if (os === "windows") {
    const powershell = find("powershell.exe") ?? find("powershell") ?? find("pwsh.exe")
    if (!powershell) return undefined
    return {
      command: [powershell, "-NoProfile", "-NonInteractive", "-Command", windowsCaptureScript(outputPath)],
      label: "PowerShell",
    }
  }

  if (os === "macos") {
    const screencapture = find("screencapture") ?? "/usr/sbin/screencapture"
    return { command: [screencapture, "-x", outputPath], label: "screencapture" }
  }

  for (const tool of LINUX_CAPTURE_TOOLS) {
    const found = tool.commands.map((name) => find(name)).find(Boolean)
    if (found) return { command: [found, ...tool.args, outputPath], label: tool.label }
  }
  return undefined
}

/** Default place to put a capture: a temp file, never a surprise in the project. */
export function screenshotPath(directory: string, label = "screen"): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return join(directory, `${label}-${stamp}.png`)
}

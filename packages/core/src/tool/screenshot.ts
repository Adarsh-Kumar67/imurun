/**
 * screenshot — what is on this machine's screen, right now.
 *
 * The picture is captured with the platform's own tool (PowerShell on Windows,
 * `screencapture` on macOS, whichever of grim/scrot/gnome-screenshot/spectacle/
 * ImageMagick is installed on Linux), written to a file, and then handed to the
 * model — as an image when the model can see one, and as a description with a
 * path when it cannot.
 *
 * It never pretends: on a text-only model the model is told plainly that it
 * cannot look at the picture and that the user can open it at the path given, so
 * an agent asked to "check the screen" reports honestly instead of inventing what
 * was there.
 *
 * The platform call and the process it runs are injectable, so the behaviour can
 * be tested without a screen, a GUI session, or a real PowerShell launch.
 */
import { readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  openInSystem,
  describeImage,
  imageInfo,
  screenshotCommand,
  screenshotPath,
  type CaptureCommand,
} from "@imurun/util"
import type { ImurunTool } from "./types"
import { fail, ok, optionalBoolean, optionalString } from "./types"

/** Screenshots are large; refuse anything absurd rather than base64 a whole disk. */
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024

export interface ScreenshotDeps {
  /** How to capture on this machine; defaults to the platform's own tool. */
  capture?: (outputPath: string) => CaptureCommand | undefined
  /** Runs the capture command and reports what happened. */
  run?: (command: string[]) => Promise<{ code: number; stderr: string }>
  /** Opens a file in the system viewer. */
  open?: (path: string) => void
  /** Directory a default screenshot lands in. */
  tempDir?: () => string
}

async function runCapture(command: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(command, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, stderr }
}

/**
 * Builds the screenshot tool. The built-in instance is `screenshotTool`; tests
 * pass their own `capture`/`run` so they neither photograph the screen nor
 * depend on the machine having one.
 */
export function createScreenshotTool(deps: ScreenshotDeps = {}): ImurunTool {
  const capture = deps.capture ?? ((target: string) => screenshotCommand(target))
  const run = deps.run ?? runCapture
  const open = deps.open ?? openInSystem
  const tempDir = deps.tempDir ?? (() => tmpdir())

  return {
    name: "screenshot",
    description:
      "See what is on the screen right now by taking a screenshot. Use it when the user refers to " +
      "something visible — an error in a window, a UI that looks wrong, a game, a chart — rather " +
      "than asking them to describe it. If your model can see images you are shown the picture; " +
      "otherwise the screenshot is saved and you are told where it is.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Where to save the PNG. Defaults to a timestamped file in the system temp directory.",
        },
        open: {
          type: "boolean",
          description: "Also open the image in the system viewer, so the user can see what you looked at.",
        },
      },
      additionalProperties: false,
    },
    title: () => "screenshot",
    async execute(args, ctx) {
      const target = optionalString(args, "path")?.trim() || screenshotPath(tempDir())
      const plan = capture(target)

      if (!plan) {
        return fail(
          "No screen-capture tool is available on this machine. On Linux install one of grim, scrot, " +
            "gnome-screenshot, or ImageMagick (import).",
        )
      }

      try {
        const { code, stderr } = await run(plan.command)
        if (code !== 0) {
          return fail(`The screenshot command (${plan.label}) failed with exit code ${code}. ${stderr.trim()}`.trim())
        }

        const info = await stat(target).catch(() => undefined)
        if (!info?.isFile() || info.size === 0) {
          return fail(`The screenshot command (${plan.label}) produced no file at ${target}.`)
        }
        if (info.size > MAX_CAPTURE_BYTES) {
          return fail(`Screenshot is too large to hand to the model (${Math.round(info.size / 1024 / 1024)} MB).`)
        }

        const bytes = await readFile(target)
        const decoded = imageInfo(bytes) ?? { format: "png" as const, mime: "image/png", width: 0, height: 0 }
        const description =
          decoded.width > 0 ? describeImage(decoded, info.size) : `screenshot (${info.size} bytes)`

        if (optionalBoolean(args, "open")) open(target)

        if (ctx.vision) {
          return ok(`Screenshot captured: ${description}. It is attached — look at it before answering.`, {
            images: [{ mime: decoded.mime, data: bytes.toString("base64") }],
            data: { path: target, ...decoded },
            title: `screenshot (${description})`,
          })
        }

        return ok(
          `Screenshot saved to ${target} (${description}).\n` +
            `This model cannot see images, so you have not been shown it. Tell the user where the file is ` +
            `and ask what it shows, or offer to open it for them — do not guess at the contents.`,
          { data: { path: target, ...decoded }, title: `screenshot (saved, model has no vision)` },
        )
      } catch (error) {
        return fail(`Could not take a screenshot: ${(error as Error).message}`)
      }
    },
  }
}

/** The tool as the agent uses it, with the real screen capture wired in. */
export const screenshotTool: ImurunTool = createScreenshotTool()

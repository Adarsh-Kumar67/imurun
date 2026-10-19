import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { screenshotCommand, screenshotPath, windowsCaptureScript } from "../src/capture"

/** A PATH lookup with only the tools this test pretends to have installed. */
function finder(installed: string[]) {
  return (name: string) => (installed.includes(name) ? `/bin/${name}` : undefined)
}

describe("screenshotCommand on Windows", () => {
  test("uses PowerShell to copy the screen through .NET", () => {
    const plan = screenshotCommand("out.png", { os: "windows", find: finder(["powershell.exe"]) })
    expect(plan?.label).toBe("PowerShell")
    expect(plan?.command[0]).toBe("/bin/powershell.exe")
    expect(plan?.command).toContain("-NoProfile")
    const script = plan?.command[plan.command.length - 1] ?? ""
    expect(script).toContain("CopyFromScreen")
    expect(script).toContain("System.Drawing.Imaging.ImageFormat]::Png")
    expect(script).toContain("'out.png'")
  })

  test("falls back to pwsh, and gives up when neither exists", () => {
    expect(screenshotCommand("out.png", { os: "windows", find: finder(["pwsh.exe"]) })?.command[0]).toBe(
      "/bin/pwsh.exe",
    )
    expect(screenshotCommand("out.png", { os: "windows", find: () => undefined })).toBeUndefined()
  })

  test("a path with a quote in it stays one argument", () => {
    const script = windowsCaptureScript("C:\\my shots\\it's here.png")
    expect(script).toContain("'C:\\my shots\\it''s here.png'")
  })
})

describe("screenshotCommand on macOS", () => {
  test("uses the screencapture that ships with the OS", () => {
    const plan = screenshotCommand("out.png", { os: "macos", find: finder(["screencapture"]) })
    expect(plan).toEqual({ command: ["/bin/screencapture", "-x", "out.png"], label: "screencapture" })
  })

  test("knows the absolute path when PATH does not", () => {
    const plan = screenshotCommand("out.png", { os: "macos", find: () => undefined })
    expect(plan?.command[0]).toBe("/usr/sbin/screencapture")
  })
})

describe("screenshotCommand on Linux", () => {
  test("prefers grim, then scrot, then the others", () => {
    expect(screenshotCommand("o.png", { os: "linux", find: finder(["grim"]) })?.command).toEqual(["/bin/grim", "o.png"])
    expect(screenshotCommand("o.png", { os: "linux", find: finder(["scrot"]) })?.command).toEqual([
      "/bin/scrot",
      "-o",
      "o.png",
    ])
    expect(screenshotCommand("o.png", { os: "linux", find: finder(["gnome-screenshot"]) })?.command).toEqual([
      "/bin/gnome-screenshot",
      "-f",
      "o.png",
    ])
    expect(screenshotCommand("o.png", { os: "linux", find: finder(["spectacle"]) })?.command).toEqual([
      "/bin/spectacle",
      "-b",
      "-n",
      "-o",
      "o.png",
    ])
    expect(screenshotCommand("o.png", { os: "linux", find: finder(["import"]) })?.command).toEqual([
      "/bin/import",
      "-window",
      "root",
      "o.png",
    ])
  })

  test("says so when nothing is installed", () => {
    expect(screenshotCommand("o.png", { os: "linux", find: () => undefined })).toBeUndefined()
  })
})

describe("screenshotPath", () => {
  test("lands in the given directory with a timestamped name", () => {
    const directory = join("/tmp", "imurun")
    const path = screenshotPath(directory, "shot")
    expect(path.startsWith(directory)).toBe(true)
    expect(path.endsWith(".png")).toBe(true)
    expect(path).toContain("shot-")
    // Colons and dots are not valid in a filename on Windows.
    expect(path.slice(path.lastIndexOf("shot-"))).not.toContain(":")
  })
})

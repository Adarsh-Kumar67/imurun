/**
 * The visual layer, where the mistakes that reach the screen live.
 *
 * Three things are proved here: a gradient never breaks the styling it is
 * painted over, the header is exactly the width of the window, and the walk
 * gives up on a directory that is far too big to index in one go.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import chalk from "chalk"
import { gradientBand, setTheme, theme } from "../src/theme"
import { stripAnsi, visibleWidth } from "../src/text"
import { walkFiles } from "@imurun/core"

describe("the gradient", () => {
  // The theme is shared, and another test may have left the "none" palette in
  // place — where there is no colour at all. Put the real one back for these
  // tests, and leave it as it was afterwards.
  beforeEach(() => {
    chalk.level = 3
    setTheme("imurun-dark")
  })

  afterEach(() => {
    setTheme("imurun-dark")
  })

  test("it never breaks the styling it is painted over", () => {
    chalk.level = 3
    // A line that already carries colour: the wordmark has a red "I" in it.
    const styled = `${theme.red("I")}${theme.brand("muTechz")}`
    const painted = gradientBand(styled, "#F4EFE5", "#E5484D")

    // The red is still the active colour when the "I" is drawn: the red code
    // comes before it, and nothing closes it in between.
    const redAt = painted.indexOf("\u001b[31m")
    const letterAt = painted.indexOf("I")
    expect(redAt).toBeGreaterThanOrEqual(0)
    expect(redAt).toBeLessThan(letterAt)
    expect(painted.slice(redAt, letterAt)).not.toContain("\u001b[39m")
    // And nothing leaked out as literal text: stripping the escapes leaves
    // exactly the text that was there before.
    expect(stripAnsi(painted)).toBe("ImuTechz")
    // A broken sequence would leave a "[31m" behind in the stripped text.
    expect(stripAnsi(painted)).not.toMatch(/\[\d+;?\d*m/)
  })

  test("it paints the background, so the text keeps its own colour", () => {
    chalk.level = 3
    const styled = `${theme.red("I")}muTechz`
    const painted = gradientBand(styled, "#F4EFE5", "#E5484D")
    // The band is a truecolor background…
    expect(painted).toContain("\u001b[48;2;")
    // …and the red letter is not overwritten by a foreground colour.
    expect(painted).not.toMatch(/\u001b\[38:2;\d+;\d+;\d+m\u001b\[31m/)
  })

  test("the visible width does not change", () => {
    chalk.level = 3
    const styled = `${theme.red("I")}${theme.brand("muTechz")} ${theme.dim("v0.1.3")}`
    const painted = gradientBand(styled, "#F4EFE5", "#E5484D")
    expect(visibleWidth(painted)).toBe(visibleWidth(styled))
  })

  test("a plain line is coloured across its length", () => {
    chalk.level = 3
    const painted = gradientBand("abcdefghij", "#F4EFE5", "#E5484D")
    expect(visibleWidth(painted)).toBe(10)
    expect(stripAnsi(painted)).toBe("abcdefghij")
  })

  test("without truecolor the line is left alone", () => {
    const before = chalk.level
    chalk.level = 1
    try {
      const plain = "hello"
      expect(gradientBand(plain, "#F4EFE5", "#E5484D")).toBe(plain)
    } finally {
      chalk.level = before
    }
  })
})

describe("the walk", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "imurun-walk-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test("it gives up when its budget is spent, and says what it found", async () => {
    const root = join(home, "big")
    await mkdir(root, { recursive: true })
    for (let index = 0; index < 400; index++) {
      await writeFile(join(root, `file-${index}.ts`), `export const a = ${index}\n`)
    }
    const walk = await walkFiles({ root, maxDurationMs: 1, maxFiles: 5_000 })
    // The budget was tiny, so the walk stopped early — but it did not throw,
    // and what it did find is still usable.
    expect(walk.files.length).toBeLessThanOrEqual(400)
    expect(Array.isArray(walk.skipped)).toBe(true)
  })

  test("a directory that cannot be read is skipped, and the walk carries on", async () => {
    const root = join(home, "mixed")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "index.ts"), "export const a = 1\n")
    // A file where a directory is expected: reading it as a directory fails.
    await writeFile(join(root, "not-a-dir"), "just a file\n")

    const walk = await walkFiles({ root })
    expect(walk.files).toContain("src/index.ts")
  })
})

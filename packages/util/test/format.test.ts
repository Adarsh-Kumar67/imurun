import { describe, expect, test } from "bun:test"
import {
  formatBytes,
  formatCompact,
  formatCount,
  formatDuration,
  formatPercent,
  formatProgressBar,
  formatSpeed,
  truncate,
  truncateMiddle,
} from "../src/format"

describe("formatBytes", () => {
  test("scales units", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(6_300_000_000)).toBe("5.9 GB")
  })

  test("handles invalid input", () => {
    expect(formatBytes(-5)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
  })
})

describe("formatDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(80_000)).toBe("1m 20s")
    expect(formatDuration(3_600_000)).toBe("1h")
    expect(formatDuration(5_400_000)).toBe("1h 30m")
  })
})

describe("formatProgressBar", () => {
  test("fills proportionally", () => {
    const bar = formatProgressBar(50, 100, 10)
    expect(bar).toContain("50.0%")
    expect(bar).toContain("\u2588")
    expect(bar).toContain("\u2591")
  })

  test("clamps overflow", () => {
    expect(formatProgressBar(200, 100, 10)).toContain("100.0%")
  })
})

describe("misc formatters", () => {
  test("speed", () => {
    expect(formatSpeed(13_631_488)).toBe("13.0 MB/s")
  })

  test("percent and count", () => {
    expect(formatPercent(1, 4)).toBe("25.0%")
    expect(formatCount(1234567)).toBe("1,234,567")
    expect(formatCompact(12_800)).toBe("12.8k")
  })

  test("truncate", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcd\u2026")
    expect(truncate("abc", 10)).toBe("abc")
    expect(truncateMiddle("C:\\very\\long\\path\\file.ts", 14)).toContain("\u2026")
  })
})

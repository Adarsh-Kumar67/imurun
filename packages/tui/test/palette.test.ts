import { describe, expect, test } from "bun:test"
import { Palette } from "../src/palette"

const items = [
  { id: "model", label: "/model", detail: "switch the model" },
  { id: "models", label: "/models", detail: "list installed models" },
  { id: "agent", label: "/agent", detail: "switch the agent" },
  { id: "install", label: "/install", detail: "download a model" },
]

describe("Palette", () => {
  test("filters by prefix, ranking label matches first", () => {
    const palette = new Palette(items, { maxRows: 4 })
    palette.setQuery("mod")
    expect(palette.items.slice(0, 2).map((i) => i.id)).toEqual(["model", "models"])
  })

  test("searches details and keywords too", () => {
    const palette = new Palette(items, { maxRows: 4 })
    palette.setQuery("install")
    expect(palette.items[0]!.id).toBe("install")
  })

  test("wrap-around navigation", () => {
    const palette = new Palette(items, { maxRows: 4 })
    palette.move(-1)
    expect(palette.selected()?.id).toBe("install")
    palette.move(1)
    expect(palette.selected()?.id).toBe("model")
  })

  test("keeps the selection inside a scrolling window", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, label: `item ${i}` }))
    const palette = new Palette(many, { maxRows: 5 })
    palette.move(10)
    const window = palette.window()
    expect(window.items).toHaveLength(5)
    expect(window.offset).toBeGreaterThan(0)
    expect(window.items[palette.index - window.offset]?.id).toBe("i10")
  })

  test("resets the cursor when the query changes", () => {
    const palette = new Palette(items, { maxRows: 4 })
    palette.move(2)
    palette.setQuery("a")
    expect(palette.index).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import { KeyParser } from "../src/keys"

describe("KeyParser", () => {
  test("decodes arrow keys, shift+tab and page keys", () => {
    const parser = new KeyParser()
    expect(parser.push("\u001b[A\u001b[B\u001b[C\u001b[D")).toEqual([
      { name: "up" },
      { name: "down" },
      { name: "right" },
      { name: "left" },
    ])
    expect(parser.push("\u001b[Z")).toEqual([{ name: "shift-tab" }])
    expect(parser.push("\u001b[5~\u001b[6~")).toEqual([{ name: "pageup" }, { name: "pagedown" }])
    expect(parser.push("\u001b[1~\u001b[4~")).toEqual([{ name: "home" }, { name: "end" }])
  })

  test("maps control bytes to ctrl+letter", () => {
    const parser = new KeyParser()
    expect(parser.push("\u0003")).toEqual([{ ctrl: true, input: "c" }])
    expect(parser.push("\u0015")).toEqual([{ ctrl: true, input: "u" }])
  })

  test("treats enter, tab and backspace as named keys", () => {
    const parser = new KeyParser()
    expect(parser.push("\r")).toEqual([{ name: "enter" }])
    expect(parser.push("\n")).toEqual([{ name: "enter" }])
    expect(parser.push("\t")).toEqual([{ name: "tab" }])
    expect(parser.push("\u007f")).toEqual([{ name: "backspace" }])
  })

  test("groups printable runs so pasted text survives intact", () => {
    const parser = new KeyParser()
    expect(parser.push("/model qwen")).toEqual([
      { input: "/model" },
      { name: "space", input: " " },
      { input: "qwen" },
    ])
  })

  test("a lone escape is held back, then reported as the escape key", () => {
    const parser = new KeyParser()
    // A lone ESC might be the start of a sequence that has not arrived yet,
    // so it waits — and is then given up on.
    expect(parser.push("\u001b")).toEqual([])
    expect(parser.hasPending).toBe(true)
    expect(parser.flushPending()).toEqual([{ name: "escape" }])
    expect(parser.hasPending).toBe(false)
  })

  test("a mouse report split across two reads is not typed into the prompt", () => {
    const parser = new KeyParser()
    // The first half of the sequence: nothing may be treated as text.
    expect(parser.push("\u001b[<0;12;")).toEqual([])
    expect(parser.hasPending).toBe(true)
    // The rest arrives: now it is a click, not a line of gibberish.
    const events = parser.push("7M")
    expect(events).toEqual([
      { mouse: { kind: "press", x: 12, y: 7, shift: false, alt: false, ctrl: false } },
    ])
  })

  test("a cursor key split across two reads still works", () => {
    const parser = new KeyParser()
    expect(parser.push("\u001b[")).toEqual([])
    expect(parser.push("A")).toEqual([{ name: "up" }])
  })

  test("a bracketed paste arrives as one block of text", () => {
    const parser = new KeyParser()
    const events = parser.push("\u001b[200~hello\nworld\u001b[201~")
    expect(events).toEqual([{ paste: "hello\nworld" }])
  })

  test("a paste split across two reads is still one paste", () => {
    const parser = new KeyParser()
    expect(parser.push("\u001b[200~hello\nwor")).toEqual([])
    expect(parser.hasPending).toBe(true)
    expect(parser.push("ld\u001b[201~")).toEqual([{ paste: "hello\nworld" }])
  })

  test("a paste is never a stream of keystrokes: the newline does not send", () => {
    const parser = new KeyParser()
    const events = parser.push("\u001b[200~line one\nline two\nline three\u001b[201~")
    // One event, not one per line: a pasted file must not send the message.
    expect(events).toHaveLength(1)
    expect(events[0]!.paste).toBe("line one\nline two\nline three")
    expect(events.some((event) => event.name === "enter")).toBe(false)
  })

  test("an unbracketed multi-line paste is still recognised", () => {
    const parser = new KeyParser()
    // A terminal that does not do bracketed paste sends the raw text.
    const events = parser.push("line one\nline two")
    expect(events).toEqual([{ paste: "line one\nline two" }])
  })

  test("a typed newline on its own is still the enter key", () => {
    const parser = new KeyParser()
    expect(parser.push("\r")).toEqual([{ name: "enter" }])
    expect(parser.push("text\r")).toEqual([{ input: "text" }, { name: "enter" }])
  })

  test("decodes an SGR mouse press with its coordinates", () => {
    const parser = new KeyParser()
    // button 0 (left), column 12, row 7, pressed
    expect(parser.push("\u001b[<0;12;7M")).toEqual([{ mouse: { kind: "press", x: 12, y: 7, shift: false, alt: false, ctrl: false } }])
  })

  test("decodes release, wheel and modifiers", () => {
    const parser = new KeyParser()
    expect(parser.push("\u001b[<0;3;4m")[0]!.mouse!.kind).toBe("release")
    expect(parser.push("\u001b[<64;1;1M")[0]!.mouse!.kind).toBe("wheel-up")
    expect(parser.push("\u001b[<65;1;1M")[0]!.mouse!.kind).toBe("wheel-down")
    const ctrlClick = parser.push("\u001b[<16;2;2M")[0]!.mouse!
    expect(ctrlClick.kind).toBe("press")
    expect(ctrlClick.ctrl).toBe(true)
  })

  test("a mouse event does not swallow the keys around it", () => {
    const parser = new KeyParser()
    const events = parser.push("a\u001b[<0;5;5Mb")
    expect(events[0]).toEqual({ input: "a" })
    expect(events[1]!.mouse?.x).toBe(5)
    expect(events[2]).toEqual({ input: "b" })
  })
})

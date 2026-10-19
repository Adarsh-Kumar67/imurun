import { describe, expect, test } from "bun:test"
import { describeImage, imageInfo, isImagePath, IMAGE_EXTENSIONS } from "../src/image"

/** 1024×768 PNG: signature, IHDR length, "IHDR", width, height. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

/** GIF89a with a logical screen descriptor. */
function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return bytes
}

/** 24-bit BMP header: "BM", sizes, then width/height in the DIB header. */
function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26)
  bytes.set([0x42, 0x4d])
  const view = new DataView(bytes.buffer)
  view.setUint32(18, width, true)
  view.setUint32(22, height, true)
  return bytes
}

/** A JPEG: SOI, then a start-of-frame marker carrying height then width. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20)
  bytes.set([0xff, 0xd8])
  bytes.set([0xff, 0xc0], 2)
  bytes.set([0x00, 0x11], 4)
  bytes[6] = 8 // precision
  const view = new DataView(bytes.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

/** A WebP in the simple VP8X (extended) form, where the size is 24-bit LE. */
function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46]) // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >> 8) & 0xff
  bytes[26] = (w >> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >> 8) & 0xff
  bytes[29] = (h >> 16) & 0xff
  return bytes
}

describe("imageInfo", () => {
  test("reads a PNG's real dimensions", () => {
    expect(imageInfo(png(1024, 768))).toEqual({ format: "png", mime: "image/png", width: 1024, height: 768 })
  })

  test("reads a GIF's real dimensions", () => {
    expect(imageInfo(gif(320, 200))).toEqual({ format: "gif", mime: "image/gif", width: 320, height: 200 })
  })

  test("reads a BMP's real dimensions", () => {
    expect(imageInfo(bmp(640, 480))).toEqual({ format: "bmp", mime: "image/bmp", width: 640, height: 480 })
  })

  test("reads a JPEG by walking to its start-of-frame", () => {
    expect(imageInfo(jpeg(1920, 1080))).toEqual({ format: "jpeg", mime: "image/jpeg", width: 1920, height: 1080 })
  })

  test("reads a WebP through its VP8X chunk", () => {
    expect(imageInfo(webp(800, 600))).toEqual({ format: "webp", mime: "image/webp", width: 800, height: 600 })
  })

  test("says nothing about bytes that are not an image", () => {
    expect(imageInfo(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toBeUndefined()
    expect(imageInfo(new TextEncoder().encode("hello world, definitely not a picture"))).toBeUndefined()
  })

  test("a truncated header is unknown rather than wrong", () => {
    expect(imageInfo(png(1024, 768).subarray(0, 12))).toBeUndefined()
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined()
  })
})

describe("isImagePath", () => {
  test("recognises the extensions it advertises", () => {
    for (const extension of IMAGE_EXTENSIONS) {
      expect(isImagePath(`shots/screen${extension}`)).toBe(true)
    }
    expect(isImagePath("SHOTS/SCREEN.PNG")).toBe(true)
  })

  test("leaves source files alone", () => {
    expect(isImagePath("src/index.ts")).toBe(false)
    expect(isImagePath("README.md")).toBe(false)
    expect(isImagePath("noextension")).toBe(false)
  })
})

describe("describeImage", () => {
  test("names the size, format and byte count", () => {
    const info = { format: "png" as const, mime: "image/png", width: 1024, height: 768 }
    expect(describeImage(info)).toBe("1024\u00d7768 PNG")
    expect(describeImage(info, 2048)).toBe("1024\u00d7768 PNG, 2.0 KB")
  })
})

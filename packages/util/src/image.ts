/**
 * Image headers — the format and pixel size of an image, read from its first
 * bytes without decoding a single pixel.
 *
 * IMURUN passes images through as bytes for a vision model to look at; the one
 * thing it needs to say in words is *what* the picture is. Reading the header
 * keeps that honest (a 1024×768 PNG is not "some bytes") and costs nothing: no
 * image library, no network, no native module.
 */
import { formatBytes } from "./format"

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp"

export interface ImageInfo {
  format: ImageFormat
  mime: string
  width: number
  height: number
}

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
}

/** Extensions treated as images before the bytes are even looked at. */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] as const

/** True when a path names an image, by extension. */
export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ""
  for (let i = offset; i < offset + length; i++) out += String.fromCharCode(bytes[i] ?? 0)
  return out
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
  )
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  )
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

/** Walks a JPEG's markers to its start-of-frame, which carries the size. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xff || marker === 0x00) {
      offset++
      continue
    }
    const length = u16be(bytes, offset + 2)
    if (length < 2) return undefined
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isStartOfFrame) {
      return { width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) }
    }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    offset += 2 + length
  }
  return undefined
}

/**
 * Reads an image's format and size from its header. Returns undefined when the
 * bytes are not an image IMURUN recognises, or are too truncated to tell.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  // PNG: signature, then IHDR width/height.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
    return { format: "png", mime: MIME.png, width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }

  // JPEG: SOI, then scan for the start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const size = jpegSize(bytes)
    if (size) return { format: "jpeg", mime: MIME.jpeg, ...size }
    return undefined
  }

  // GIF: logical screen descriptor.
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === "GIF") {
    return { format: "gif", mime: MIME.gif, width: u16le(bytes, 6), height: u16le(bytes, 8) }
  }

  // BMP: DIB header at offset 18 (height may be negative for a top-down bitmap).
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === "BM") {
    const height = u32le(bytes, 22)
    return { format: "bmp", mime: MIME.bmp, width: u32le(bytes, 18), height: height > 0x7fffffff ? 0x100000000 - height : height }
  }

  // WebP: RIFF container, then a VP8/VP8L/VP8X chunk that carries the size.
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4)
    if (kind === "VP8X") {
      return { format: "webp", mime: MIME.webp, width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) }
    }
    if (kind === "VP8L") {
      const bits = u32le(bytes, 21)
      return { format: "webp", mime: MIME.webp, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (kind === "VP8 ") {
      return {
        format: "webp",
        mime: MIME.webp,
        width: u16le(bytes, 26) & 0x3fff,
        height: u16le(bytes, 28) & 0x3fff,
      }
    }
  }

  return undefined
}

/** `"1024×768 PNG"` — the one-line description used in tool output. */
export function describeImage(info: ImageInfo, bytes?: number): string {
  const size = bytes && bytes > 0 ? `, ${formatBytes(bytes)}` : ""
  return `${info.width}\u00d7${info.height} ${info.format.toUpperCase()}${size}`
}

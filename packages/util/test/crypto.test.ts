import { describe, expect, test } from "bun:test"
import {
  constantTimeEqual,
  decodeKey,
  decrypt,
  encodeKey,
  encrypt,
  generateKey,
  maskSecret,
  parsePayload,
  serializePayload,
} from "../src/crypto"
import { sha256, shortHash } from "../src/hash"

describe("vault crypto", () => {
  test("encrypt/decrypt round trip", () => {
    const key = generateKey()
    const secret = "ghp_supersecrettoken123"
    const payload = encrypt(secret, key)
    expect(payload.v).toBe(1)
    expect(decrypt(payload, key)).toBe(secret)
  })

  test("wrong key fails authentication", () => {
    const payload = encrypt("hello", generateKey())
    expect(() => decrypt(payload, generateKey())).toThrow()
  })

  test("tampered data fails", () => {
    const key = generateKey()
    const payload = encrypt("hello", key)
    const tampered = { ...payload, data: Buffer.from("evil").toString("base64") }
    expect(() => decrypt(tampered, key)).toThrow()
  })

  test("key encoding round trips and validates", () => {
    const key = generateKey()
    const decoded = decodeKey(encodeKey(key))
    expect(decoded.equals(key)).toBe(true)
    expect(() => decodeKey("dG9vc2hvcnQ=")).toThrow()
  })

  test("payload serialization round trip", () => {
    const key = generateKey()
    const payload = encrypt("secret", key)
    const restored = parsePayload(serializePayload(payload))
    expect(decrypt(restored, key)).toBe("secret")
    expect(() => parsePayload('{"v":2}')).toThrow()
  })

  test("constant-time equality", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true)
    expect(constantTimeEqual("abc", "abd")).toBe(false)
    expect(constantTimeEqual("abc", "abcd")).toBe(false)
  })

  test("secret masking", () => {
    expect(maskSecret("ghp_1234567890abc")).toBe("ghp_\u2026abc")
    expect(maskSecret("short")).toBe("\u2026")
  })
})

describe("hashing", () => {
  test("sha256 is stable and well-formed", () => {
    const a = sha256("hello")
    const b = sha256("hello")
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
    expect(a).not.toBe(sha256("hello!"))
  })

  test("shortHash length", () => {
    expect(shortHash("x", 8)).toHaveLength(8)
  })
})

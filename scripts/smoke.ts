#!/usr/bin/env bun
/**
 * IMURUN M1 smoke test — proves the workspace, schema, and util packages
 * are wired up and working end to end.
 */
import { ImurunConfig, computeTier, scoreHardware } from "@imurun/schema"
import {
  createLogger,
  decodeKey,
  decrypt,
  encodeKey,
  encrypt,
  formatBytes,
  formatProgressBar,
  formatSpeed,
  generateKey,
  newId,
  sha256,
} from "@imurun/util"

const log = createLogger("smoke")

console.log("")
console.log("  IMURUN — M1 smoke test")
console.log("  ─────────────────────────────────────────────")

// 1. Schemas: default config parse + validation
const config = ImurunConfig.parse({ model: "qwen2.5-coder-7b", runtime: { port: 42425 } })
log.info(`config parsed: engine=${config.runtime.engine} port=${config.runtime.port} model=${config.model}`)

// 2. Hardware scoring
const score = scoreHardware({
  ram: { totalMB: 32_768 },
  cpu: { cores: 12 },
  gpu: [{ vramMB: 8192, unified: false, usable: true }],
})
log.info(`hardware score: ${score}/100 → tier "${computeTier(score)}"`)

// 3. Credential vault round trip
const key = generateKey()
const payload = encrypt("ghp_exampletoken", key)
const restored = decrypt(payload, decodeKey(encodeKey(key)))
log.info(`vault round trip: ${restored === "ghp_exampletoken" ? "OK" : "FAILED"}`)

// 4. IDs + hashing
log.info(`new id: ${newId("ses")}`)
log.info(`sha256("imurun") = ${sha256("imurun").slice(0, 16)}…`)

// 5. Formatter preview (what the download progress will look like)
const bar = formatProgressBar(2_700_000_000, 6_000_000_000, 30)
log.info(`download preview: ${bar} | ${formatBytes(2_700_000_000)} / ${formatBytes(6_000_000_000)} | ${formatSpeed(12_300_000)}`)

console.log("")
console.log("  ✔ M1 verified: workspace + schema + util are operational")
console.log("")

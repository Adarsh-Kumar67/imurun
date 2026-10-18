#!/usr/bin/env bun
/**
 * IMURUN dev runner — launches the CLI in development mode with whatever
 * arguments the developer passes through.
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const cliEntry = resolve(root, "packages/cli/src/index.ts")

if (!existsSync(cliEntry)) {
  console.error("IMURUN CLI entry not found at:")
  console.error("  " + cliEntry)
  console.error("This arrives with Milestone 3 (CLI package). Nothing to run yet.")
  process.exit(1)
}

const proc = Bun.spawn([process.execPath, "run", cliEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, IMURUN_DEV: "1" },
})

process.exit(await proc.exited)

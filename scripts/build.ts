#!/usr/bin/env bun
/**
 * IMURUN build orchestrator — builds every workspace package that defines a
 * `build` script, in workspace order.
 */
import { Glob } from "bun"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const glob = new Glob("packages/*/package.json")
let built = 0

const packages: Array<{ name: string; dir: string }> = []

for await (const file of glob.scan({ cwd: root })) {
  const dir = resolve(root, file, "..")
  const pkg = await Bun.file(resolve(root, file)).json()
  if (!pkg.scripts?.build) continue
  packages.push({ name: pkg.name ?? file, dir })
}

packages.sort((a, b) => a.name.localeCompare(b.name))

for (const pkg of packages) {
  console.log(`\n▶ building ${pkg.name}`)
  const proc = Bun.spawn([process.execPath, "run", "build"], {
    cwd: pkg.dir,
    stdio: ["inherit", "inherit", "inherit"],
  })
  const code = await proc.exited
  if (code !== 0) {
    console.error(`\n✖ ${pkg.name} failed with exit code ${code}`)
    process.exit(code)
  }
  built++
}

console.log(`\n✔ built ${built} package(s)`)

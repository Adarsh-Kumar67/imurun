/**
 * Context diagnostic — for every installed model, shows the window read from the
 * GGUF header and the exact `--ctx-size` (and YaRN flags) the runtime would pass
 * when it starts. This is the tool to reach for when a model refuses a request
 * for being too long: it proves what window the engine will actually load.
 *
 *   bun run scripts/diag-context.ts
 */
import { listInstalled } from "../packages/modelmgr/src/install/store"
import { buildLlamaServerArgs, planLlamaContext } from "../packages/runtime/src/engines/llama-cpp"

const installed = await listInstalled()
if (installed.length === 0) {
  console.log("  no models installed yet")
  process.exit(0)
}

console.log("")
for (const entry of installed) {
  const native = entry.contextLength
  const plan = planLlamaContext({ nativeContextSize: native })
  const args = buildLlamaServerArgs({ modelPath: entry.path, port: 1, nativeContextSize: native }, { threads: 1 })
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }

  console.log(`  ${entry.id}`)
  console.log(`    gguf window    ${native ? `${native} tokens` : "unknown"}`)
  console.log(`    ctx-size       ${plan.contextSize} tokens`)
  console.log(`    server arg     --ctx-size ${value("--ctx-size") ?? "(omitted!)"}`)
  if (plan.ropeScaling === "yarn") {
    console.log(`    yarn           --rope-scaling yarn --rope-scale ${value("--rope-scale")} --yarn-orig-ctx ${value("--yarn-orig-ctx")}`)
  } else {
    console.log(`    yarn           not needed (window is within the trained window)`)
  }
  console.log("")
}

console.log("  A model that reports no window still gets an explicit --ctx-size; the")
console.log("  runtime then reads the real one back from the engine's /props endpoint.")
console.log("")

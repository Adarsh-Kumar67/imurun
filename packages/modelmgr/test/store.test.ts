import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { InstalledModel } from "@imurun/schema"
import {
  addInstalled,
  getInstalled,
  installedBytes,
  installedRegistryPath,
  listInstalled,
  prunePartialDownloads,
  removeAllInstalled,
  removeInstalled,
  updateInstalled,
} from "../src"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "imurun-store-"))
  process.env.IMURUN_HOME = home
})

async function fakeModel(modelId: string, quant: InstalledModel["quant"] = "Q4_K_M"): Promise<InstalledModel> {
  const path = join(home, "models", "gguf", `${modelId}-${quant}.gguf`)
  await Bun.write(path, new Uint8Array(64))
  return {
    id: `${modelId}-${quant}`,
    modelId,
    quant,
    path,
    sizeBytes: 64,
    installedAt: Date.now(),
  }
}

describe("installed-model store", () => {
  test("adds, lists and fetches models", async () => {
    const a = await fakeModel("qwen2.5-coder-7b")
    const b = await fakeModel("qwen3-4b")
    await addInstalled(a)
    await addInstalled(b)

    const all = await listInstalled()
    expect(all.map((m) => m.modelId).sort()).toEqual(["qwen2.5-coder-7b", "qwen3-4b"])
    expect((await getInstalled("qwen3-4b"))?.quant).toBe("Q4_K_M")
    expect(await installedBytes()).toBe(128)
  })

  test("re-installing the same model+quant replaces the entry", async () => {
    await addInstalled(await fakeModel("qwen3-4b"))
    const again = await fakeModel("qwen3-4b")
    again.sizeBytes = 128
    await addInstalled(again)
    const all = await listInstalled()
    expect(all).toHaveLength(1)
    expect(all[0]!.sizeBytes).toBe(128)
  })

  test("update patches optional fields", async () => {
    await addInstalled(await fakeModel("qwen3-4b"))
    await updateInstalled("qwen3-4b", { measuredSpeed: 33.3, lastUsedAt: 12345 })
    const entry = await getInstalled("qwen3-4b")
    expect(entry?.measuredSpeed).toBe(33.3)
    expect(entry?.lastUsedAt).toBe(12345)
  })

  test("remove deletes the entry and the GGUF file", async () => {
    const entry = await fakeModel("qwen3-4b")
    await addInstalled(entry)
    await removeInstalled("qwen3-4b")
    expect(await listInstalled()).toHaveLength(0)
    expect(await Bun.file(entry.path).exists()).toBe(false)
  })

  test("list heals entries whose files disappeared", async () => {
    const entry = await fakeModel("qwen3-4b")
    await addInstalled(entry)
    await removeInstalled("qwen3-4b", false) // remove registry entry only
    // put it back manually to simulate an externally deleted file
    const raw = JSON.parse(await Bun.file(installedRegistryPath()).text() || "{}")
    expect(raw).toBeDefined()

    await addInstalled(entry)
    await Bun.file(entry.path).delete()
    expect(await listInstalled()).toHaveLength(0)
  })

  test("remove matches by id, model id, or model-quant", async () => {
    await addInstalled(await fakeModel("qwen3-4b", "Q5_K_M"))
    expect(await removeInstalled("qwen3-4b-Q5_K_M")).toBeDefined()
    expect(await listInstalled()).toHaveLength(0)

    await addInstalled(await fakeModel("qwen3-4b", "Q5_K_M"))
    expect(await removeInstalled("qwen3-4b")).toBeDefined()
    expect(await listInstalled()).toHaveLength(0)
  })

  test("remove can unregister without deleting the file", async () => {
    const entry = await fakeModel("qwen3-4b")
    await addInstalled(entry)
    await removeInstalled("qwen3-4b", false)
    expect(await listInstalled()).toHaveLength(0)
    expect(await Bun.file(entry.path).exists()).toBe(true)
  })

  test("removeAllInstalled reports the count and frees the files", async () => {
    const a = await fakeModel("qwen3-4b")
    const b = await fakeModel("qwen3-8b")
    await addInstalled(a)
    await addInstalled(b)

    const result = await removeAllInstalled(true)
    expect(result.count).toBe(2)
    expect(result.freedBytes).toBe(128)
    expect(await listInstalled()).toHaveLength(0)
    expect(await Bun.file(a.path).exists()).toBe(false)
    expect(await Bun.file(b.path).exists()).toBe(false)
  })

  test("prunePartialDownloads sweeps interrupted .part files", async () => {
    const part = join(home, "models", "gguf", "half-downloaded.gguf.part")
    await Bun.write(part, new Uint8Array(32))
    const keep = await fakeModel("qwen3-4b")
    await addInstalled(keep)

    const result = await prunePartialDownloads()
    expect(result.count).toBe(1)
    expect(result.freedBytes).toBe(32)
    expect(await Bun.file(part).exists()).toBe(false)
    // real models are untouched
    expect(await Bun.file(keep.path).exists()).toBe(true)
  })
})

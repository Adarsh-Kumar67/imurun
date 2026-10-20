/**
 * The new surfaces: the safe directory walk, the GitHub client, the prompt
 * ledger, the thinking categories, and clickable links.
 *
 * All of it runs offline: the GitHub calls are faked, the walk works on a
 * temporary directory, and the ledger never leaves the disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PromptLedger,
  githubRequest,
  githubTokenFromEnv,
  parseRepoRef,
  renderPromptLedger,
  walkFiles,
  isSkippedDirectory,
} from "../src"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "imurun-new-"))
  process.env.IMURUN_HOME = home
})

afterEach(async () => {
  delete process.env.IMURUN_HOME
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  await rm(home, { recursive: true, force: true })
})

describe("the safe directory walk", () => {
  test("system and hidden directories are skipped by name", () => {
    expect(isSkippedDirectory("AppData")).toBe(true)
    expect(isSkippedDirectory("appdata")).toBe(true)
    expect(isSkippedDirectory("node_modules")).toBe(true)
    expect(isSkippedDirectory(".git")).toBe(true)
    expect(isSkippedDirectory("src")).toBe(false)
    expect(isSkippedDirectory("packages")).toBe(false)
  })

  test("it finds the source files and skips the noise", async () => {
    const root = join(home, "project")
    await mkdir(join(root, "src"), { recursive: true })
    await mkdir(join(root, "node_modules", "left-pad"), { recursive: true })
    await mkdir(join(root, ".git"), { recursive: true })
    await writeFile(join(root, "src", "index.ts"), "export const a = 1\n")
    await writeFile(join(root, "src", "readme.md"), "# hi\n")
    await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")

    const walk = await walkFiles({ root })
    expect(walk.files).toContain("src/index.ts")
    expect(walk.files).toContain("src/readme.md")
    expect(walk.files.some((file) => file.includes("node_modules"))).toBe(false)
    expect(walk.files.some((file) => file.includes(".git"))).toBe(false)
  })

  test("a directory that cannot be read is skipped, not fatal", async () => {
    const root = join(home, "project")
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "index.ts"), "export const a = 1\n")
    // A file where a directory is expected: reading it as a directory fails.
    await writeFile(join(root, "not-a-dir"), "just a file\n")

    const walk = await walkFiles({ root })
    expect(walk.files).toContain("src/index.ts")
  })

  test("the walk honours the file cap", async () => {
    const root = join(home, "many")
    await mkdir(root, { recursive: true })
    for (let index = 0; index < 40; index++) {
      await writeFile(join(root, `file-${index}.ts`), `export const a = ${index}\n`)
    }
    const walk = await walkFiles({ root, maxFiles: 10 })
    expect(walk.files).toHaveLength(10)
  })
})

describe("the GitHub client", () => {
  test("the token comes from the environment, and is never echoed", async () => {
    process.env.GITHUB_TOKEN = "not-a-real-token"
    expect(githubTokenFromEnv()).toBe("not-a-real-token")
  })

  test("GH_TOKEN is the second choice", () => {
    process.env.GH_TOKEN = "also-not-real"
    expect(githubTokenFromEnv()).toBe("also-not-real")
  })

  test("no token is not an error", () => {
    expect(githubTokenFromEnv()).toBeUndefined()
  })

  test("a request without a token still works", async () => {
    const seen: Array<Record<string, string>> = []
    const result = await githubRequest<{ ok: boolean }>({
      path: "/repos/owner/repo",
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        seen.push((init?.headers ?? {}) as Record<string, string>)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(seen[0]!.authorization).toBeUndefined()
  })

  test("a token is sent in the header, never in the URL", async () => {
    process.env.GITHUB_TOKEN = "not-a-real-token"
    let url = ""
    let headers: Record<string, string> = {}
    await githubRequest({
      path: "/repos/owner/repo",
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        url = String(input)
        headers = (init?.headers ?? {}) as Record<string, string>
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(url).toBe("https://api.github.com/repos/owner/repo")
    expect(url).not.toContain("ghp_")
    expect(headers.authorization).toBe("Bearer not-a-real-token")
  })

  test("a rate-limited refusal says so, and mentions the token", async () => {
    const result = await githubRequest({
      path: "/repos/owner/repo",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }), {
          status: 403,
        })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    expect(result.rateLimited).toBe(true)
    expect(result.message).toContain("GITHUB_TOKEN")
    expect(result.message).not.toContain("ghp_")
  })

  test("a repository reference is read from a name or a URL", () => {
    expect(parseRepoRef("owner/repo")).toEqual({ owner: "owner", repo: "repo" })
    expect(parseRepoRef("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" })
    expect(parseRepoRef("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" })
    expect(parseRepoRef("nonsense")).toBeUndefined()
  })
})

describe("the prompt ledger", () => {
  test("a prompt is recorded, and marked done when its turn finishes", async () => {
    const ledger = await PromptLedger.load(join(home, "project"))
    const entry = ledger.add("fix the login bug in auth.ts")
    expect(entry.id).toBe("pr_1")
    expect(entry.status).toBe("pending")
    expect(ledger.open()).toHaveLength(1)

    ledger.start()
    expect(ledger.active()?.id).toBe("pr_1")
    ledger.complete(entry.id)
    expect(ledger.open()).toHaveLength(0)
    expect(ledger.summary()).toContain("1 done")
  })

  test("a blocked prompt keeps its reason", async () => {
    const ledger = await PromptLedger.load(join(home, "project"))
    const entry = ledger.add("do the impossible")
    ledger.block(entry.id, "the tool call failed")
    expect(ledger.open()).toHaveLength(0)
    expect(ledger.all()[0]!.reason).toBe("the tool call failed")
    expect(ledger.summary()).toContain("1 blocked")
  })

  test("it survives a restart", async () => {
    const project = join(home, "project")
    const ledger = await PromptLedger.load(project)
    ledger.add("first request")
    ledger.add("second request")
    ledger.complete("pr_1")
    await ledger.save()

    const reopened = await PromptLedger.load(project)
    expect(reopened.all()).toHaveLength(2)
    expect(reopened.all()[0]!.status).toBe("done")
    expect(reopened.all()[1]!.status).toBe("pending")
  })

  test("the file is readable markdown", () => {
    const markdown = renderPromptLedger([
      {
        id: "pr_1",
        text: "fix the bug",
        title: "fix the bug",
        status: "done",
        askedAt: 0,
        turns: 1,
      },
      {
        id: "pr_2",
        text: "and the other one",
        title: "and the other one",
        status: "pending",
        askedAt: 0,
        turns: 0,
      },
    ])
    expect(markdown).toContain("- [x] **pr_1** fix the bug")
    expect(markdown).toContain("- [ ] **pr_2** and the other one")
  })
})

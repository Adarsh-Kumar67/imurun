/**
 * The update path — comparing versions and asking the registry what is newest.
 *
 * The install itself is npm's, so what is tested here is the part IMURUN is
 * responsible for: saying whether there is an update, and not pretending
 * there is when the registry cannot be reached.
 */
import { describe, expect, test } from "bun:test"
import { checkForUpdate, compareVersions } from "../src/update"

describe("compareVersions", () => {
  test("a bigger version wins", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0)
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0)
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0)
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0)
  })

  test("the same version is not an update", () => {
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0)
    expect(compareVersions("v0.1.2", "0.1.2")).toBe(0)
  })

  test("a pre-release is older than the release", () => {
    expect(compareVersions("0.2.0", "0.2.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBeLessThan(0)
  })

  test("missing parts count as zero", () => {
    expect(compareVersions("0.2", "0.2.0")).toBe(0)
    expect(compareVersions("0.2.1", "0.2")).toBeGreaterThan(0)
  })
})

describe("checkForUpdate", () => {
  test("a newer version is reported", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: (async () => new Response(JSON.stringify({ version: "0.2.0" }))) as unknown as typeof fetch,
    })
    expect(status.updateAvailable).toBe(true)
    expect(status.latest).toBe("0.2.0")
    expect(status.current).toBe("0.1.0")
  })

  test("the same version is not an update", async () => {
    const status = await checkForUpdate("0.1.2", {
      fetchImpl: (async () => new Response(JSON.stringify({ version: "0.1.2" }))) as unknown as typeof fetch,
    })
    expect(status.updateAvailable).toBe(false)
  })

  test("an older registry is not an update either", async () => {
    const status = await checkForUpdate("0.2.0", {
      fetchImpl: (async () => new Response(JSON.stringify({ version: "0.1.0" }))) as unknown as typeof fetch,
    })
    expect(status.updateAvailable).toBe(false)
  })

  test("an unreachable registry is a message, not a crash", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: (async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    expect(status.updateAvailable).toBe(false)
    expect(status.error).toContain("offline")
  })

  test("an error status is a message, not a crash", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    })
    expect(status.updateAvailable).toBe(false)
    expect(status.error).toContain("503")
  })

  test("a reply with no version is a message, not a crash", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    })
    expect(status.updateAvailable).toBe(false)
    expect(status.error).toContain("did not name a version")
  })
})

/** One fake fetch that answers npm and GitHub differently. */
function channelFetch(replies: { npm?: string | number; github?: string | number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    const target = String(url)
    const which = target.includes("registry.npmjs.org") ? "npm" : "github"
    const reply = replies[which]
    if (reply === undefined) throw new Error("offline")
    if (typeof reply === "number") return new Response("nope", { status: reply })
    const body = which === "npm" ? { version: reply } : { tag_name: `v${reply}` }
    return new Response(JSON.stringify(body))
  }) as unknown as typeof fetch
}

describe("checkForUpdate across both channels", () => {
  test("the newer of the two answers wins, and says where it came from", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: channelFetch({ npm: "0.2.0", github: "0.2.1" }),
    })
    expect(status.latest).toBe("0.2.1")
    expect(status.channel).toBe("github")
    expect(status.updateAvailable).toBe(true)
  })

  test("a blocked registry still finds the release on GitHub", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: channelFetch({ github: "0.2.0" }),
    })
    expect(status.latest).toBe("0.2.0")
    expect(status.updateAvailable).toBe(true)
  })

  test("a stale GitHub release does not hide a newer npm package", async () => {
    const status = await checkForUpdate("0.1.0", {
      fetchImpl: channelFetch({ npm: "0.2.0", github: "0.1.5" }),
    })
    expect(status.latest).toBe("0.2.0")
    expect(status.channel).toBe("npm")
  })

  test("both channels down is one message naming both", async () => {
    const status = await checkForUpdate("0.1.0", { fetchImpl: channelFetch({}) })
    expect(status.updateAvailable).toBe(false)
    expect(status.error).toContain("registry")
    expect(status.error).toContain("GitHub")
  })
})

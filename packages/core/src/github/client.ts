/**
 * The GitHub client — one place that knows how to talk to GitHub safely.
 *
 * Three things matter here, and none of them is optional:
 *
 *   1. **The token is never written to disk and never echoed.** It is read
 *      from the environment (`GITHUB_TOKEN`, then `GH_TOKEN`) or from
 *      IMURUN's own encrypted credential store. It goes into an `Authorization`
 *      header and nowhere else — not into a URL, not into a log line, not
 *      into an error message.
 *   2. **Unauthenticated requests still work.** GitHub allows 60 requests an
 *      hour without a token and 5,000 with one. A missing token is not an
 *      error; it just means the limit is the lower one.
 *   3. **Failures explain themselves.** A 403 from GitHub is almost always
 *      the rate limit, and saying "rate limit" is more useful than saying
 *      "HTTP 403".
 */
import { logger } from "@imurun/util"

const API = "https://api.github.com"

/** The environment variables GitHub tokens are conventionally read from. */
const TOKEN_VARS = ["GITHUB_TOKEN", "GH_TOKEN"] as const

export interface GitHubTokenSource {
  /** The token, if one is available. */
  token?: string
  /** Where it came from — for the log, never the token itself. */
  origin?: "environment" | "credential" | "none"
}

/**
 * The token from the environment, if there is one.
 *
 * Read at call time rather than at import time, so a token exported after
 * IMURUN started is still found.
 */
export function githubTokenFromEnv(): string | undefined {
  for (const name of TOKEN_VARS) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

/** A hint for the user: how the token is spelled, never the token itself. */
export function tokenHint(token: string): string {
  if (token.length <= 8) return "…"
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

export interface GitHubRequestOptions {
  /** The path after the API root, e.g. "/repos/owner/repo". */
  path: string
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
  /** A token to use instead of the environment one. */
  token?: string
  /** Extra headers. */
  headers?: Record<string, string>
  /** Milliseconds before the request is abandoned. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface GitHubResponse<T = unknown> {
  ok: boolean
  status: number
  data?: T
  /** A message worth showing a person. */
  message?: string
  /** True when the failure was the rate limit rather than a bad request. */
  rateLimited?: boolean
}

/** The headers every GitHub request carries. */
export function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "user-agent": "imurun",
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * Makes one request against the GitHub API.
 *
 * The token is read from the environment when none is passed. A failure never
 * throws: it comes back as a result with a message a person can act on.
 */
export async function githubRequest<T = unknown>(
  options: GitHubRequestOptions,
): Promise<GitHubResponse<T>> {
  const token = options.token ?? githubTokenFromEnv()
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)

  try {
    const response = await doFetch(`${API}${options.path}`, {
      method: options.method ?? "GET",
      headers: {
        ...githubHeaders(token),
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })

    if (response.status === 204) return { ok: true, status: 204 }

    const text = await response.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      data = undefined
    }

    if (!response.ok) {
      const message = (data as { message?: string } | undefined)?.message
      const rateLimited =
        response.status === 403 || response.status === 429
          ? /rate limit|secondary rate|abuse/i.test(message ?? "") || !message
          : false
      return {
        ok: false,
        status: response.status,
        data: data as T | undefined,
        rateLimited,
        message: rateLimited
          ? token
            ? "GitHub refused the request (rate limit). Try again in a moment."
            : "GitHub's unauthenticated rate limit was reached. Set GITHUB_TOKEN to raise it to 5,000 requests an hour."
          : `GitHub returned HTTP ${response.status}${message ? `: ${message}` : ""}`,
      }
    }

    return { ok: true, status: response.status, data: data as T | undefined }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.debug(`github: request failed: ${reason}`)
    return { ok: false, status: 0, message: `Could not reach GitHub: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

/** "owner/repo" from a URL, a path, or the name itself. */
export function parseRepoRef(input: string): { owner: string; repo: string } | undefined {
  const trimmed = input.trim().replace(/\.git$/i, "").replace(/\/+$/, "")
  const fromUrl = /github\.com[/:]([^/]+)\/([^/]+)/i.exec(trimmed)
  const parts = (fromUrl ? `${fromUrl[1]}/${fromUrl[2]}` : trimmed).split("/").filter(Boolean)
  if (parts.length < 2) return undefined
  const owner = parts[0]!
  const repo = parts[1]!
  if (!owner || !repo) return undefined
  return { owner, repo }
}

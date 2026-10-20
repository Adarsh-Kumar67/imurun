/**
 * The `github` tool — read records, repos and issues without leaving the
 * terminal.
 *
 * The tool talks to the GitHub REST API through the shared client, which
 * handles the token. The token is read from `GITHUB_TOKEN` or `GH_TOKEN`, or
 * from IMURUN's own encrypted credential store, and it is never written to a
 * file, never printed, and never put in a URL.
 *
 * Without a token the tool still works: GitHub allows 60 requests an hour
 * unauthenticated, which is enough to read a public repository. With one it
 * is 5,000 — and the private repositories and issue lists become visible.
 */
import type { ImurunTool } from "./types"
import { fail, ok, optionalNumber, optionalString, requireString } from "./types"
import { githubRequest, parseRepoRef, tokenHint, githubTokenFromEnv } from "../github/client"

const MAX_ITEMS = 30
const MAX_TEXT = 4_000

interface GitHubRepo {
  full_name?: string
  description?: string
  html_url?: string
  stargazers_count?: number
  open_issues_count?: number
  default_branch?: string
  language?: string
  license?: { spdx_id?: string }
  pushed_at?: string
  archived?: boolean
}

interface GitHubIssue {
  number?: number
  title?: string
  state?: string
  html_url?: string
  created_at?: string
  updated_at?: string
  body?: string
  user?: { login?: string }
  labels?: Array<{ name?: string }>
  pull_request?: unknown
}

interface GitHubRelease {
  tag_name?: string
  name?: string
  html_url?: string
  published_at?: string
  body?: string
}

interface GitHubUser {
  login?: string
  name?: string
  html_url?: string
  public_repos?: number
  followers?: number
  created_at?: string
}

/** A short line about the credential, never the credential. */
function credentialLine(): string {
  const token = githubTokenFromEnv()
  if (!token) return "GitHub: unauthenticated (60 requests an hour). Set GITHUB_TOKEN for 5,000."
  return `GitHub: authenticated with ${tokenHint(token)} (5,000 requests an hour).`
}

function clip(text: string | undefined, max = MAX_TEXT): string {
  if (!text) return ""
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more characters)`
}

export const githubTool: ImurunTool = {
  name: "github",
  description:
    "Read GitHub: a repository's details, its issues, its releases, a file's contents, or a user's profile. " +
    "Works without a token for public repositories; set GITHUB_TOKEN for private ones and for a higher rate limit.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["repo", "issues", "release", "file", "user", "search"],
        description: "What to read.",
      },
      repo: {
        type: "string",
        description: 'The repository as "owner/name" or a GitHub URL. Not needed for action=user.',
      },
      path: {
        type: "string",
        description: "The file to read, for action=file.",
      },
      ref: {
        type: "string",
        description: "The branch, tag or commit, for action=file. Defaults to the default branch.",
      },
      number: {
        type: "number",
        description: "The issue number, for action=issues with a single issue.",
      },
      state: {
        type: "string",
        enum: ["open", "closed", "all"],
        description: "Which issues to list. Defaults to open.",
      },
      query: {
        type: "string",
        description: "The search text, for action=search.",
      },
      limit: {
        type: "number",
        description: `How many items to return (max ${MAX_ITEMS}). Defaults to 10.`,
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  title(args) {
    const action = optionalString(args, "action") ?? "repo"
    const repo = optionalString(args, "repo")
    return repo ? `github ${action} ${repo}` : `github ${action}`
  },
  async execute(args) {
    const action = optionalString(args, "action") ?? "repo"
    const limit = Math.min(Math.max(optionalNumber(args, "limit") ?? 10, 1), MAX_ITEMS)

    if (action === "user") {
      const login = optionalString(args, "repo") ?? optionalString(args, "query")
      if (!login) return fail("Which user? Give the login as `repo`.")
      const result = await githubRequest<GitHubUser>({ path: `/users/${encodeURIComponent(login)}` })
      if (!result.ok) return fail(result.message ?? "GitHub request failed")
      const user = result.data ?? {}
      return ok(
        [
          `${user.login ?? login}${user.name ? ` (${user.name})` : ""}`,
          user.html_url ?? "",
          user.public_repos !== undefined ? `${user.public_repos} public repositories` : "",
          user.followers !== undefined ? `${user.followers} followers` : "",
          credentialLine(),
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    const rawRepo = optionalString(args, "repo")
    if (!rawRepo) return fail("Which repository? Give it as `owner/name`.")
    const ref = parseRepoRef(rawRepo)
    if (!ref) return fail(`"${rawRepo}" is not a repository. Use "owner/name" or a GitHub URL.`)
    const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`

    if (action === "repo") {
      const result = await githubRequest<GitHubRepo>({ path: base })
      if (!result.ok) return fail(result.message ?? "GitHub request failed")
      const repo = result.data ?? {}
      return ok(
        [
          `${repo.full_name ?? `${ref.owner}/${ref.repo}`}${repo.archived ? " (archived)" : ""}`,
          clip(repo.description ?? "", 300),
          repo.html_url ?? "",
          repo.language ? `Language: ${repo.language}` : "",
          repo.license?.spdx_id ? `License: ${repo.license.spdx_id}` : "",
          repo.default_branch ? `Default branch: ${repo.default_branch}` : "",
          repo.stargazers_count !== undefined ? `Stars: ${repo.stargazers_count}` : "",
          repo.open_issues_count !== undefined ? `Open issues: ${repo.open_issues_count}` : "",
          repo.pushed_at ? `Last push: ${repo.pushed_at}` : "",
          credentialLine(),
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    if (action === "issues") {
      const number = optionalNumber(args, "number")
      if (number !== undefined) {
        const result = await githubRequest<GitHubIssue>({ path: `${base}/issues/${number}` })
        if (!result.ok) return fail(result.message ?? "GitHub request failed")
        const issue = result.data ?? {}
        return ok(
          [
            `#${issue.number} ${issue.title ?? ""} [${issue.state ?? "?"}]`,
            issue.html_url ?? "",
            issue.user?.login ? `by ${issue.user.login}` : "",
            issue.labels?.length ? `Labels: ${issue.labels.map((label) => label.name ?? "").filter(Boolean).join(", ")}` : "",
            issue.created_at ? `Opened: ${issue.created_at}` : "",
            "",
            clip(issue.body ?? ""),
          ]
            .filter(Boolean)
            .join("\n"),
        )
      }
      const state = optionalString(args, "state") ?? "open"
      const result = await githubRequest<GitHubIssue[]>({
        path: `${base}/issues?state=${encodeURIComponent(state)}&per_page=${limit}`,
      })
      if (!result.ok) return fail(result.message ?? "GitHub request failed")
      const issues = (result.data ?? []).filter((issue) => !issue.pull_request)
      if (issues.length === 0) return ok(`No ${state} issues in ${ref.owner}/${ref.repo}.`)
      return ok(
        issues
          .map(
            (issue) =>
              `#${issue.number} ${issue.title ?? ""} [${issue.state ?? "?"}]` +
              `${issue.user?.login ? ` by ${issue.user.login}` : ""}` +
              `${issue.html_url ? ` — ${issue.html_url}` : ""}`,
          )
          .join("\n"),
      )
    }

    if (action === "release") {
      const result = await githubRequest<GitHubRelease[]>({ path: `${base}/releases?per_page=${limit}` })
      if (!result.ok) return fail(result.message ?? "GitHub request failed")
      const releases = result.data ?? []
      if (releases.length === 0) return ok(`No releases in ${ref.owner}/${ref.repo}.`)
      return ok(
        releases
          .map(
            (release) =>
              `${release.tag_name ?? release.name ?? "(untagged)"}${release.published_at ? ` — ${release.published_at}` : ""}` +
              `${release.html_url ? ` — ${release.html_url}` : ""}`,
          )
          .join("\n"),
      )
    }

    if (action === "file") {
      const path = requireString(args, "path")
      const branch = optionalString(args, "ref")
      const target = branch ? `${base}/contents/${path}?ref=${encodeURIComponent(branch)}` : `${base}/contents/${path}`
      const result = await githubRequest<{ content?: string; encoding?: string; html_url?: string }>({
        path: target,
      })
      if (!result.ok) return fail(result.message ?? "GitHub request failed")
      const file = result.data ?? {}
      if (file.content === undefined) return fail(`"${path}" is not a file in ${ref.owner}/${ref.repo}.`)
      const decoded =
        file.encoding === "base64"
          ? Buffer.from(file.content.replace(/\s+/g, ""), "base64").toString("utf8")
          : file.content
      return ok([file.html_url ?? "", "", clip(decoded)].filter(Boolean).join("\n"))
    }

    if (action === "search") {
      const query = optionalString(args, "query")
      if (!query) return fail("What to search for? Give the text as `query`.")
      const result = await githubRequest<{ items?: Array<{ full_name?: string; html_url?: string; description?: string }> }>({
        path: `/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
      })
      if (!result.ok) return fail(result.message ?? "GitHub request failed")
      const items = result.data?.items ?? []
      if (items.length === 0) return ok(`Nothing on GitHub matched "${query}".`)
      return ok(
        items
          .map(
            (item) =>
              `${item.full_name ?? ""}${item.description ? ` — ${clip(item.description, 120)}` : ""}` +
              `${item.html_url ? `\n  ${item.html_url}` : ""}`,
          )
          .join("\n"),
      )
    }

    return fail(`Unknown action "${action}". Use repo, issues, release, file, user or search.`)
  },
}

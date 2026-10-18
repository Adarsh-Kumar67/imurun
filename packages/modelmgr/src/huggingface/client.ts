/**
 * Hugging Face client — URL resolution, metadata, and search.
 *
 * No API key is required for public models. When HF_TOKEN is set (env or
 * config), it is sent for gated/private repos.
 */

export const HF_BASE = "https://huggingface.co"
export const HF_API = "https://huggingface.co/api"

export interface HfFileInfo {
  /** Final URL (after redirects). */
  url: string
  /** Total size in bytes when the server reports it. */
  sizeBytes?: number
  /** SHA-256 of the file when Hugging Face exposes it (LFS objects). */
  sha256?: string
  /** Whether the file supports HTTP range requests (resume). */
  acceptsRanges: boolean
}

export interface HfModelSummary {
  id: string
  downloads?: number
  likes?: number
  gated?: boolean | string
  lastModified?: string
  tags?: string[]
}

function authHeaders(token?: string): Record<string, string> {
  const key = token ?? process.env.HF_TOKEN
  return key ? { authorization: `Bearer ${key}` } : {}
}

/** Resolves the download URL for one file in a repository. */
export function resolveFileUrl(repo: string, file: string, revision = "main"): string {
  return `${HF_BASE}/${repo}/resolve/${revision}/${file}?download=true`
}

const SHA256_RE = /^[a-f0-9]{64}$/i

/**
 * Asks the server about a file without downloading it.
 *
 * Hugging Face redirects downloads to a CDN (Xet). The authoritative SHA-256
 * lives in the first response's X-Linked-ETag; the CDN's own ETag is a Xet
 * reconstruction hash and must not be used for verification. Size and range
 * support come from the final hop.
 */
export async function headFile(url: string, token?: string): Promise<HfFileInfo> {
  const auth = authHeaders(token)
  const first = await fetch(url, {
    method: "HEAD",
    redirect: "manual",
    headers: auth,
    signal: AbortSignal.timeout(20_000),
  })

  const linkedEtag = (first.headers.get("x-linked-etag") ?? "")
    .replace(/^W\//, "")
    .replace(/"/g, "")
    .trim()
  const linkedSizeHeader = first.headers.get("x-linked-size")
  const linkedSize = linkedSizeHeader ? Number(linkedSizeHeader) : undefined

  // direct response (no redirect): metadata is on this response
  if (first.status < 300 || first.status >= 400) {
    if (!first.ok) {
      throw new Error(`Hugging Face returned HTTP ${first.status} for ${url.replace(/[?#].*$/, "")}`)
    }
    const etag = (first.headers.get("x-linked-etag") ?? first.headers.get("etag") ?? "")
      .replace(/^W\//, "")
      .replace(/"/g, "")
      .trim()
    const sizeHeader = first.headers.get("content-length")
    return {
      url,
      sizeBytes: sizeHeader ? Number(sizeHeader) : linkedSize,
      sha256: SHA256_RE.test(etag) ? etag.toLowerCase() : undefined,
      acceptsRanges: (first.headers.get("accept-ranges") ?? "").includes("bytes"),
    }
  }

  const location = first.headers.get("location")
  if (!location) {
    throw new Error(`Hugging Face returned HTTP ${first.status} without a redirect location for ${url}`)
  }

  // follow to the CDN for size + range support (no auth: the URL is signed)
  let sizeBytes = linkedSize
  let acceptsRanges = true // HF/Xet CDN supports range requests
  try {
    const final = await fetch(new URL(location, url).toString(), {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    })
    if (final.ok) {
      const sizeHeader = final.headers.get("content-length")
      if (sizeHeader) sizeBytes = Number(sizeHeader)
      const ranges = final.headers.get("accept-ranges")
      if (ranges) acceptsRanges = ranges.includes("bytes")
    }
  } catch {
    // keep the linked size; range support defaults to true
  }

  return {
    url,
    sizeBytes,
    sha256: SHA256_RE.test(linkedEtag) ? linkedEtag.toLowerCase() : undefined,
    acceptsRanges,
  }
}

/** Metadata for a single repository file (size + sha256), or undefined when absent. */
export async function fileInfo(repo: string, file: string, token?: string): Promise<HfFileInfo | undefined> {
  try {
    return await headFile(resolveFileUrl(repo, file), token)
  } catch {
    return undefined
  }
}

/** Searches Hugging Face for GGUF repositories (used by `imurun models search`). */
export async function searchHfModels(query: string, limit = 12, token?: string): Promise<HfModelSummary[]> {
  const url = `${HF_API}/models?search=${encodeURIComponent(query)}&filter=gguf&limit=${limit}&sort=downloads&direction=-1`
  const response = await fetch(url, {
    headers: authHeaders(token),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Hugging Face search failed (HTTP ${response.status})`)
  const body = (await response.json()) as Array<{
    id?: string
    downloads?: number
    likes?: number
    gated?: boolean | string
    lastModified?: string
    tags?: string[]
  }>
  return body
    .filter((entry): entry is typeof entry & { id: string } => typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id,
      downloads: entry.downloads,
      likes: entry.likes,
      gated: entry.gated,
      lastModified: entry.lastModified,
      tags: entry.tags,
    }))
}

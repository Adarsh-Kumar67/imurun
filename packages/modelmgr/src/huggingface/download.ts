/**
 * Streaming file downloader for Hugging Face assets.
 *
 *   - resumes interrupted downloads with HTTP range requests
 *   - reports throttled progress (bytes, speed, ETA) for the CLI bar
 *   - retries transient failures, keeping the partial file
 *   - verifies SHA-256 when the server exposes it
 *   - writes to <destination>.part and renames atomically on success
 */
import { open, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { ensureDir, sha256File, sleep } from "@imurun/util"

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes?: number
  bytesPerSecond: number
  /** 0-100 when the total is known. */
  percent?: number
}

export interface DownloadOptions {
  url: string
  destination: string
  token?: string
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  /** Attempt to resume from a previous .part file. Default true. */
  resume?: boolean
  /** Expected SHA-256 (usually from headFile); verified after download. */
  sha256?: string
  /** Expected size in bytes; used for progress before the first response. */
  expectedSizeBytes?: number
  /** Max attempts for transient errors. Default 3. */
  attempts?: number
}

export interface DownloadResult {
  path: string
  sizeBytes: number
  sha256?: string
  /** True when a partial download was resumed. */
  resumed: boolean
}

function authHeader(token?: string): Record<string, string> {
  const key = token ?? process.env.HF_TOKEN
  return key ? { authorization: `Bearer ${key}` } : {}
}

async function partSize(partPath: string): Promise<number> {
  try {
    return (await stat(partPath)).size
  } catch {
    return 0
  }
}

class ProgressMeter {
  private lastEmit = 0
  private windowBytes = 0
  private windowStart = Date.now()
  private speed = 0

  constructor(private readonly totalBytes: number | undefined, private readonly callback?: (p: DownloadProgress) => void) {}

  report(downloadedBytes: number, force = false): void {
    const now = Date.now()
    this.windowBytes = downloadedBytes
    if (now - this.windowStart >= 1000) {
      const elapsed = (now - this.windowStart) / 1000
      const delta = this.windowBytes - (this.lastBytes ?? 0)
      this.speed = delta / elapsed
      this.lastBytes = this.windowBytes
      this.windowStart = now
    }
    if (!force && now - this.lastEmit < 200) return
    this.lastEmit = now
    this.callback?.({
      downloadedBytes,
      totalBytes: this.totalBytes,
      bytesPerSecond: this.speed,
      percent: this.totalBytes ? Math.min(100, (downloadedBytes / this.totalBytes) * 100) : undefined,
    })
  }

  private lastBytes?: number

  done(downloadedBytes: number): void {
    this.callback?.({
      downloadedBytes,
      totalBytes: this.totalBytes,
      bytesPerSecond: this.speed,
      percent: this.totalBytes ? 100 : undefined,
    })
  }
}

async function streamToFile(
  body: ReadableStream<Uint8Array>,
  partPath: string,
  append: boolean,
  startBytes: number,
  meter: ProgressMeter,
  signal?: AbortSignal,
): Promise<number> {
  const handle = await open(partPath, append && append ? "a" : "w")
  const reader = body.getReader()
  let written = startBytes
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Download aborted", "AbortError")
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        await handle.write(value)
        written += value.byteLength
        meter.report(written)
      }
    }
  } finally {
    await handle.close()
    reader.releaseLock()
  }
  return written
}

async function attemptDownload(options: DownloadOptions): Promise<DownloadResult> {
  const { url, destination, signal, onProgress, resume = true, attempts = 3 } = options
  const partPath = `${destination}.part`
  await ensureDir(dirname(partPath))

  let lastError: Error | undefined
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new DOMException("Download aborted", "AbortError")
    const startBytes = resume ? await partSize(partPath) : 0

    const headers: Record<string, string> = { ...authHeader(options.token) }
    if (startBytes > 0) headers.range = `bytes=${startBytes}-`

    try {
      const response = await fetch(url, { headers, redirect: "follow", signal })

      if (!response.ok) {
        if (response.status === 416) {
          // already complete — treat the part file as the full download
          const finalSize = await partSize(partPath)
          return finish(partPath, destination, finalSize, options, startBytes > 0)
        }
        throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim())
      }

      const resuming = startBytes > 0 && response.status === 206
      const contentLength = response.headers.get("content-length")
      const totalBytes = resuming
        ? startBytes + Number(contentLength ?? 0)
        : contentLength
          ? Number(contentLength)
          : options.expectedSizeBytes

      const meter = new ProgressMeter(totalBytes, onProgress)
      meter.report(resuming ? startBytes : 0, true)

      if (!response.body) throw new Error("empty response body")
      const written = await streamToFile(response.body, partPath, resuming, resuming ? startBytes : 0, meter, signal)

      if (totalBytes !== undefined && written < totalBytes) {
        throw new Error(`connection closed early (${written}/${totalBytes} bytes)`)
      }

      meter.done(written)
      return finish(partPath, destination, written, options, resuming)
    } catch (error) {
      if ((error as Error).name === "AbortError" || signal?.aborted) throw error
      lastError = error as Error
      if (attempt < attempts) {
        onProgress?.({
          downloadedBytes: await partSize(partPath),
          totalBytes: options.expectedSizeBytes,
          bytesPerSecond: 0,
        })
        await sleep(1000 * attempt)
      }
    }
  }

  throw new Error(`Download failed after ${attempts} attempts: ${lastError?.message}`)
}

async function finish(
  partPath: string,
  destination: string,
  sizeBytes: number,
  options: DownloadOptions,
  resumed: boolean,
): Promise<DownloadResult> {
  let digest: string | undefined
  if (options.sha256) {
    digest = await sha256File(partPath)
    if (digest !== options.sha256.toLowerCase()) {
      await rm(partPath, { force: true })
      throw new Error(
        `Checksum mismatch — the download is corrupt and has been discarded.\n  expected ${options.sha256}\n  got      ${digest}`,
      )
    }
  }

  await rm(destination, { force: true })
  await rename(partPath, destination)
  return { path: destination, sizeBytes, sha256: digest, resumed }
}

/** Downloads a file to `destination`, resuming and verifying as configured. */
export function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  return attemptDownload(options)
}

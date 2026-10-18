/**
 * Retry helpers — exponential backoff with jitter for network and process ops.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number
  /** Base delay in ms. Default 500. */
  baseDelayMs?: number
  /** Maximum delay in ms. Default 15_000. */
  maxDelayMs?: number
  /** Multiplier applied per attempt. Default 2. */
  factor?: number
  /** Randomize delays by ±25% to avoid thundering herds. Default true. */
  jitter?: boolean
  /** Return false to stop retrying and throw immediately. */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /** Called before each sleep. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    factor = 2,
    jitter = true,
    shouldRetry,
    onRetry,
  } = options

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      if (shouldRetry && !shouldRetry(error, attempt)) break

      let delay = Math.min(baseDelayMs * factor ** (attempt - 1), maxDelayMs)
      if (jitter) delay = delay * (0.75 + Math.random() * 0.5)
      onRetry?.(error, attempt, Math.round(delay))
      await sleep(Math.round(delay))
    }
  }
  throw lastError
}

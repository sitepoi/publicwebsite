/**
 * Per-node memory cache primitives (Section 18) — C6 uses the rate limiter
 * for the forms guards (per-IP, hashed keys only). The cache-tag layer
 * arrives in C11.
 */
export interface RateLimitOptions {
  max: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterMs?: number
}

export interface RateLimiter {
  check(key: string): RateLimitResult
  reset(key?: string): void
}

/** Sliding-window in-memory rate limiter (per process). */
export function createMemoryRateLimiter(options: RateLimitOptions): RateLimiter {
  const hits = new Map<string, number[]>()
  const { max, windowMs } = options

  function check(key: string): RateLimitResult {
    const now = Date.now()
    const cutoff = now - windowMs
    const window = (hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff)

    if (window.length >= max) {
      const oldest = window[0] ?? now
      const retryAfterMs = Math.max(0, oldest + windowMs - now)
      hits.set(key, window)
      return { allowed: false, retryAfterMs }
    }

    window.push(now)
    hits.set(key, window)
    return { allowed: true }
  }

  function reset(key?: string): void {
    if (key === undefined) {
      hits.clear()
      return
    }
    hits.delete(key)
  }

  return { check, reset }
}

export interface MemoryCache<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  delete(key: string): void
  clear(): void
}

/** TTL memory cache (Section 18) — C7 query cache; tags arrive in C11. */
export function createMemoryCache<T>(options: { ttlMs: number }): MemoryCache<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>()
  const { ttlMs } = options

  return {
    get(key: string): T | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key: string, value: T): void {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    },
    delete(key: string): void {
      entries.delete(key)
    },
    clear(): void {
      entries.clear()
    },
  }
}

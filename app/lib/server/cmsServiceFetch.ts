/**
 * Authenticated CMS v2 call helper (server-only).
 *
 * Every attempt:
 *   1. resolves the tenant's credentials (cached, server memory),
 *   2. mints a FRESH service JWT (new jti — tokens are never cached/reused),
 *   3. calls the tenant's cmsBaseUrl with x-unicon-service-token,
 *   4. on UNKNOWN_KEY / INVALID_SIGNATURE invalidates the cache, refetches the
 *      runtime secret and retries EXACTLY once.
 *
 * The private key and the token never leave this module's stack frame; only
 * the CMS response body/status and safe error codes are returned.
 */

import type { CmsServiceConfig } from './cmsServiceConfig'
import type {
  FirstPartyCredentialResolver,
  FirstPartyCredentials,
  FirstPartyTenantIdentity,
} from './cmsFirstPartyCredentials'
import { buildCmsServiceToken } from './cmsServiceToken'

export interface CmsServiceFetchInput {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  /** CMS path relative to the v2 base, e.g. "/objects/reviews". */
  cmsPath: string
  body?: string
  identity: FirstPartyTenantIdentity
  config: CmsServiceConfig
  resolver: FirstPartyCredentialResolver
  fetchFn: typeof fetch
  idempotencyKey?: string
  /** Adds x-unicon-write-source: public-website (public writes only). */
  writeSource?: boolean
  /** Short exponential backoff for key propagation (CMS config cache can lag a
   * freshly written key by up to 30s). Default [300, 1000, 2000] ms; tests
   * pass [] or zeros. */
  retryDelaysMs?: number[]
}

export interface CmsServiceFetchSuccess {
  ok: true
  status: number
  body: string
  kid: string
  cacheHit: boolean
  retryAfterMs?: number
  rateLimitHeaders?: Record<string, string>
}

export interface CmsServiceFetchFailure {
  ok: false
  status: number
  error: string
  body: string
  kid?: string
  cacheHit?: boolean
  retryAfterMs?: number
  rateLimitHeaders?: Record<string, string>
}

export type CmsServiceFetchResult = CmsServiceFetchSuccess | CmsServiceFetchFailure

/** Confirmed CMS response header names (rate limit per minute, quota per month). */
export const CMS_RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit-minute',
  'x-ratelimit-remaining-minute',
  'x-quota-limit-month',
  'x-quota-remaining-month',
] as const

interface Attempt {
  networkError: boolean
  status: number
  body: string
  retryAfterMs?: number
  rateLimitHeaders?: Record<string, string>
}

const ROTATION_ERROR_CODES = new Set(['UNKNOWN_KEY', 'INVALID_SIGNATURE'])

/** Short exponential backoff while a freshly written key propagates. */
export const DEFAULT_ROTATION_RETRY_DELAYS_MS = [300, 1000, 2000] as const
/** Returned to the caller when the key is still propagating after all retries. */
export const KEY_PROPAGATING_RETRY_AFTER_MS = 5_000

/**
 * Normalize a CMS base URL so `/api/v2` appears exactly ONCE.
 * Accepts `https://host`, `https://host/api/v2`, `https://host/api/v2/` and
 * even `https://host/api/v2/objects` (defensively cut at the marker).
 */
export function normalizeCmsBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  const marker = '/api/v2'
  const index = trimmed.toLowerCase().indexOf(marker)
  if (index >= 0) return trimmed.slice(0, index + marker.length)
  return `${trimmed}${marker}`
}

export interface CmsErrorInfo {
  /** Top-level error code (CMS: error.code). */
  code?: string
  /** CMS: error.details.reason — e.g. UNKNOWN_KEY, WRONG_TENANT, TOKEN_EXPIRED. */
  reason?: string
  /** CMS: error.details object (NOT guaranteed to be populated). */
  details?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the CMS error body: `{ success: false, error: { code, message,
 * details } }`. Tolerates legacy `{ error: 'CODE' }` shapes.
 */
export function readCmsErrorInfo(body: string): CmsErrorInfo {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!isRecord(parsed)) return {}

    const info: CmsErrorInfo = {}
    const errorValue = parsed['error']
    if (typeof errorValue === 'string') {
      info.code = errorValue
    } else if (isRecord(errorValue)) {
      if (typeof errorValue['code'] === 'string') info.code = errorValue['code']
      const details = errorValue['details']
      if (isRecord(details)) {
        info.details = details
        if (typeof details['reason'] === 'string') info.reason = details['reason']
      }
    }
    if (info.code === undefined) {
      for (const key of ['code', 'errorCode']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.length > 0) {
          info.code = value
          break
        }
      }
    }
    if (info.reason === undefined && typeof parsed['reason'] === 'string') {
      info.reason = parsed['reason']
    }
    return info
  } catch {
    return {}
  }
}

function isRotationAuthFailure(attempt: Attempt): boolean {
  if (attempt.networkError) return false
  if (attempt.status !== 401 && attempt.status !== 403) return false
  const info = readCmsErrorInfo(attempt.body)
  if (info.code !== undefined && ROTATION_ERROR_CODES.has(info.code)) return true
  if (info.reason !== undefined && ROTATION_ERROR_CODES.has(info.reason)) return true
  return false
}

async function sendAttempt(
  input: CmsServiceFetchInput,
  credentials: FirstPartyCredentials,
): Promise<Attempt> {
  const url = `${normalizeCmsBaseUrl(credentials.cmsBaseUrl)}${input.cmsPath}`
  const headers: Record<string, string> = {
    'x-unicon-service-token': buildCmsServiceToken({
      privateKeyPem: credentials.privateKeyPem,
      alg: credentials.alg,
      kid: credentials.kid,
      issuer: credentials.issuer,
      audience: credentials.audience,
      appId: credentials.appId,
      tenantId: credentials.tenantId,
      deploymentId: credentials.deploymentId,
      ttlSeconds: input.config.tokenTtlSeconds,
    }),
    accept: 'application/json',
  }
  if (input.body !== undefined) headers['content-type'] = 'application/json'
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey
  if (input.writeSource) headers['x-unicon-write-source'] = 'public-website'

  try {
    const response = await input.fetchFn(url, {
      method: input.method,
      headers,
      body: input.body,
      signal: AbortSignal.timeout(input.config.cmsFetchTimeoutMs),
      cache: 'no-store',
    })
    const retryAfterHeader = response.headers.get('retry-after')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN
    const rateLimitHeaders: Record<string, string> = {}
    for (const name of CMS_RATE_LIMIT_HEADERS) {
      const value = response.headers.get(name)
      if (value) rateLimitHeaders[name] = value
    }
    return {
      networkError: false,
      status: response.status,
      body: await response.text(),
      ...(Object.keys(rateLimitHeaders).length > 0 ? { rateLimitHeaders } : {}),
      ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? { retryAfterMs: retryAfterSeconds * 1000 }
        : {}),
    }
  } catch {
    return { networkError: true, status: 0, body: '' }
  }
}

function toResult(
  attempt: Attempt,
  credentials: FirstPartyCredentials,
  cacheHit: boolean,
): CmsServiceFetchResult {
  if (attempt.networkError) {
    return {
      ok: false,
      status: 502,
      error: 'CMS_UNAVAILABLE',
      body: '',
      kid: credentials.kid,
      cacheHit,
    }
  }
  return {
    ok: true,
    status: attempt.status,
    body: attempt.body,
    kid: credentials.kid,
    cacheHit,
    ...(attempt.retryAfterMs !== undefined ? { retryAfterMs: attempt.retryAfterMs } : {}),
    ...(attempt.rateLimitHeaders !== undefined
      ? { rateLimitHeaders: attempt.rateLimitHeaders }
      : {}),
  }
}

/**
 * Call the tenant's CMS v2 with first-party service authentication.
 * Returns the raw CMS status/body on any HTTP response (callers map safe
 * browser errors); only credential/network failures become synthetic errors.
 */
export async function callCmsService(input: CmsServiceFetchInput): Promise<CmsServiceFetchResult> {
  const firstCredentialResult = await input.resolver.get(input.identity)
  if (!firstCredentialResult.ok) {
    return {
      ok: false,
      status: 503,
      error: 'FIRST_PARTY_CREDENTIALS_UNAVAILABLE',
      body: '',
    }
  }

  let credentials = firstCredentialResult.credentials
  let cacheHit = firstCredentialResult.cacheHit
  let attempt = await sendAttempt(input, credentials)

  // Key rotation / propagation: short exponential backoff (300ms, 1s, 2s by
  // default), each retry invalidates and refetches the runtime secret. Never
  // hold the request for the full 30s config-cache window.
  const retryDelays = input.retryDelaysMs ?? DEFAULT_ROTATION_RETRY_DELAYS_MS
  for (const delayMs of retryDelays) {
    if (!isRotationAuthFailure(attempt)) break
    input.resolver.invalidate(input.identity.tenantId, input.config.appId)
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    const nextCredentialResult = await input.resolver.get(input.identity)
    if (!nextCredentialResult.ok) {
      return {
        ok: false,
        status: 503,
        error: 'FIRST_PARTY_CREDENTIALS_UNAVAILABLE',
        body: '',
      }
    }
    credentials = nextCredentialResult.credentials
    cacheHit = nextCredentialResult.cacheHit
    attempt = await sendAttempt(input, credentials)
  }

  // Still propagating after the backoff sequence: retryable, NOT a generic
  // auth failure. The 5s negative cache plus this hint drives the caller.
  if (isRotationAuthFailure(attempt)) {
    return {
      ok: false,
      status: 503,
      error: 'CMS_KEY_PROPAGATING',
      body: '',
      kid: credentials.kid,
      cacheHit,
      retryAfterMs: KEY_PROPAGATING_RETRY_AFTER_MS,
    }
  }

  return toResult(attempt, credentials, cacheHit)
}

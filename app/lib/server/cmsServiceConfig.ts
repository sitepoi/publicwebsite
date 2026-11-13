/**
 * First-party service authentication — GLOBAL configuration (runtime-fetch
 * mode). These variables are deployment-wide, never per tenant:
 *
 *   CMS_SERVICE_APP_ID                 (default "publicwebsite")
 *   CMS_SERVICE_ISSUER                 required
 *   CMS_SERVICE_AUDIENCE               required
 *   CMS_SERVICE_SECRET_API_BASE_URL    required (Secret API origin)
 *   CMS_SERVICE_SECRET_TOKEN           required (server-only bearer token)
 *   CMS_SERVICE_TOKEN_TTL_SECONDS      default 60
 *   CMS_SERVICE_SECRET_CACHE_SECONDS   default 300
 *   CMS_SERVICE_SECRET_FETCH_TIMEOUT_MS default 5000
 *   CMS_SERVICE_CMS_FETCH_TIMEOUT_MS   default 10000
 *
 * HARD RULES:
 * - Never prefix any of these with NEXT_PUBLIC_.
 * - CMS_SERVICE_KEY_ID / CMS_SERVICE_PRIVATE_KEY are NOT part of this mode
 *   (they are single-tenant manual-deployment credentials only).
 * - Absent required values = the feature is unavailable; callers fail closed
 *   with FIRST_PARTY_CREDENTIALS_UNAVAILABLE (never an unauthenticated CMS
 *   call, never a shared fallback key).
 */

export interface CmsServiceConfig {
  appId: string
  issuer: string
  audience: string
  secretApiBaseUrl: string
  secretToken: string
  tokenTtlSeconds: number
  secretCacheSeconds: number
  secretFetchTimeoutMs: number
  cmsFetchTimeoutMs: number
}

export type CmsServiceEnv = Record<string, string | undefined>

export const DEFAULT_CMS_SERVICE_APP_ID = 'publicwebsite'
export const DEFAULT_TOKEN_TTL_SECONDS = 60
export const DEFAULT_SECRET_CACHE_SECONDS = 300
export const DEFAULT_SECRET_FETCH_TIMEOUT_MS = 5_000
export const DEFAULT_CMS_FETCH_TIMEOUT_MS = 10_000

/** Required keys — every one of them must be present and non-empty. */
export const CMS_SERVICE_REQUIRED_ENV_KEYS = [
  'CMS_SERVICE_ISSUER',
  'CMS_SERVICE_AUDIENCE',
  'CMS_SERVICE_SECRET_API_BASE_URL',
  'CMS_SERVICE_SECRET_TOKEN',
] as const

export type CmsServiceConfigResult =
  { ok: true; config: CmsServiceConfig } | { ok: false; missing: string[] }

function readTrimmed(env: CmsServiceEnv, name: string): string {
  return (env[name] ?? '').trim()
}

function readPositiveInt(env: CmsServiceEnv, name: string, fallback: number): number {
  const raw = readTrimmed(env, name)
  if (raw.length === 0) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Resolve the global first-party service configuration. Fails closed: missing
 * or invalid values are reported as a list of env keys, never guessed.
 */
export function resolveCmsServiceConfig(env: CmsServiceEnv = process.env): CmsServiceConfigResult {
  const missing: string[] = []
  for (const key of CMS_SERVICE_REQUIRED_ENV_KEYS) {
    if (readTrimmed(env, key).length === 0) missing.push(key)
  }

  const secretApiBaseUrl = readTrimmed(env, 'CMS_SERVICE_SECRET_API_BASE_URL').replace(/\/+$/, '')
  if (secretApiBaseUrl.length > 0 && !isHttpsUrl(secretApiBaseUrl)) {
    missing.push('CMS_SERVICE_SECRET_API_BASE_URL')
  }

  if (missing.length > 0) return { ok: false, missing }

  return {
    ok: true,
    config: {
      appId: readTrimmed(env, 'CMS_SERVICE_APP_ID') || DEFAULT_CMS_SERVICE_APP_ID,
      issuer: readTrimmed(env, 'CMS_SERVICE_ISSUER'),
      audience: readTrimmed(env, 'CMS_SERVICE_AUDIENCE'),
      secretApiBaseUrl,
      secretToken: readTrimmed(env, 'CMS_SERVICE_SECRET_TOKEN'),
      tokenTtlSeconds: readPositiveInt(
        env,
        'CMS_SERVICE_TOKEN_TTL_SECONDS',
        DEFAULT_TOKEN_TTL_SECONDS,
      ),
      secretCacheSeconds: readPositiveInt(
        env,
        'CMS_SERVICE_SECRET_CACHE_SECONDS',
        DEFAULT_SECRET_CACHE_SECONDS,
      ),
      secretFetchTimeoutMs: readPositiveInt(
        env,
        'CMS_SERVICE_SECRET_FETCH_TIMEOUT_MS',
        DEFAULT_SECRET_FETCH_TIMEOUT_MS,
      ),
      cmsFetchTimeoutMs: readPositiveInt(
        env,
        'CMS_SERVICE_CMS_FETCH_TIMEOUT_MS',
        DEFAULT_CMS_FETCH_TIMEOUT_MS,
      ),
    },
  }
}

/** True when runtime-fetch first-party auth is fully configured. */
export function isCmsServiceConfigured(env: CmsServiceEnv = process.env): boolean {
  return resolveCmsServiceConfig(env).ok
}

/**
 * Per-tenant first-party CMS credentials — RUNTIME FETCH (server-only).
 *
 * The publicwebsite is a shared multi-tenant runtime: one deployment serves
 * many domains/tenants and each tenant has its OWN first-party key pair.
 * Domains are routing aliases, never credentials. The tenant is always
 * resolved from the trusted host/site mapping by the caller; browser-supplied
 * tenant ids/headers are ignored by construction (this module never reads a
 * request).
 *
 * Flow per tenant:
 *   1. GET ${CMS_SERVICE_SECRET_API_BASE_URL}/api/v1/first-party/runtime-secret
 *        ?tenantId=<resolved>&appId=<CMS_SERVICE_APP_ID>
 *      Authorization: Bearer <CMS_SERVICE_SECRET_TOKEN>
 *   2. Validate the payload (ok, tenantId, appId, kid, alg, issuer, audience,
 *      https cmsBaseUrl, PKCS#8 private key PEM).
 *   3. Cache the credentials in SERVER MEMORY ONLY, TTL
 *      CMS_SERVICE_SECRET_CACHE_SECONDS (default 300), single-flight on a
 *      cold cache, short negative cache on failures.
 *
 * HARD RULES:
 * - Never write the private key to disk, logs, analytics or browser storage.
 * - Never return the private key from a route response.
 * - Never fall back to a shared key or an unauthenticated CMS call.
 */

import {
  resolveCmsServiceConfig,
  type CmsServiceConfig,
  type CmsServiceEnv,
} from './cmsServiceConfig'
import type { CmsServiceAlg } from './cmsServiceToken'
import { defaultSecretApiTransport, type SecretApiTransport } from './secretApiTransport'

export type { CmsServiceAlg }

/** Identifiers the CALLER derived server-side from the trusted host/site map. */
export interface FirstPartyTenantIdentity {
  tenantId: string
  siteId: string
  deploymentId: string
}

/** Validated runtime-secret payload (private key included — server only). */
export interface FirstPartyRuntimeSecret {
  tenantId: string
  appId: string
  kid: string
  alg: CmsServiceAlg
  issuer: string
  audience: string
  cmsBaseUrl: string
  privateKeyPem: string
}

export interface FirstPartyCredentials extends FirstPartyRuntimeSecret {
  siteId: string
  deploymentId: string
}

export type FirstPartyCredentialErrorCode = 'FIRST_PARTY_CREDENTIALS_UNAVAILABLE'

export type FirstPartyCredentialResult =
  | {
      ok: true
      credentials: FirstPartyCredentials
      cacheHit: boolean
      fetchedAt: number
    }
  | {
      ok: false
      error: FirstPartyCredentialErrorCode
      missing?: string[]
      reason?: string
    }

export interface FirstPartyCredentialResolverOptions {
  env?: CmsServiceEnv
  /** Secret API transport — node:https by default (global fetch is FORBIDDEN:
   * undici adds sec-fetch-mode: cors, which the Secret API rejects with 403). */
  transport?: SecretApiTransport
  /** Injectable clock (milliseconds) — TTL and fetchedAt use it. */
  now?: () => number
  /** Negative cache window for failures (default 5s, never long). */
  negativeCacheMs?: number
}

export interface FirstPartyCredentialResolver {
  get(identity: FirstPartyTenantIdentity): Promise<FirstPartyCredentialResult>
  invalidate(tenantId: string, appId?: string): void
  clear(): void
}

/** Safe metadata ONLY — never includes privateKeyPem or the bearer token. */
export interface FirstPartyCredentialMetadata {
  tenantId: string
  siteId: string
  kid: string
  alg: CmsServiceAlg
  issuer: string
  audience: string
  cmsBaseUrl: string
  cacheHit: boolean
  fetchedAt: number
}

export const DEFAULT_NEGATIVE_CACHE_MS = 5_000
export const RUNTIME_SECRET_PATH = '/api/v1/first-party/runtime-secret'

type RuntimeSecretValidation =
  { ok: true; value: FirstPartyRuntimeSecret } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate a runtime-secret response against the resolved identity and the
 * global service config. Any mismatch fails closed with a stable reason code.
 */
export function validateRuntimeSecret(
  payload: unknown,
  expected: { tenantId: string; appId: string; issuer: string; audience: string },
): RuntimeSecretValidation {
  if (!isRecord(payload)) return { ok: false, reason: 'invalid-payload' }
  if (payload['ok'] !== true) return { ok: false, reason: 'ok-false' }
  if (payload['tenantId'] !== expected.tenantId) return { ok: false, reason: 'tenant-mismatch' }
  if (payload['appId'] !== expected.appId) return { ok: false, reason: 'app-mismatch' }

  const kid = payload['kid']
  if (typeof kid !== 'string' || kid.trim().length === 0)
    return { ok: false, reason: 'kid-missing' }

  const alg = payload['alg']
  if (alg !== 'RS256' && alg !== 'ES256') return { ok: false, reason: 'alg-unsupported' }

  const issuer = payload['issuer']
  if (typeof issuer !== 'string' || issuer !== expected.issuer) {
    return { ok: false, reason: 'issuer-mismatch' }
  }

  const audience = payload['audience']
  if (typeof audience !== 'string' || audience !== expected.audience) {
    return { ok: false, reason: 'audience-mismatch' }
  }

  const cmsBaseUrl = payload['cmsBaseUrl']
  if (typeof cmsBaseUrl !== 'string' || !isHttpsUrl(cmsBaseUrl)) {
    return { ok: false, reason: 'cms-base-url-invalid' }
  }

  const privateKeyPem = payload['privateKeyPem']
  if (
    typeof privateKeyPem !== 'string' ||
    !privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')
  ) {
    return { ok: false, reason: 'private-key-invalid' }
  }

  return {
    ok: true,
    value: {
      tenantId: expected.tenantId,
      appId: expected.appId,
      kid,
      alg,
      issuer,
      audience,
      cmsBaseUrl: cmsBaseUrl.replace(/\/+$/, ''),
      privateKeyPem,
    },
  }
}

interface CacheEntry {
  credentials: FirstPartyCredentials
  expiresAt: number
  fetchedAt: number
}

interface NegativeEntry {
  expiresAt: number
  missing?: string[]
  reason?: string
}

function baseCacheKey(tenantId: string, appId: string): string {
  return `${tenantId}:${appId}`
}

/** Cache identity is tenantId + appId + kid (rotation creates a new entry). */
function kidCacheKey(baseKey: string, kid: string): string {
  return `${baseKey}:${kid}`
}

/**
 * Create an isolated credential resolver (tests inject their own transport and
 * clock; the production singleton uses the global store below).
 */
export function createFirstPartyCredentialResolver(
  options: FirstPartyCredentialResolverOptions = {},
): FirstPartyCredentialResolver {
  const env = options.env ?? process.env
  const transport = options.transport ?? defaultSecretApiTransport
  const now = options.now ?? Date.now
  const negativeCacheMs = options.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS

  /** Keyed by tenantId:appId:kid — the CMS-confirmed cache identity. */
  const cache = new Map<string, CacheEntry>()
  /** tenantId:appId → the kid currently cached for that tenant. */
  const currentKid = new Map<string, string>()
  const negativeCache = new Map<string, NegativeEntry>()
  const inFlight = new Map<string, Promise<FirstPartyCredentialResult>>()

  function unavailable(
    extra: { missing?: string[]; reason?: string } = {},
  ): FirstPartyCredentialResult {
    return { ok: false, error: 'FIRST_PARTY_CREDENTIALS_UNAVAILABLE', ...extra }
  }

  async function fetchCredentials(
    identity: FirstPartyTenantIdentity,
    config: CmsServiceConfig,
  ): Promise<FirstPartyCredentialResult> {
    const baseKey = baseCacheKey(identity.tenantId, config.appId)
    const url = new URL(`${config.secretApiBaseUrl}${RUNTIME_SECRET_PATH}`)
    url.searchParams.set('tenantId', identity.tenantId)
    url.searchParams.set('appId', config.appId)

    // node:https transport — NOT global fetch (undici adds sec-fetch-mode:
    // cors, which the Secret API rejects with 403).
    let response: Awaited<ReturnType<SecretApiTransport>>
    try {
      response = await transport({
        url: url.toString(),
        headers: {
          authorization: `Bearer ${config.secretToken}`,
          accept: 'application/json',
        },
        timeoutMs: config.secretFetchTimeoutMs,
      })
    } catch {
      negativeCache.set(baseKey, {
        expiresAt: now() + negativeCacheMs,
        reason: 'secret-api-unreachable',
      })
      return unavailable({ reason: 'secret-api-unreachable' })
    }

    if (response.status < 200 || response.status >= 300) {
      // 401/403/404/500 are all the same to the caller: fail closed, safe error.
      negativeCache.set(baseKey, {
        expiresAt: now() + negativeCacheMs,
        reason: `secret-api-status-${response.status}`,
      })
      return unavailable({ reason: `secret-api-status-${response.status}` })
    }

    let payload: unknown
    try {
      payload = JSON.parse(response.body) as unknown
    } catch {
      negativeCache.set(baseKey, {
        expiresAt: now() + negativeCacheMs,
        reason: 'secret-api-invalid-json',
      })
      return unavailable({ reason: 'secret-api-invalid-json' })
    }

    const validated = validateRuntimeSecret(payload, {
      tenantId: identity.tenantId,
      appId: config.appId,
      issuer: config.issuer,
      audience: config.audience,
    })
    if (!validated.ok) {
      negativeCache.set(baseKey, { expiresAt: now() + negativeCacheMs, reason: validated.reason })
      return unavailable({ reason: validated.reason })
    }

    const fetchedAt = now()
    const credentials: FirstPartyCredentials = {
      ...validated.value,
      siteId: identity.siteId,
      deploymentId: identity.deploymentId,
    }
    cache.set(kidCacheKey(baseKey, validated.value.kid), {
      credentials,
      fetchedAt,
      expiresAt: fetchedAt + config.secretCacheSeconds * 1000,
    })
    currentKid.set(baseKey, validated.value.kid)
    negativeCache.delete(baseKey)
    return { ok: true, credentials, cacheHit: false, fetchedAt }
  }

  async function get(identity: FirstPartyTenantIdentity): Promise<FirstPartyCredentialResult> {
    // The caller MUST pass a server-resolved identity. A missing tenant id is
    // a programming error, not a browser input — fail closed.
    if (!identity.tenantId) return unavailable({ reason: 'tenant-not-resolved' })

    const configResult = resolveCmsServiceConfig(env)
    if (!configResult.ok) return unavailable({ missing: configResult.missing })
    const config = configResult.config
    const baseKey = baseCacheKey(identity.tenantId, config.appId)
    const kid = currentKid.get(baseKey)
    const cached = kid ? cache.get(kidCacheKey(baseKey, kid)) : undefined
    if (cached && cached.expiresAt > now()) {
      return {
        ok: true,
        credentials: cached.credentials,
        cacheHit: true,
        fetchedAt: cached.fetchedAt,
      }
    }
    if (cached && kid) {
      cache.delete(kidCacheKey(baseKey, kid))
      currentKid.delete(baseKey)
    }

    const negative = negativeCache.get(baseKey)
    if (negative && negative.expiresAt > now()) {
      return unavailable({ missing: negative.missing, reason: negative.reason })
    }
    if (negative) negativeCache.delete(baseKey)

    const pending = inFlight.get(baseKey)
    if (pending) return pending

    const request = fetchCredentials(identity, config).finally(() => {
      inFlight.delete(baseKey)
    })
    inFlight.set(baseKey, request)
    return request
  }

  function invalidate(tenantId: string, appId?: string): void {
    const configResult = resolveCmsServiceConfig(env)
    const effectiveAppId = appId ?? (configResult.ok ? configResult.config.appId : 'publicwebsite')
    const baseKey = baseCacheKey(tenantId, effectiveAppId)
    currentKid.delete(baseKey)
    // Drop every kid-scoped entry for this tenant+app (rotation).
    const prefix = `${baseKey}:`
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) cache.delete(key)
    }
    negativeCache.delete(baseKey)
    inFlight.delete(baseKey)
  }

  function clear(): void {
    cache.clear()
    currentKid.clear()
    negativeCache.clear()
    inFlight.clear()
  }

  return { get, invalidate, clear }
}

interface CmsCredentialGlobalStore {
  resolver?: FirstPartyCredentialResolver
}

const CREDENTIALS_GLOBAL_KEY = Symbol.for('gw.cmsFirstPartyCredentials')

function globalStore(): CmsCredentialGlobalStore {
  const target = globalThis as unknown as Record<symbol, CmsCredentialGlobalStore | undefined>
  const existing = target[CREDENTIALS_GLOBAL_KEY]
  if (existing) return existing
  const created: CmsCredentialGlobalStore = {}
  target[CREDENTIALS_GLOBAL_KEY] = created
  return created
}

/**
 * Process-wide resolver. Kept on globalThis because Next/Turbopack can load
 * route-handler and RSC module graphs as separate instances — a module-level
 * singleton would fragment the cache (repo lesson from C9).
 */
export function getFirstPartyCredentialResolver(): FirstPartyCredentialResolver {
  const store = globalStore()
  if (!store.resolver) store.resolver = createFirstPartyCredentialResolver()
  return store.resolver
}

/** Invalidate one tenant's cached key (rotation / UNKNOWN_KEY recovery). */
export function invalidateFirstPartyCredentials(tenantId: string, appId?: string): void {
  getFirstPartyCredentialResolver().invalidate(tenantId, appId)
}

/** Safe metadata for debug/telemetry — never the private key or token. */
export function toFirstPartyCredentialMetadata(
  credentials: FirstPartyCredentials,
  meta: { cacheHit: boolean; fetchedAt: number },
): FirstPartyCredentialMetadata {
  return {
    tenantId: credentials.tenantId,
    siteId: credentials.siteId,
    kid: credentials.kid,
    alg: credentials.alg,
    issuer: credentials.issuer,
    audience: credentials.audience,
    cmsBaseUrl: credentials.cmsBaseUrl,
    cacheHit: meta.cacheHit,
    fetchedAt: meta.fetchedAt,
  }
}

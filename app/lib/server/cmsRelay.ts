/**
 * Same-origin CMS v2 relay (server-only) — /api/cms/objects/...
 *
 * Browser/widget calls land here. The relay:
 *   1. resolves the site + tenant from the TRUSTED host mapping (never from a
 *      browser-supplied tenant id/header/query parameter),
 *   2. enforces the site-level object-type allowlist,
 *   3. rate-limits per site and per hashed IP,
 *   4. reads the tenant's credentials from the Secret API (cached) and mints a
 *      fresh service JWT per attempt (lib/server/cmsServiceFetch.ts),
 *   5. forwards ONLY the sanitized JSON body + Idempotency-Key to the tenant's
 *      cmsBaseUrl, adds x-unicon-write-source on public writes,
 *   6. caches published reads for 30-60s, never caches writes or tokens,
 *   7. returns safe errors — never the token, private key, bearer token or
 *      internal CMS detail.
 *
 * DELETE is never allowed.
 */

import { randomUUID } from 'node:crypto'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import { hashIp } from '@/lib/security/guards'
import { getLogger } from '@/lib/log/logger'
import { resolveCmsServiceConfig } from './cmsServiceConfig'
import {
  getFirstPartyCredentialResolver,
  type FirstPartyCredentialResolver,
  type FirstPartyTenantIdentity,
} from './cmsFirstPartyCredentials'
import { callCmsService, readCmsErrorInfo } from './cmsServiceFetch'

export const CMS_RELAY_READ_CACHE_TTL_MS = 45_000
export const CMS_RELAY_BODY_LIMIT_BYTES = 256 * 1024
export const CMS_RELAY_SITE_RATE_MAX = 300
export const CMS_RELAY_IP_RATE_MAX = 120
export const CMS_RELAY_RATE_WINDOW_MS = 60_000
/** Server-to-server audit marker (CMS: omit or send a stable marker, never a
 * fake visitor email). Widget writes keep the session email / anon marker. */
export const CMS_SERVICE_REQUEST_EMAIL = 'service:publicwebsite'
/** CMS does not set Retry-After on 429 — the relay suggests its own backoff. */
export const CMS_RELAY_DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000
/** Stable publicwebsite-owned CAS message (never forward the CMS message). */
export const CAS_CONFLICT_MESSAGE = 'Object version conflict. Re-read the object and retry.'

/** Structural request shape (NextRequest conforms) — keeps the handler testable. */
export interface CmsRelayRequest {
  method: string
  nextUrl: { pathname: string; search?: string }
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface CmsRelaySite {
  ok: boolean
  tenantId: string
  siteId: string
  /** Site-level allowlist (websiteConfig.cmsRelayObjectTypes). */
  allowedObjectTypes: string[]
}

export interface CmsRelayLogEntry {
  requestId: string
  tenantId: string
  siteId: string
  appId: string
  kid?: string
  operation: string
  objectType: string
  status: number
  durationMs: number
  cacheHit: boolean
  /** Safe CMS error code on failures only (never tokens/keys/messages). */
  errorCode?: string
  /** PERMISSION_DENIED details remain SERVER-SIDE only (never in responses). */
  requiredLevel?: string
  heldLevel?: string
  /** Key names/counts of the CMS success body (never values). */
  responseShape?: Record<string, unknown>
}

export interface CmsReadCacheEntry {
  status: number
  body: string
  contentType: string
  expiresAt: number
}

export interface CmsReadCache {
  get(key: string): CmsReadCacheEntry | undefined
  set(key: string, entry: CmsReadCacheEntry): void
}

export interface CmsRelayDeps {
  env?: Record<string, string | undefined>
  fetchFn?: typeof fetch
  resolveSite?: (host: string) => Promise<CmsRelaySite>
  credentialResolver?: FirstPartyCredentialResolver
  siteRateLimiter?: RateLimiter
  ipRateLimiter?: RateLimiter
  readCache?: CmsReadCache
  now?: () => number
  log?: (entry: CmsRelayLogEntry) => void
  /** Short exponential backoff for key propagation (tests pass []). */
  retryDelaysMs?: number[]
}

/** Browser-facing success contract: CMS success:true -> ok:true (data kept). */
export function toRelaySuccessBody(cmsBody: string): string {
  try {
    const parsed = JSON.parse(cmsBody) as unknown
    if (isRecord(parsed) && parsed['success'] === true) {
      const rest: Record<string, unknown> = { ...parsed }
      delete rest['success']
      return JSON.stringify({ ok: true, ...rest })
    }
  } catch {
    /* non-JSON: pass through */
  }
  return cmsBody
}

/**
 * Response SHAPE summary for server logs — key names and counts only, never
 * values. This is how an empty `{ fields: {} }` is distinguished from a
 * populated object without logging tenant data.
 */
export function summarizeCmsBodyShape(bodyText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (!isRecord(parsed)) {
      return { bodyType: Array.isArray(parsed) ? 'array' : typeof parsed }
    }
    const shape: Record<string, unknown> = { responseKeys: Object.keys(parsed).slice(0, 20) }
    const single = parsed['object']
    if (isRecord(single)) {
      shape['objectKeys'] = Object.keys(single).slice(0, 20)
      const fields = single['fields']
      if (isRecord(fields)) shape['objectFieldsKeyCount'] = Object.keys(fields).length
    }
    const list = parsed['objects']
    if (Array.isArray(list)) {
      shape['objectCount'] = list.length
      const first = list[0]
      if (isRecord(first)) {
        shape['firstObjectKeys'] = Object.keys(first).slice(0, 20)
        const fields = first['fields']
        if (isRecord(fields)) shape['firstObjectFieldsKeyCount'] = Object.keys(fields).length
      }
    }
    const topFields = parsed['fields']
    if (isRecord(topFields)) shape['topLevelFieldsKeyCount'] = Object.keys(topFields).length
    if (typeof parsed['count'] === 'number') shape['count'] = parsed['count']
    return shape
  } catch {
    return { bodyType: 'non-json' }
  }
}

export type CmsRelayOperation = 'read-list' | 'read-one' | 'query' | 'create' | 'update'

export interface CmsRelayRoute {
  operation: CmsRelayOperation
  method: 'GET' | 'POST' | 'PATCH' | 'PUT'
  type: string
  id?: string
}

/**
 * Map a relay pathname + method to an operation:
 *   GET  /objects/{type}          → read-list
 *   GET  /objects/{type}/{id}     → read-one
 *   POST /objects/{type}/query    → query
 *   POST /objects/{type}          → create
 *   PATCH|PUT /objects/{type}/{id}→ update
 */
export function resolveCmsRelayRoute(method: string, pathname: string): CmsRelayRoute | null {
  const segments = pathname
    .replace(/^\/api\/cms\/objects\/?/, '')
    .split('/')
    .filter((segment) => segment.length > 0)

  if (segments.length < 1 || segments.length > 2) return null
  const type = segments[0]
  if (!type) return null
  const second = segments[1]

  if (!second) {
    if (method === 'GET') return { operation: 'read-list', method: 'GET', type }
    if (method === 'POST') return { operation: 'create', method: 'POST', type }
    return null
  }

  if (second === 'query') {
    return method === 'POST' ? { operation: 'query', method: 'POST', type } : null
  }

  if (method === 'GET') return { operation: 'read-one', method: 'GET', type, id: second }
  if (method === 'PATCH') return { operation: 'update', method: 'PATCH', type, id: second }
  if (method === 'PUT') return { operation: 'update', method: 'PUT', type, id: second }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeObjectType(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

/**
 * Identity / audit fields a visitor can never set through the relay. The CMS
 * re-applies its own protection; this is defence in depth.
 */
export const RELAY_STRIPPED_FIELDS = [
  'id',
  '_id',
  'permissions',
  'rules',
  '_platformDefault',
  'tenantId',
  'created',
  'lastUpdated',
  'lastUpdatedBy',
  'lastUpdatedOnClient',
  'lastSaveSessionId',
  'lastSaveSeq',
  '_writeSource',
  'requestEmail',
] as const

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>
}

function stripFields(target: Record<string, unknown>): void {
  for (const field of RELAY_STRIPPED_FIELDS) delete target[field]
}

/** Strip identity/audit fields from an object payload (and its `data` bag). */
export function sanitizePublicWritePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = cloneRecord(payload)
  stripFields(sanitized)
  if (isRecord(sanitized['data'])) stripFields(sanitized['data'])
  return sanitized
}

/** CMS v2 query operators (confirmed contract). */
export const CMS_QUERY_OPERATORS = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'array-contains',
  'in',
  'array-contains-any',
  'not-in',
] as const

const CMS_QUERY_OPERATOR_SET = new Set<string>(CMS_QUERY_OPERATORS)
const CMS_QUERY_ARRAY_OPERATORS = new Set(['in', 'array-contains-any', 'not-in'])
export const CMS_QUERY_DEFAULT_LIMIT = 100
export const CMS_QUERY_MAX_LIMIT = 200
export const CMS_QUERY_MAX_ARRAY_VALUES = 10

export interface CmsQueryItem {
  field: string
  operator: string
  value: unknown
}

export interface CmsQueryPayload {
  queryItems: CmsQueryItem[]
  limit: number
}

export type CmsQueryValidation =
  { ok: true; value: CmsQueryPayload } | { ok: false; reason: string }

/**
 * Strict CMS v2 query body — ONLY `{ queryItems, limit }` (confirmed
 * contract; arbitrary JSON is never forwarded). Default limit 100, max 200;
 * `in` / `array-contains-any` / `not-in` need an array of 1-10 values.
 */
export function validateCmsQueryPayload(payload: Record<string, unknown>): CmsQueryValidation {
  for (const key of Object.keys(payload)) {
    if (key !== 'queryItems' && key !== 'limit') return { ok: false, reason: 'unknown-field' }
  }

  const rawItems = payload['queryItems']
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    return { ok: false, reason: 'queryItems-not-array' }
  }

  const items: CmsQueryItem[] = []
  for (const raw of (rawItems as unknown[] | undefined) ?? []) {
    if (!isRecord(raw)) return { ok: false, reason: 'query-item-invalid' }
    const field = raw['field']
    const operator = raw['operator']
    if (typeof field !== 'string' || field.length === 0)
      return { ok: false, reason: 'field-missing' }
    if (typeof operator !== 'string' || !CMS_QUERY_OPERATOR_SET.has(operator)) {
      return { ok: false, reason: 'operator-invalid' }
    }
    if (!('value' in raw)) return { ok: false, reason: 'value-missing' }
    const value = raw['value']
    if (CMS_QUERY_ARRAY_OPERATORS.has(operator)) {
      if (!Array.isArray(value) || value.length < 1 || value.length > CMS_QUERY_MAX_ARRAY_VALUES) {
        return { ok: false, reason: 'value-array-invalid' }
      }
    }
    items.push({ field, operator, value })
  }

  const rawLimit = payload['limit']
  let limit = CMS_QUERY_DEFAULT_LIMIT
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > CMS_QUERY_MAX_LIMIT
    ) {
      return { ok: false, reason: 'limit-invalid' }
    }
    limit = rawLimit
  }

  return { ok: true, value: { queryItems: items, limit } }
}

/**
 * Build the CMS write envelope:
 *   { object: {...}, folder?, version?, requestEmail? }
 * `folder` and `requestEmail` stay TOP-LEVEL (confirmed contract), never
 * inside `object`. requestEmail is only accepted from the server caller.
 * Numeric `version` (CAS) survives on PATCH/PUT only.
 */
export function normalizePublicWritePayload(
  payload: Record<string, unknown>,
  method: 'POST' | 'PATCH' | 'PUT',
  requestEmail?: string,
): Record<string, unknown> {
  const objectSource = isRecord(payload['object'])
    ? payload['object']
    : (() => {
        const extracted = cloneRecord(payload)
        delete extracted['object']
        delete extracted['folder']
        delete extracted['requestEmail']
        delete extracted['version']
        return extracted
      })()

  const out: Record<string, unknown> = { object: sanitizePublicWritePayload(objectSource) }

  const folder = payload['folder']
  if (isRecord(folder)) {
    const safeFolder: Record<string, unknown> = {}
    if (typeof folder['name'] === 'string') safeFolder['name'] = folder['name']
    if (Array.isArray(folder['tree'])) safeFolder['tree'] = folder['tree']
    if (Object.keys(safeFolder).length > 0) out['folder'] = safeFolder
  }

  if (method !== 'POST' && typeof payload['version'] === 'number') {
    out['version'] = payload['version']
  }
  if (requestEmail) out['requestEmail'] = requestEmail
  return out
}

/** Map a CMS failure to a SAFE browser error code (nested CMS error shape). */
export function mapCmsFailure(status: number, body: string): { status: number; error: string } {
  const code = readCmsErrorInfo(body).code

  if (status === 400) {
    return {
      status: 400,
      error:
        code === 'OBJECT_TYPE_NOT_ALLOWED' ? 'OBJECT_TYPE_NOT_ALLOWED' : 'CMS_REQUEST_REJECTED',
    }
  }
  if (status === 401) return { status: 403, error: 'CMS_AUTH_FAILED' }
  if (status === 403) {
    if (code === 'FOLDER_NOT_ALLOWED') return { status: 403, error: 'FOLDER_NOT_ALLOWED' }
    if (code === 'OBJECT_TYPE_NOT_ALLOWED') return { status: 403, error: 'OBJECT_TYPE_NOT_ALLOWED' }
    if (code === 'PUBLIC_WRITE_OWNERSHIP') return { status: 403, error: 'PUBLIC_WRITE_OWNERSHIP' }
    if (code !== undefined && code.includes('PRIVATE_OBJECT_TYPE')) {
      return { status: 403, error: 'PRIVATE_OBJECT_TYPE_BLOCKED' }
    }
    // MISSING_SCOPE, PERMISSION_DENIED and other permission refusals.
    return { status: 403, error: 'CMS_AUTH_FAILED' }
  }
  if (status === 404) return { status: 404, error: 'CMS_OBJECT_NOT_FOUND' }
  if (status === 409) return { status: 409, error: 'CAS_CONFLICT' }
  if (status === 429) return { status: 429, error: 'CMS_RATE_LIMITED' }
  return { status: 502, error: 'CMS_UNAVAILABLE' }
}

/** Create a bounded read cache (LRU-ish: oldest key evicted at capacity). */
export function createCmsReadCache(maxEntries = 200): CmsReadCache {
  const entries = new Map<string, CmsReadCacheEntry>()
  return {
    get(key) {
      return entries.get(key)
    },
    set(key, entry) {
      if (entries.size >= maxEntries && !entries.has(key)) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      entries.set(key, entry)
    },
  }
}

/** Default site resolution: server-side resolver stack (trusted host only). */
async function defaultResolveSite(host: string): Promise<CmsRelaySite> {
  try {
    const { getResolverStack } = await import('@/lib/resolver')
    const result = await getResolverStack().resolveSite(host)
    if (!result.ok) return { ok: false, tenantId: '', siteId: '', allowedObjectTypes: [] }
    return {
      ok: true,
      tenantId: result.site.tenant.tenantId,
      siteId: result.site.folderId,
      allowedObjectTypes: result.site.settings.cmsRelayObjectTypes ?? [],
    }
  } catch {
    return { ok: false, tenantId: '', siteId: '', allowedObjectTypes: [] }
  }
}

interface CmsRelayGlobalStore {
  siteLimiter?: RateLimiter
  ipLimiter?: RateLimiter
  readCache?: CmsReadCache
}

const CMS_RELAY_GLOBAL_KEY = Symbol.for('gw.cmsRelay')

function relayGlobalStore(): CmsRelayGlobalStore {
  const target = globalThis as unknown as Record<symbol, CmsRelayGlobalStore | undefined>
  const existing = target[CMS_RELAY_GLOBAL_KEY]
  if (existing) return existing
  const created: CmsRelayGlobalStore = {}
  target[CMS_RELAY_GLOBAL_KEY] = created
  return created
}

function defaultSiteLimiter(): RateLimiter {
  const store = relayGlobalStore()
  if (!store.siteLimiter) {
    store.siteLimiter = createMemoryRateLimiter({
      max: CMS_RELAY_SITE_RATE_MAX,
      windowMs: CMS_RELAY_RATE_WINDOW_MS,
    })
  }
  return store.siteLimiter
}

function defaultIpLimiter(): RateLimiter {
  const store = relayGlobalStore()
  if (!store.ipLimiter) {
    store.ipLimiter = createMemoryRateLimiter({
      max: CMS_RELAY_IP_RATE_MAX,
      windowMs: CMS_RELAY_RATE_WINDOW_MS,
    })
  }
  return store.ipLimiter
}

function defaultReadCache(): CmsReadCache {
  const store = relayGlobalStore()
  if (!store.readCache) store.readCache = createCmsReadCache()
  return store.readCache
}

function defaultLog(entry: CmsRelayLogEntry): void {
  getLogger().info(entry, 'cms-relay')
}

function clientIp(request: CmsRelayRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const candidate = forwarded ? forwarded.split(',')[0]?.trim() : ''
  return candidate || 'local'
}

/** Drop identity parameters a browser could try to smuggle to the CMS. */
export function sanitizeReadSearch(search: string): string {
  if (!search) return ''
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.delete('tenantId')
  params.delete('tenant')
  params.delete('appId')
  const text = params.toString()
  return text ? `?${text}` : ''
}

function json(
  body: Record<string, unknown>,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export async function handleCmsRelay(
  request: CmsRelayRequest,
  deps: CmsRelayDeps = {},
): Promise<Response> {
  if (request.method === 'DELETE') return json({ ok: false, error: 'CMS_DELETE_NOT_ALLOWED' }, 403)

  const route = resolveCmsRelayRoute(request.method, request.nextUrl.pathname)
  if (!route) return json({ ok: false, error: 'CMS_ROUTE_NOT_FOUND' }, 404)

  const now = deps.now ?? Date.now
  const startedAt = now()
  const requestId = request.headers.get('x-request-id') ?? randomUUID()
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const log = deps.log ?? defaultLog

  const site = await (deps.resolveSite ?? defaultResolveSite)(host)
  if (!site.ok) {
    log({
      requestId,
      tenantId: '',
      siteId: '',
      appId: '',
      operation: route.operation,
      objectType: route.type,
      status: 404,
      errorCode: 'SITE_NOT_FOUND',
      durationMs: now() - startedAt,
      cacheHit: false,
    })
    return json({ ok: false, error: 'SITE_NOT_FOUND' }, 404)
  }

  let appId = ''
  let kid: string | undefined
  const routeOperation = route.operation
  const routeObjectType = route.type

  function respond(
    status: number,
    body: Record<string, unknown>,
    extra: { cacheHit?: boolean; details?: Record<string, unknown> } = {},
    headers?: Record<string, string>,
  ): Response {
    log({
      requestId,
      tenantId: site.tenantId,
      siteId: site.siteId,
      appId,
      kid,
      operation: routeOperation,
      objectType: routeObjectType,
      status,
      ...(status >= 400 && typeof body.error === 'string' ? { errorCode: body.error } : {}),
      ...(extra.details ?? {}),
      durationMs: now() - startedAt,
      cacheHit: extra.cacheHit ?? false,
    })
    return json(body, status, headers)
  }

  if (!isSafeObjectType(route.type)) {
    return respond(
      400,
      { ok: false, error: 'OBJECT_TYPE_NOT_ALLOWED' },
      { details: { reason: 'unsafe-type' } },
    )
  }
  if (!site.allowedObjectTypes.includes(route.type)) {
    return respond(
      400,
      { ok: false, error: 'OBJECT_TYPE_NOT_ALLOWED' },
      { details: { reason: 'site-allowlist', allowedTypeCount: site.allowedObjectTypes.length } },
    )
  }

  const siteLimiter = deps.siteRateLimiter ?? defaultSiteLimiter()
  const siteRate = siteLimiter.check(`site:${site.tenantId}`)
  if (!siteRate.allowed) {
    return respond(429, {
      ok: false,
      error: 'RATE_LIMITED',
      retryAfterMs: siteRate.retryAfterMs ?? 0,
    })
  }

  const ipLimiter = deps.ipRateLimiter ?? defaultIpLimiter()
  const relaySecret = (deps.env ?? process.env)['RELAY_SECRET'] ?? ''
  const ipRate = ipLimiter.check(`ip:${hashIp(clientIp(request), relaySecret)}`)
  if (!ipRate.allowed) {
    return respond(429, {
      ok: false,
      error: 'RATE_LIMITED',
      retryAfterMs: ipRate.retryAfterMs ?? 0,
    })
  }

  const configResult = resolveCmsServiceConfig(deps.env ?? process.env)
  if (!configResult.ok) {
    return respond(503, { ok: false, error: 'FIRST_PARTY_CREDENTIALS_UNAVAILABLE' })
  }
  const config = configResult.config
  appId = config.appId

  const identity: FirstPartyTenantIdentity = {
    tenantId: site.tenantId,
    siteId: site.siteId,
    // The platform has no separate deployment id today: the site folder id is
    // the stable server-derived site identity.
    deploymentId: site.siteId,
  }

  const isRead = route.operation === 'read-list' || route.operation === 'read-one'
  const readCache = deps.readCache ?? defaultReadCache()
  const safeSearch = sanitizeReadSearch(request.nextUrl.search ?? '')
  const cacheKey = `${site.tenantId}|${request.nextUrl.pathname}|${safeSearch}`

  if (isRead) {
    const cached = readCache.get(cacheKey)
    if (cached && cached.expiresAt > now()) {
      log({
        requestId,
        tenantId: site.tenantId,
        siteId: site.siteId,
        appId,
        operation: route.operation,
        objectType: route.type,
        status: cached.status,
        durationMs: now() - startedAt,
        cacheHit: true,
      })
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          'content-type': cached.contentType,
          'cache-control': 'private, max-age=30',
          'x-gw-cache': 'hit',
        },
      })
    }
  }

  let bodyText: string | undefined
  if (route.method !== 'GET') {
    const raw = await request.text()
    if (raw.length > CMS_RELAY_BODY_LIMIT_BYTES) {
      return respond(413, { ok: false, error: 'PAYLOAD_TOO_LARGE' })
    }
    if (raw.trim().length > 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return respond(400, { ok: false, error: 'INVALID_JSON' })
      }
      if (!isRecord(parsed)) return respond(400, { ok: false, error: 'INVALID_JSON' })
      if (route.operation === 'query') {
        const query = validateCmsQueryPayload(parsed)
        if (!query.ok) return respond(400, { ok: false, error: 'INVALID_QUERY' })
        bodyText = JSON.stringify(query.value)
      } else {
        bodyText = JSON.stringify(
          normalizePublicWritePayload(
            parsed,
            route.method === 'PUT' ? 'PUT' : route.method === 'PATCH' ? 'PATCH' : 'POST',
            CMS_SERVICE_REQUEST_EMAIL,
          ),
        )
      }
    }
  }

  const encodedType = encodeURIComponent(route.type)
  const encodedId = route.id ? `/${encodeURIComponent(route.id)}` : ''
  const querySuffix = route.operation === 'query' ? '/query' : ''
  const searchSuffix = route.method === 'GET' ? safeSearch : ''
  const cmsPath = `/objects/${encodedType}${encodedId}${querySuffix}${searchSuffix}`

  const result = await callCmsService({
    method: route.method,
    cmsPath,
    body: bodyText,
    identity,
    config,
    resolver: deps.credentialResolver ?? getFirstPartyCredentialResolver(),
    fetchFn: deps.fetchFn ?? fetch,
    idempotencyKey:
      route.operation === 'create'
        ? (request.headers.get('Idempotency-Key') ?? undefined)
        : undefined,
    writeSource: route.operation === 'create' || route.operation === 'update',
    retryDelaysMs: deps.retryDelaysMs,
  })

  if (!result.ok) {
    kid = result.kid
    const headers: Record<string, string> = {}
    const failureBody: Record<string, unknown> = { ok: false, error: result.error }
    if (result.retryAfterMs !== undefined) {
      failureBody['retryAfterMs'] = result.retryAfterMs
      headers['retry-after'] = String(Math.ceil(result.retryAfterMs / 1000))
    }
    return respond(result.status, failureBody, { cacheHit: result.cacheHit }, headers)
  }
  kid = result.kid

  if (result.status >= 400) {
    const mapped = mapCmsFailure(result.status, result.body)
    const info = readCmsErrorInfo(result.body)
    const headers: Record<string, string> = { ...(result.rateLimitHeaders ?? {}) }
    const errorBody: Record<string, unknown> = { ok: false, error: mapped.error }
    if (mapped.status === 429) {
      // Confirmed contract: minute rate is retryable, monthly quota is NOT.
      const isMonthlyQuota = info.code === 'MONTHLY_QUOTA_EXCEEDED'
      errorBody['reason'] = isMonthlyQuota ? 'monthly_quota' : 'minute_rate'
      if (isMonthlyQuota) {
        errorBody['retryAfterMs'] = null
      } else {
        const retryAfterMs = result.retryAfterMs ?? CMS_RELAY_DEFAULT_RATE_LIMIT_BACKOFF_MS
        errorBody['retryAfterMs'] = retryAfterMs
        headers['retry-after'] = String(Math.ceil(retryAfterMs / 1000))
      }
    }
    if (mapped.error === 'CAS_CONFLICT') {
      const serverVersion = info.details?.['serverVersion']
      if (typeof serverVersion === 'number' || typeof serverVersion === 'string') {
        errorBody['serverVersion'] = serverVersion
      }
      errorBody['message'] = CAS_CONFLICT_MESSAGE
    }
    log({
      requestId,
      tenantId: site.tenantId,
      siteId: site.siteId,
      appId,
      kid,
      operation: route.operation,
      objectType: route.type,
      status: mapped.status,
      durationMs: now() - startedAt,
      cacheHit: result.cacheHit,
      errorCode: mapped.error,
      ...(info.code === 'PERMISSION_DENIED'
        ? {
            ...(typeof info.details?.['requiredLevel'] === 'string'
              ? { requiredLevel: info.details['requiredLevel'] }
              : {}),
            ...(typeof info.details?.['heldLevel'] === 'string'
              ? { heldLevel: info.details['heldLevel'] }
              : {}),
          }
        : {}),
    })
    return json(errorBody, mapped.status, headers)
  }

  const contentType = 'application/json; charset=utf-8'
  const successBody = toRelaySuccessBody(result.body)
  if (isRead) {
    readCache.set(cacheKey, {
      status: result.status,
      body: successBody,
      contentType,
      expiresAt: now() + CMS_RELAY_READ_CACHE_TTL_MS,
    })
  }
  const responseShape = isRead ? summarizeCmsBodyShape(successBody) : undefined

  log({
    requestId,
    tenantId: site.tenantId,
    siteId: site.siteId,
    appId,
    kid,
    operation: route.operation,
    objectType: route.type,
    status: result.status,
    durationMs: now() - startedAt,
    cacheHit: result.cacheHit,
    ...(responseShape ? { responseShape } : {}),
  })

  return new Response(successBody, {
    status: result.status,
    headers: {
      'content-type': contentType,
      'cache-control': isRead ? 'private, max-age=30' : 'no-store',
      'x-gw-cache': isRead ? 'miss' : 'off',
      ...(result.rateLimitHeaders ?? {}),
    },
  })
}

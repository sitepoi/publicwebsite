import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import { getLogger, newRequestId } from '@/lib/log/logger'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import {
  CMS_SETTINGS_DOC_ID,
  CmsSettingsDocSchema,
  AppDefinitionSchema,
} from '@/lib/contracts/app-config'
import { DataQueryRequestSchema, type DataQueryResult } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import {
  createMemoryRateLimiter,
  createMemoryCache,
  type RateLimiter,
  type MemoryCache,
} from '@/lib/cache/memory'
import { readField } from '@/lib/data/common'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * POST /api/data/query (Section 29) — the generic GET fabric for embedded
 * tools. Server-enforced (Section 32 / C7):
 *  - publicAccess ('no' types are blocked)
 *  - parentTenants (unknown types allowed only when the tenant inherits)
 *  - language filter (meta.language)
 *  - per-IP rate limit (hashed) + memory cache
 *  - per-record privacy (rules.publicAccess === 'no' is server-filtered)
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DATA_QUERY_RATE_MAX = 120
export const DATA_QUERY_RATE_WINDOW_MS = 60_000
export const DATA_QUERY_CACHE_TTL_MS = 30_000

export interface TypeAccess {
  publicAccess?: 'yes' | 'no'
  registered: boolean
}

export interface DataQueryDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  loadTypeAccess?: (
    provider: DataProvider,
    tenant: TenantConfig,
    cmsObjectType: string,
  ) => Promise<TypeAccess>
  rateLimiter?: RateLimiter
  cache?: MemoryCache<DataQueryResult>
  trafficRules?: TrafficRules
}

/** Type-level publicAccess from the app's cms-settings.objectTypes entry. */
export async function loadTypeAccess(
  provider: DataProvider,
  _tenant: TenantConfig,
  cmsObjectType: string,
): Promise<TypeAccess> {
  const docs = await provider.getSettings([CMS_SETTINGS_DOC_ID])
  const parsed = docs[0] ? CmsSettingsDocSchema.safeParse(docs[0]) : undefined
  const entry = (parsed?.success ? (parsed.data.objectTypes ?? []) : [])
    .map((raw) => AppDefinitionSchema.safeParse(raw))
    .find((result) => result.success && result.data.id === cmsObjectType)
  if (!entry) return { registered: false }
  const publicAccess = entry.data?.rules?.publicAccess
  return { registered: true, publicAccess: publicAccess === 'no' ? 'no' : 'yes' }
}

function filterByLanguage(items: ObjectRecord[], language: string | undefined): ObjectRecord[] {
  if (!language) return items
  return items.filter((record) => {
    const recordLanguage = readField(record, 'meta.language')
    return recordLanguage === undefined || recordLanguage === language
  })
}

function excludePrivateRecords(items: ObjectRecord[]): ObjectRecord[] {
  return items.filter((record) => readField(record, 'rules.publicAccess') !== 'no')
}

/** One structured line per data-API outcome (silent under vitest). */
function logDataApi(
  level: 'info' | 'warn',
  event: string,
  context: Record<string, unknown>,
): void {
  if (process.env.NODE_ENV === 'test') return
  const logger = getLogger()
  if (level === 'warn') logger.warn(context, event)
  else logger.info(context, event)
}

export async function handleDataQuery(
  request: Request,
  deps: DataQueryDeps = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  const startedAt = Date.now()
  const requestId = request.headers.get('x-request-id') ?? newRequestId()
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const url = new URL(request.url)
  const logOutcome = (status: number, details: Record<string, unknown> = {}): void => {
    logDataApi(status >= 400 ? 'warn' : 'info', 'data-api-query', {
      requestId,
      method: request.method,
      path: url.pathname,
      host,
      status,
      durationMs: Date.now() - startedAt,
      ...details,
    })
  }

  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    logOutcome(403, { error: 'blocked', reason: 'traffic-rules' })
    return json({ error: 'blocked' }, 403)
  }

  const limiter = deps.rateLimiter ?? sharedLimiter()
  const rate = limiter.check(`data:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed) {
    logOutcome(429, { error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 })
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)
  }

  const parsed = DataQueryRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    logOutcome(400, {
      error: 'invalid-query',
      issueCount: parsed.error.issues.length,
      firstIssue: firstIssue
        ? `${firstIssue.path.join('.') || '(root)'}: ${firstIssue.message}`
        : undefined,
    })
    return json({ error: 'invalid-query' }, 400)
  }
  const query = parsed.data

  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) {
    logOutcome(404, { error: 'site-not-found' })
    return json({ error: 'site-not-found' }, 404)
  }
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )

  // Server-enforced type access (Section 32).
  const access = await (deps.loadTypeAccess ?? loadTypeAccess)(
    provider,
    site.tenant,
    query.cmsObjectType,
  )
  const scope = {
    tenantId: site.tenant.tenantId,
    siteId: site.folderId,
    cmsObjectType: query.cmsObjectType,
    typeRegistered: access.registered,
    typePublicAccess: access.publicAccess ?? 'unset',
  }
  if (access.publicAccess === 'no') {
    logOutcome(403, { ...scope, error: 'type-blocked' })
    return json({ error: 'type-blocked' }, 403)
  }
  if (!access.registered && !site.tenant.parentTenants?.length) {
    logOutcome(404, { ...scope, error: 'type-not-found' })
    return json({ error: 'type-not-found' }, 404)
  }

  // Memory cache (short TTL) — keyed by host + query.
  const cache = deps.cache ?? sharedCache()
  const cacheKey = `${site.host}|${JSON.stringify(query)}`
  const cached = cache.get(cacheKey)
  if (cached) {
    logOutcome(200, {
      ...scope,
      cacheHit: true,
      itemCount: cached.items.length,
      total: cached.total,
    })
    return json(cached)
  }

  let result: DataQueryResult
  try {
    result = await provider.queryObjects(query)
  } catch (error) {
    logOutcome(500, {
      ...scope,
      error: 'query-failed',
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  const items = excludePrivateRecords(filterByLanguage(result.items, query.language))
  const response: DataQueryResult = { ...result, items }

  cache.set(cacheKey, response)
  logOutcome(200, {
    ...scope,
    cacheHit: false,
    itemCount: items.length,
    total: result.total,
    language: query.language,
    filterCount: query.filters?.length ?? 0,
    folderCount: query.folders?.length ?? (query.folder ? 1 : 0),
  })
  return json(response)
}

let limiterSingleton: RateLimiter | null = null
let cacheSingleton: MemoryCache<DataQueryResult> | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: DATA_QUERY_RATE_MAX,
      windowMs: DATA_QUERY_RATE_WINDOW_MS,
    })
  }
  return limiterSingleton
}

function sharedCache(): MemoryCache<DataQueryResult> {
  if (!cacheSingleton) cacheSingleton = createMemoryCache({ ttlMs: DATA_QUERY_CACHE_TTL_MS })
  return cacheSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(request: Request): Promise<Response> {
  return handleDataQuery(request)
}

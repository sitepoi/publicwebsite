import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { SearchQuerySchema } from '@/lib/contracts/services'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import {
  createMemoryCache,
  createMemoryRateLimiter,
  type MemoryCache,
  type RateLimiter,
} from '@/lib/cache/memory'
import { readField, searchItems } from '@/lib/data/common'
import { loadTypeAccess } from '@/app/api/data/query/route'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * GET /api/search?type=&folder=&q=&lang=&limit= (Section 15) — server fuse.js
 * over PUBLIC objects only (private types blocked, private records excluded,
 * language filtered), memory-cached per query.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const SEARCH_RATE_MAX = 60
export const SEARCH_RATE_WINDOW_MS = 60_000
export const SEARCH_CACHE_TTL_MS = 60_000
export const SEARCH_FETCH_LIMIT = 200

export interface SearchDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  rateLimiter?: RateLimiter
  cache?: MemoryCache<{ items: ObjectRecord[] }>
  trafficRules?: TrafficRules
}

export async function handleSearch(request: Request, deps: SearchDeps = {}): Promise<Response> {
  const env = deps.env ?? getEnv()
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  const url = new URL(request.url)
  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    return json({ error: 'blocked' }, 403)
  }

  const limiter = deps.rateLimiter ?? sharedLimiter()
  const rate = limiter.check(`search:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const params = Object.fromEntries(url.searchParams.entries())
  const parsed = SearchQuerySchema.safeParse(params)
  if (!parsed.success) return json({ error: 'invalid-search-query' }, 400)
  const query = parsed.data

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )

  const access = await loadTypeAccess(provider, site.tenant, query.type)
  if (access.publicAccess === 'no') return json({ error: 'type-blocked' }, 403)
  if (!access.registered && !site.tenant.parentTenants?.length) {
    return json({ error: 'type-not-found' }, 404)
  }

  const cache = deps.cache ?? sharedCache()
  const cacheKey = `${site.host}|${JSON.stringify(query)}`
  const cached = cache.get(cacheKey)
  if (cached) return json({ items: cached.items, total: cached.items.length })

  const fetched = await provider.queryObjects({
    cmsObjectType: query.type,
    ...(query.folder !== undefined ? { folder: query.folder } : {}),
    pageSize: SEARCH_FETCH_LIMIT,
  })

  // Public records only + language filter (Section 32 / C7 semantics).
  let candidates = fetched.items.filter(
    (record) => readField(record, 'rules.publicAccess') !== 'no',
  )
  if (query.lang) {
    candidates = candidates.filter((record) => {
      const recordLanguage = readField(record, 'meta.language')
      return recordLanguage === undefined || recordLanguage === query.lang
    })
  }

  const ranked = searchItems(candidates, query.q)
  const items = ranked.slice(0, query.limit)
  cache.set(cacheKey, { items })
  return json({ items, total: items.length })
}

let limiterSingleton: RateLimiter | null = null
let cacheSingleton: MemoryCache<{ items: ObjectRecord[] }> | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: SEARCH_RATE_MAX,
      windowMs: SEARCH_RATE_WINDOW_MS,
    })
  }
  return limiterSingleton
}

function sharedCache(): MemoryCache<{ items: ObjectRecord[] }> {
  if (!cacheSingleton) {
    cacheSingleton = createMemoryCache<{ items: ObjectRecord[] }>({ ttlMs: SEARCH_CACHE_TTL_MS })
  }
  return cacheSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleSearch(request)
}

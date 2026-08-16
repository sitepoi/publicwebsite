import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import { readField } from '@/lib/data/common'
import type { SiteResolution } from '@/lib/resolver/site'
import { loadTypeAccess, type TypeAccess } from '../../query/route'

/**
 * GET /api/data/{cmsObjectType}/{objectId} (Section 29) — object detail.
 * Same server enforcement as the query fabric: rate limit, type publicAccess,
 * per-record privacy.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export interface DataDetailDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  loadTypeAccess?: (
    provider: DataProvider,
    tenant: TenantConfig,
    cmsObjectType: string,
  ) => Promise<TypeAccess>
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
}

export async function handleDataDetail(
  request: Request,
  cmsObjectType: string,
  objectId: string,
  deps: DataDetailDeps = {},
): Promise<Response> {
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
  const rate = limiter.check(`data:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )

  const access = await (deps.loadTypeAccess ?? loadTypeAccess)(provider, site.tenant, cmsObjectType)
  if (access.publicAccess === 'no') return json({ error: 'type-blocked' }, 403)
  if (!access.registered && !site.tenant.parentTenants?.length) {
    return json({ error: 'type-not-found' }, 404)
  }

  const record = await provider.getObject({ type: cmsObjectType, id: objectId })
  if (!record || readField(record, 'rules.publicAccess') === 'no') {
    return json({ error: 'not-found' }, 404)
  }
  return json(record)
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({ max: 120, windowMs: 60_000 })
  }
  return limiterSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ type: string; id: string }> },
): Promise<Response> {
  const { type, id } = await context.params
  return handleDataDetail(request, type, id)
}

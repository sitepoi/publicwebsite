import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import { getLogger, newRequestId } from '@/lib/log/logger'
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

  const startedAt = Date.now()
  const requestId = request.headers.get('x-request-id') ?? newRequestId()
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const url = new URL(request.url)
  const logOutcome = (status: number, details: Record<string, unknown> = {}): void => {
    if (process.env.NODE_ENV === 'test') return
    const context = {
      requestId,
      method: request.method,
      path: url.pathname,
      host,
      status,
      durationMs: Date.now() - startedAt,
      ...details,
    }
    if (status >= 400) getLogger().warn(context, 'data-api-detail')
    else getLogger().info(context, 'data-api-detail')
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

  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) {
    logOutcome(404, { error: 'site-not-found', cmsObjectType, objectId })
    return json({ error: 'site-not-found' }, 404)
  }
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )

  const access = await (deps.loadTypeAccess ?? loadTypeAccess)(provider, site.tenant, cmsObjectType)
  const scope = {
    tenantId: site.tenant.tenantId,
    siteId: site.folderId,
    cmsObjectType,
    objectId,
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

  let record
  try {
    record = await provider.getObject({ type: cmsObjectType, id: objectId })
  } catch (error) {
    logOutcome(500, {
      ...scope,
      error: 'read-failed',
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  if (!record) {
    logOutcome(404, { ...scope, error: 'not-found' })
    return json({ error: 'not-found' }, 404)
  }
  if (readField(record, 'rules.publicAccess') === 'no') {
    logOutcome(404, { ...scope, error: 'not-found', reason: 'record-private' })
    return json({ error: 'not-found' }, 404)
  }
  logOutcome(200, {
    ...scope,
    // Shape only (key names/counts, never values): an empty {fields:{}} or a
    // record whose payload sits under another key is visible at a glance.
    recordKeys: Object.keys(record).slice(0, 20),
    dataKeys:
      typeof record['data'] === 'object' && record['data'] !== null
        ? Object.keys(record['data'] as Record<string, unknown>).slice(0, 20)
        : undefined,
    fieldsKeyCount:
      typeof record['fields'] === 'object' && record['fields'] !== null
        ? Object.keys(record['fields'] as Record<string, unknown>).length
        : undefined,
  })
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

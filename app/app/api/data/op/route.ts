import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { OperationCallSchema } from '@/lib/contracts/operations'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import {
  executeOperation,
  type OperationActor,
  type OperationHookRunner,
} from '@/lib/render/operations'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * POST /api/data/op (Section 29 WRITE / Section 30) — the ONLY set path.
 * Vertical tools send { operation, payload }; the CMS-defined operation
 * supplies validation/permission/formulas/writes/hooks server-side. Guards:
 * traffic rules, hashed-IP rate limit, honeypot (gw_hp), optional reCAPTCHA
 * for anonymous callers, idempotency via Idempotency-Key header or payload
 * key (Section 33). NO raw client writes anywhere.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DATA_OP_RATE_MAX = 60
export const DATA_OP_RATE_WINDOW_MS = 60_000

export interface DataOpDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  getActor?: () => OperationActor
  hooks?: OperationHookRunner
}

export async function handleDataOp(request: Request, deps: DataOpDeps = {}): Promise<Response> {
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
  const rate = limiter.check(`op:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const parsed = OperationCallSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-operation-call' }, 400)
  const call = parsed.data

  // Honeypot (Section 32 — anonymous operations).
  if (call.gw_hp && call.gw_hp.trim().length > 0) return json({ ok: true, result: null })

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const actor = (deps.getActor ?? (() => ({ roles: [] })))()

  // Optional reCAPTCHA for anonymous callers when the folder enables it.
  const recaptchaConfig = site.settings.webSettings as unknown as {
    recaptcha?: { enabled?: boolean | string }
  }
  const captchaEnabled =
    recaptchaConfig?.recaptcha?.enabled === true || recaptchaConfig?.recaptcha?.enabled === 'yes'
  if (captchaEnabled && actor.roles.length === 0) {
    const token = call.payload['g-recaptcha-response']
    if (typeof token !== 'string' || token.length === 0) {
      return json({ error: 'captcha-required' }, 400)
    }
  }

  const idempotencyKey = request.headers.get('idempotency-key') ?? call.idempotencyKey ?? undefined

  const result = await executeOperation({
    provider,
    site,
    operationId: call.operation,
    payload: call.payload,
    actor,
    idempotencyKey,
    hooks: deps.hooks,
  })

  if (!result.ok) {
    return json({ error: result.error, errors: result.errors ?? [] }, result.status)
  }
  return json({ ok: true, result: result.result, idempotent: result.idempotent === true })
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: DATA_OP_RATE_MAX,
      windowMs: DATA_OP_RATE_WINDOW_MS,
    })
  }
  return limiterSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(request: Request): Promise<Response> {
  return handleDataOp(request)
}

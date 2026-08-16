import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { FlowCallSchema } from '@/lib/contracts/flows'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import type { OperationActor, OperationHookRunner } from '@/lib/render/operations'
import {
  advanceFlow,
  completeFlow,
  FLOW_COOKIE_PREFIX,
  loadFlowDefinition,
  loadFlowState,
  sessionKeyOf,
  startFlow,
} from '@/lib/render/flows'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * POST /api/flow/[flowId] (Section 31) — declarative business flows.
 * One route dispatches on the strict `action` field:
 *
 *   { action: 'start' }          → { ok, flowStateId, step } + session cookie
 *   { action: 'step', values }   → { ok, flowStateId, nextStep } | { errors }
 *   { action: 'complete' }       → { ok, result: { operations, paymentIntent } }
 *
 * Draft state is SERVER-side (dedicated flow-states collection, ADR-008);
 * the client only holds the opaque flowStateId in an httpOnly cookie
 * (`gw-flow-<sessionKey>`). All writes go through the C7 operations engine.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const FLOW_RATE_MAX = 60
export const FLOW_RATE_WINDOW_MS = 60_000
export const FLOW_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60

export interface FlowDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  getActor?: () => OperationActor
  hooks?: OperationHookRunner
  now?: () => Date
}

export async function handleFlow(
  request: Request,
  flowId: string,
  deps: FlowDeps = {},
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
  const rate = limiter.check(`flow:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const parsed = FlowCallSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-flow-call' }, 400)
  const call = parsed.data

  // Honeypot (Section 32 — anonymous flows).
  if (call.gw_hp && call.gw_hp.trim().length > 0) return json({ ok: true, result: null })

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const actor = (deps.getActor ?? (() => ({ roles: [] })))()

  const definition = await loadFlowDefinition(provider, site, flowId)
  if (!definition) return json({ error: 'flow-not-found' }, 404)

  const sessionKey = sessionKeyOf(definition, flowId)
  const cookieName = `${FLOW_COOKIE_PREFIX}${sessionKey}`
  const cookieValue = readCookie(request.headers.get('cookie'), cookieName)

  switch (call.action) {
    case 'start': {
      const result = await startFlow({ provider, site, definition, flowId, now: deps.now })
      if (!result.ok) return json({ error: result.error }, result.status)
      if (result.kind !== 'started') return json({ error: 'flow-not-found' }, 404)
      const response = json({ ok: true, flowStateId: result.flowStateId, step: result.step })
      response.headers.set(
        'Set-Cookie',
        buildCookie(cookieName, result.flowStateId, FLOW_COOKIE_MAX_AGE_SECONDS),
      )
      return response
    }

    case 'step': {
      const flowStateId = call.flowStateId ?? cookieValue
      if (!flowStateId) return json({ error: 'flow-state-required' }, 400)
      const state = await loadFlowState(provider, site, flowStateId)
      if (!state) return json({ error: 'flow-state-not-found' }, 404)
      const result = await advanceFlow({
        provider,
        site,
        definition,
        state,
        values: call.values,
        now: deps.now,
      })
      if (!result.ok) {
        return json({ error: result.error, errors: result.errors ?? [] }, result.status)
      }
      if (result.kind !== 'advanced') return json({ error: 'flow-not-found' }, 404)
      return json({ ok: true, flowStateId: result.flowStateId, nextStep: result.nextStep })
    }

    case 'complete': {
      const flowStateId = call.flowStateId ?? cookieValue
      if (!flowStateId) return json({ error: 'flow-state-required' }, 400)

      // Optional reCAPTCHA for anonymous callers when the folder enables it.
      const recaptchaConfig = site.settings.webSettings as unknown as {
        recaptcha?: { enabled?: boolean | string }
      }
      const captchaEnabled =
        recaptchaConfig?.recaptcha?.enabled === true ||
        recaptchaConfig?.recaptcha?.enabled === 'yes'
      if (captchaEnabled && actor.roles.length === 0) {
        return json({ error: 'captcha-required' }, 400)
      }

      const state = await loadFlowState(provider, site, flowStateId)
      if (!state) return json({ error: 'flow-state-not-found' }, 404)
      const result = await completeFlow({
        provider,
        site,
        definition,
        state,
        actor,
        hooks: deps.hooks,
        now: deps.now,
      })
      if (!result.ok) {
        return json({ error: result.error, errors: result.errors ?? [] }, result.status)
      }
      if (result.kind !== 'completed') return json({ error: 'flow-not-found' }, 404)
      const response = json({ ok: true, flowStateId, result: result.result })
      // Single-shot per session key: clear the cookie so a new flow can start.
      response.headers.set('Set-Cookie', buildCookie(cookieName, '', 0))
      return response
    }
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ flowId: string }> },
): Promise<Response> {
  const { flowId } = await context.params
  return handleFlow(request, flowId)
}

// ------------------------------------------------------------------- helpers

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: FLOW_RATE_MAX,
      windowMs: FLOW_RATE_WINDOW_MS,
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

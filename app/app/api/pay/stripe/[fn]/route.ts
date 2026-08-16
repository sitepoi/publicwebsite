import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { PayConfirmSchema, PayIntentCreateSchema } from '@/lib/contracts/services'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import { getStripeService, type StripeService } from '@/lib/pay'
import { computePaymentIntent, loadFlowDefinition, loadFlowState } from '@/lib/render/flows'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * /api/pay/stripe/[fn] (Section 15 / C10):
 *
 *   POST intent  { flowStateId } → PaymentIntent (amount ALWAYS computed
 *                server-side from the flow's amountFormula — never from the
 *                client). Returns the clientSecret for the frontend SDK.
 *   POST confirm { paymentIntentId } → server-side status check, updates
 *                order/invoice objects (paymentStatus) on success.
 *   POST webhook Stripe event → SIGNATURE-VERIFIED; payment_intent.succeeded
 *                / payment_failed update order/invoice objects.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PAY_RATE_MAX = 20
export const PAY_RATE_WINDOW_MS = 60_000
export const PAYMENT_INTENTS_COLLECTION = 'payment-intents'

const PAYMENT_FNS = ['intent', 'confirm', 'webhook'] as const
type PayFn = (typeof PAYMENT_FNS)[number]

export interface PayDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  stripeService?: StripeService
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  now?: () => Date
}

export async function handlePay(
  request: Request,
  fn: string,
  deps: PayDeps = {},
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

  if (!PAYMENT_FNS.includes(fn as PayFn)) return json({ error: 'pay-fn-not-found' }, 404)

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const extension = site.tenant.tableExtension ?? ''

  if (fn === 'webhook') {
    return handleWebhook(request, provider, extension, deps, site.tenant.tenantId)
  }

  const limiter = deps.rateLimiter ?? sharedLimiter()
  const rate = limiter.check(`pay:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const stripeService = deps.stripeService ?? tryStripeService(site.tenant.tenantId)
  if (!stripeService) return json({ error: 'stripe-not-configured' }, 503)

  if (fn === 'intent') {
    const parsed = PayIntentCreateSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return json({ error: 'invalid-pay-call' }, 400)

    // Amount is computed SERVER-side from the flow state (hard rule).
    const state = await loadFlowState(provider, site, parsed.data.flowStateId)
    if (!state) return json({ error: 'flow-state-not-found' }, 404)
    const definition = await loadFlowDefinition(provider, site, state.flowId)
    if (!definition) return json({ error: 'flow-not-found' }, 404)

    let amountStub
    try {
      amountStub = computePaymentIntent(definition, state)
    } catch {
      return json({ error: 'amount-formula-failed' }, 400)
    }
    if (!amountStub) return json({ error: 'flow-has-no-payment-step' }, 400)

    const amountMinor = Math.round(amountStub.amount * 100)
    const intent = await stripeService.createPaymentIntent({
      amount: amountMinor,
      currency: amountStub.currency,
      metadata: { flowStateId: parsed.data.flowStateId },
    })

    await provider.createRecord({
      collection: `${PAYMENT_INTENTS_COLLECTION}${extension}`,
      id: intent.id,
      data: {
        id: intent.id,
        flowStateId: parsed.data.flowStateId,
        amount: amountStub.amount,
        amountMinor,
        currency: amountStub.currency,
        status: intent.status,
        createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      },
    })

    return json({
      ok: true,
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
      amount: amountStub.amount,
      currency: amountStub.currency,
    })
  }

  // fn === 'confirm'
  const parsed = PayConfirmSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-pay-call' }, 400)
  const intent = await stripeService.retrievePaymentIntent(parsed.data.paymentIntentId)
  const status = intent.status === 'succeeded' ? 'paid' : intent.status
  if (intent.status === 'succeeded') {
    await updatePaymentRecords(provider, extension, intent.id, 'paid')
  }
  await updateIntentRecord(provider, extension, intent.id, intent.status)
  return json({ ok: true, status, paymentIntentId: intent.id })
}

async function handleWebhook(
  request: Request,
  provider: DataProvider,
  extension: string,
  deps: PayDeps,
  tenantId: string,
): Promise<Response> {
  const stripeService = deps.stripeService ?? tryStripeService(tenantId)
  if (!stripeService) return json({ error: 'stripe-not-configured' }, 503)

  const rawBody = await request.text().catch(() => '')
  const signature = request.headers.get('stripe-signature') ?? ''
  let event
  try {
    event = await stripeService.constructWebhookEvent(rawBody, signature)
  } catch {
    return json({ error: 'invalid-signature' }, 400)
  }

  const intentId = event.data.object.id
  if (event.type === 'payment_intent.succeeded') {
    await updatePaymentRecords(provider, extension, intentId, 'paid')
    await updateIntentRecord(provider, extension, intentId, 'succeeded')
  } else if (event.type === 'payment_intent.payment_failed') {
    await updatePaymentRecords(provider, extension, intentId, 'failed')
    await updateIntentRecord(provider, extension, intentId, 'failed')
  }
  return json({ received: true, type: event.type })
}

/** Order/invoice records link to the intent via `paymentIntentId`. */
const PAYMENT_RECORD_TYPES = ['orders', 'invoices']

export async function updatePaymentRecords(
  provider: DataProvider,
  extension: string,
  paymentIntentId: string,
  paymentStatus: 'paid' | 'failed',
): Promise<void> {
  for (const resource of PAYMENT_RECORD_TYPES) {
    const collection = `${resource}${extension}`
    const records = await provider.queryRecords({
      collection,
      filters: [{ field: 'paymentIntentId', op: '==', value: paymentIntentId }],
      limit: 50,
    })
    for (const record of records) {
      const id = typeof record['id'] === 'string' ? record['id'] : undefined
      if (!id) continue
      await provider.updateRecord({ collection, id, data: { paymentStatus } })
    }
  }
}

async function updateIntentRecord(
  provider: DataProvider,
  extension: string,
  intentId: string,
  status: string,
): Promise<void> {
  await provider.updateRecord({
    collection: `${PAYMENT_INTENTS_COLLECTION}${extension}`,
    id: intentId,
    data: { status },
  })
}

function tryStripeService(tenantId: string): StripeService | null {
  try {
    return getStripeService(tenantId)
  } catch {
    return null
  }
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({ max: PAY_RATE_MAX, windowMs: PAY_RATE_WINDOW_MS })
  }
  return limiterSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ fn: string }> },
): Promise<Response> {
  const { fn } = await context.params
  return handlePay(request, fn)
}

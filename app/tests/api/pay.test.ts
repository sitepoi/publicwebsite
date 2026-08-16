import { describe, expect, it } from 'vitest'
import { handlePay } from '@/app/api/pay/stripe/[fn]/route'
import type { StripeService, StripeIntent, StripeWebhookEvent } from '@/lib/pay'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { FlowDefinition } from '@/lib/contracts/flows'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()

function flowObject(definition: FlowDefinition): ObjectRecord {
  return {
    id: `flow-${definition.flowId}`,
    slug: `flow-${definition.flowId}`,
    cmsObjectType: site.appId,
    typeId: site.folderId,
    data: definition,
  }
}

const paymentFlow: FlowDefinition = {
  flowId: 'checkout',
  steps: [
    { id: 'cart', validationRules: [{ field: 'total', rule: 'min', value: 1 }] },
    { id: 'delivery', validationRules: [{ field: 'fee', rule: 'required' }] },
    { id: 'payment', paymentProvider: 'stripe', amountFormula: 'cart.total + delivery.fee' },
    { id: 'done', hooks: [] },
  ],
  session: 'cart',
}

function createFakeStripe() {
  const events: Array<{ rawBody: string; signature: string }> = []
  const intents = new Map<string, StripeIntent>()
  let nextEvent: StripeWebhookEvent | Error = {
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_fake', metadata: { flowStateId: 'fs-1' } } },
  }
  const service: StripeService = {
    name: 'stripe',
    createPaymentIntent: async (input) => {
      const intent: StripeIntent = {
        id: `pi_${intents.size + 1}`,
        clientSecret: `pi_${intents.size + 1}_secret_x`,
        amount: input.amount,
        currency: input.currency,
        status: 'requires_payment_method',
        metadata: input.metadata,
      }
      intents.set(intent.id, intent)
      return intent
    },
    retrievePaymentIntent: async (id) => {
      const intent = intents.get(id)
      if (!intent) throw new Error('intent-not-found')
      return intent
    },
    constructWebhookEvent: async (rawBody, signature) => {
      events.push({ rawBody, signature })
      if (nextEvent instanceof Error) throw nextEvent
      return nextEvent
    },
  }
  return {
    service,
    intents,
    events,
    markSucceeded: (id: string) => {
      const intent = intents.get(id)
      if (intent) intent.status = 'succeeded'
    },
    failNextWebhook: () => {
      nextEvent = new Error('invalid signature')
    },
  }
}

async function seedFlowState(store: ReturnType<typeof createStoreProvider>, id: string) {
  await store.provider.createRecord({
    collection: 'flow-states',
    id,
    data: {
      id,
      flowId: 'checkout',
      sessionKey: 'cart',
      stepIndex: 3,
      currentStep: 'done',
      steps: { cart: { total: 10 }, delivery: { fee: 5 } },
      status: 'in-progress',
    },
  })
}

function payDeps(
  store: ReturnType<typeof createStoreProvider>,
  stripe: ReturnType<typeof createFakeStripe>,
) {
  return {
    env: dataEnv,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    stripeService: stripe.service,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
  }
}

function makeRequest(fn: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://site-a.test/api/pay/stripe/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('POST /api/pay/stripe (Section 15 / C10)', () => {
  it('creates a PaymentIntent with the amount computed SERVER-side from the flow', async () => {
    const store = createStoreProvider({ objects: [flowObject(paymentFlow)] })
    await seedFlowState(store, 'fs-1')
    const stripe = createFakeStripe()

    const response = await handlePay(
      makeRequest('intent', { flowStateId: 'fs-1' }),
      'intent',
      payDeps(store, stripe),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      paymentIntentId: string
      clientSecret: string
      amount: number
      currency: string
    }
    expect(body.amount).toBe(15) // cart.total 10 + delivery.fee 5
    expect(body.currency).toBe('usd')
    expect(body.clientSecret).toContain('_secret_')

    // Amount in MINOR units (cents) + metadata link to the flow state.
    const intent = stripe.intents.get(body.paymentIntentId)
    expect(intent?.amount).toBe(1500)
    expect(intent?.metadata).toEqual({ flowStateId: 'fs-1' })

    // Server records the intent for later reconciliation.
    const stored = await store.provider.getRecord({
      collection: 'payment-intents',
      id: body.paymentIntentId,
    })
    expect(stored).toMatchObject({ flowStateId: 'fs-1', amountMinor: 1500 })
  })

  it('rejects amounts from the client (strict schema) and missing flows', async () => {
    const store = createStoreProvider({ objects: [flowObject(paymentFlow)] })
    const stripe = createFakeStripe()
    const deps = payDeps(store, stripe)

    const clientAmount = await handlePay(
      makeRequest('intent', { flowStateId: 'fs-1', amount: 1 }),
      'intent',
      deps,
    )
    expect(clientAmount.status).toBe(400)

    const missing = await handlePay(makeRequest('intent', { flowStateId: 'nope' }), 'intent', deps)
    expect(missing.status).toBe(404)
  })

  it('confirm updates order objects with paymentStatus paid on success', async () => {
    const store = createStoreProvider({
      objects: [flowObject(paymentFlow)],
      records: new Map([
        [
          'orders:o1',
          { id: 'o1', customerId: 'u1', paymentIntentId: 'pi_1', paymentStatus: 'pending' },
        ],
        ['invoices:i1', { id: 'i1', paymentIntentId: 'pi_1', paymentStatus: 'pending' }],
      ]),
    })
    await seedFlowState(store, 'fs-1')
    const stripe = createFakeStripe()
    await handlePay(
      makeRequest('intent', { flowStateId: 'fs-1' }),
      'intent',
      payDeps(store, stripe),
    )
    stripe.markSucceeded('pi_1')

    const response = await handlePay(
      makeRequest('confirm', { paymentIntentId: 'pi_1' }),
      'confirm',
      payDeps(store, stripe),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { status: string }).status).toBe('paid')

    expect(store.records.get('orders:o1')?.['paymentStatus']).toBe('paid')
    expect(store.records.get('invoices:i1')?.['paymentStatus']).toBe('paid')
  })

  it('webhook verifies the signature and updates paymentStatus', async () => {
    const store = createStoreProvider({
      records: new Map([
        ['orders:o1', { id: 'o1', paymentIntentId: 'pi_fake', paymentStatus: 'pending' }],
      ]),
    })
    const stripe = createFakeStripe()

    const response = await handlePay(
      makeRequest('webhook', undefined, { 'stripe-signature': 'sig_test' }),
      'webhook',
      payDeps(store, stripe),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { received: boolean }).received).toBe(true)
    expect(stripe.events).toEqual([{ rawBody: '', signature: 'sig_test' }])
    expect(store.records.get('orders:o1')?.['paymentStatus']).toBe('paid')
  })

  it('webhook rejects invalid signatures (400) and leaves records untouched', async () => {
    const store = createStoreProvider({
      records: new Map([
        ['orders:o1', { id: 'o1', paymentIntentId: 'pi_fake', paymentStatus: 'pending' }],
      ]),
    })
    const stripe = createFakeStripe()
    stripe.failNextWebhook()

    const response = await handlePay(
      makeRequest('webhook', undefined, { 'stripe-signature': 'bad' }),
      'webhook',
      payDeps(store, stripe),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid-signature')
    expect(store.records.get('orders:o1')?.['paymentStatus']).toBe('pending')
  })

  it('404s unknown pay functions', async () => {
    const store = createStoreProvider()
    const response = await handlePay(
      makeRequest('charge', {}),
      'charge',
      payDeps(store, createFakeStripe()),
    )
    expect(response.status).toBe(404)
  })
})

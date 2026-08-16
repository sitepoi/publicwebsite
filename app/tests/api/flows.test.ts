import { describe, expect, it } from 'vitest'
import { handleFlow } from '@/app/api/flow/[flowId]/route'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import {
  advanceFlow,
  completeFlow,
  loadFlowDefinition,
  resolveFlowTemplates,
  startFlow,
  validateStepValues,
} from '@/lib/render/flows'
import type { FlowDefinition, FlowState } from '@/lib/contracts/flows'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()
const actor = { id: 'user-1', roles: ['customer'] }

// ---------------------------------------------------------------- fixtures

function flowObject(definition: Record<string, unknown>): ObjectRecord {
  return {
    id: `flow-${String(definition.flowId)}`,
    slug: `flow-${String(definition.flowId)}`,
    cmsObjectType: site.appId,
    typeId: site.folderId,
    data: definition,
  }
}

const createOrderOperation = {
  operationId: 'create-order',
  validation: { required: ['items'] },
  permission: { roles: ['customer'] },
  writes: [
    {
      targetType: 'orders-uniconbaseapps',
      mode: 'create',
      from: 'payload',
      with: { items: 'payload.items', address: 'payload.address', status: 'new' },
    },
  ],
  transaction: true,
}

function operationObject(definition: Record<string, unknown>): ObjectRecord {
  return {
    id: `op-${String(definition.operationId)}`,
    slug: `op-${String(definition.operationId)}`,
    cmsObjectType: site.appId,
    typeId: site.folderId,
    data: definition,
  }
}

const checkoutFlow = {
  flowId: 'checkout',
  steps: [
    {
      id: 'cart',
      dataDefinitions: [{ field: 'items', type: 'array' }],
      validationRules: [{ field: 'items', rule: 'minLength', value: 1 }],
    },
    {
      id: 'delivery',
      dataDefinitions: [{ field: 'address' }, { field: 'email' }],
      validationRules: [
        { field: 'address', rule: 'required' },
        { field: 'email', rule: 'email' },
      ],
    },
    {
      id: 'done',
      hooks: [
        {
          type: 'operation',
          operationId: 'create-order',
          payload: { items: 'steps.cart.items', address: 'steps.delivery.address' },
        },
      ],
    },
  ],
  session: 'cart',
}

const paymentFlow: FlowDefinition = {
  flowId: 'paycheckout',
  steps: [
    { id: 'cart', validationRules: [{ field: 'total', rule: 'min', value: 1 }] },
    { id: 'delivery', validationRules: [{ field: 'fee', rule: 'required' }] },
    { id: 'payment', paymentProvider: 'stripe', amountFormula: 'cart.total + delivery.fee' },
    { id: 'done', hooks: [] },
  ],
  session: 'cart',
}

// -------------------------------------------------------------------- route

function flowDeps(store: ReturnType<typeof createStoreProvider>) {
  return {
    env: dataEnv,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
    getActor: () => actor,
  }
}

function makeFlowRequest(
  flowId: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://site-a.test/api/flow/${flowId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test', ...headers },
    body: JSON.stringify(body),
  })
}

function cookieFrom(response: Response): string | null {
  return response.headers.get('set-cookie') ?? null
}

function cookieValue(setCookie: string | null): string {
  const match = setCookie?.match(/^gw-flow-[^=]+=([^;]*)/)
  if (!match) throw new Error(`No flow cookie in: ${setCookie}`)
  return decodeURIComponent(match[1]!)
}

describe('POST /api/flow/[flowId] (Section 31)', () => {
  it('drives a 3-step flow end-to-end and writes the final operation object', async () => {
    const store = createStoreProvider({
      objects: [flowObject(checkoutFlow), operationObject(createOrderOperation)],
    })
    const deps = flowDeps(store)

    // start → step cart
    const started = await handleFlow(
      makeFlowRequest('checkout', { action: 'start' }),
      'checkout',
      deps,
    )
    expect(started.status).toBe(200)
    const startBody = (await started.json()) as {
      ok: boolean
      flowStateId: string
      step: { id: string }
    }
    expect(startBody.ok).toBe(true)
    expect(startBody.step.id).toBe('cart')
    const setCookie = cookieFrom(started)
    expect(setCookie).toContain('gw-flow-cart=')
    const flowStateId = cookieValue(setCookie)
    const cookie = { cookie: `gw-flow-cart=${flowStateId}` }

    // step cart → delivery
    const cartStep = await handleFlow(
      makeFlowRequest(
        'checkout',
        { action: 'step', values: { items: [{ name: 'Burger', qty: 2 }] } },
        cookie,
      ),
      'checkout',
      deps,
    )
    expect(cartStep.status).toBe(200)
    const cartBody = (await cartStep.json()) as { nextStep: { id: string } }
    expect(cartBody.nextStep.id).toBe('delivery')

    // step delivery → done
    const deliveryStep = await handleFlow(
      makeFlowRequest(
        'checkout',
        { action: 'step', values: { address: 'Main St 1', email: 'a@b.co' } },
        cookie,
      ),
      'checkout',
      deps,
    )
    expect(deliveryStep.status).toBe(200)
    const deliveryBody = (await deliveryStep.json()) as { nextStep: { id: string } }
    expect(deliveryBody.nextStep.id).toBe('done')

    // complete → operation executed
    const completed = await handleFlow(
      makeFlowRequest('checkout', { action: 'complete' }, cookie),
      'checkout',
      deps,
    )
    expect(completed.status).toBe(200)
    const completeBody = (await completed.json()) as {
      ok: boolean
      result: { operations: unknown[] }
    }
    expect(completeBody.ok).toBe(true)
    expect(completeBody.result.operations).toHaveLength(1)

    // FINAL operation's object is stored (acceptance).
    const orderWrite = store.committed.find((write) => write.collection === 'orders-uniconbaseapps')
    expect(orderWrite?.data).toMatchObject({
      items: [{ name: 'Burger', qty: 2 }],
      address: 'Main St 1',
      status: 'new',
    })

    // Draft state marked done + cookie cleared.
    const state = await store.provider.getRecord({ collection: 'flow-states', id: flowStateId })
    expect(state?.['status']).toBe('done')
    expect(cookieFrom(completed)).toContain('Max-Age=0')
  })

  it('returns validation errors per step (Section 31 zod-ish rules)', async () => {
    const store = createStoreProvider({
      objects: [flowObject(checkoutFlow), operationObject(createOrderOperation)],
    })
    const deps = flowDeps(store)

    const started = await handleFlow(
      makeFlowRequest('checkout', { action: 'start' }),
      'checkout',
      deps,
    )
    const flowStateId = cookieValue(cookieFrom(started))
    const cookie = { cookie: `gw-flow-cart=${flowStateId}` }

    const bad = await handleFlow(
      makeFlowRequest('checkout', { action: 'step', values: { items: [] } }, cookie),
      'checkout',
      deps,
    )
    expect(bad.status).toBe(400)
    const badBody = (await bad.json()) as { error: string; errors: { field: string }[] }
    expect(badBody.error).toBe('validation-failed')
    expect(badBody.errors.map((entry) => entry.field)).toEqual(['items'])

    // State unchanged — a valid retry still works.
    const retry = await handleFlow(
      makeFlowRequest(
        'checkout',
        { action: 'step', values: { items: [{ name: 'Burger', qty: 1 }] } },
        cookie,
      ),
      'checkout',
      deps,
    )
    expect(retry.status).toBe(200)
  })

  it('keeps server-side draft state across steps (state progression)', async () => {
    const store = createStoreProvider({
      objects: [flowObject(checkoutFlow), operationObject(createOrderOperation)],
    })
    const deps = flowDeps(store)

    const started = await handleFlow(
      makeFlowRequest('checkout', { action: 'start' }),
      'checkout',
      deps,
    )
    const flowStateId = cookieValue(cookieFrom(started))
    const cookie = { cookie: `gw-flow-cart=${flowStateId}` }

    await handleFlow(
      makeFlowRequest(
        'checkout',
        { action: 'step', values: { items: [{ name: 'Burger', qty: 2 }] } },
        cookie,
      ),
      'checkout',
      deps,
    )

    const state = await store.provider.getRecord({ collection: 'flow-states', id: flowStateId })
    expect(state).toMatchObject({
      flowId: 'checkout',
      stepIndex: 1,
      currentStep: 'delivery',
      status: 'in-progress',
    })
    expect((state?.['steps'] as Record<string, unknown>)['cart']).toEqual({
      items: [{ name: 'Burger', qty: 2 }],
    })
  })

  it('refuses complete before the final step', async () => {
    const store = createStoreProvider({
      objects: [flowObject(checkoutFlow), operationObject(createOrderOperation)],
    })
    const deps = flowDeps(store)
    const started = await handleFlow(
      makeFlowRequest('checkout', { action: 'start' }),
      'checkout',
      deps,
    )
    const flowStateId = cookieValue(cookieFrom(started))
    const cookie = { cookie: `gw-flow-cart=${flowStateId}` }

    const completed = await handleFlow(
      makeFlowRequest('checkout', { action: 'complete' }, cookie),
      'checkout',
      deps,
    )
    expect(completed.status).toBe(400)
    expect(((await completed.json()) as { error: string }).error).toBe('flow-not-complete')
  })

  it('rejects a duplicate complete (409 flow-finished)', async () => {
    const store = createStoreProvider({
      objects: [flowObject(checkoutFlow), operationObject(createOrderOperation)],
    })
    const deps = flowDeps(store)
    const started = await handleFlow(
      makeFlowRequest('checkout', { action: 'start' }),
      'checkout',
      deps,
    )
    const flowStateId = cookieValue(cookieFrom(started))
    const cookie = { cookie: `gw-flow-cart=${flowStateId}` }

    await handleFlow(
      makeFlowRequest(
        'checkout',
        { action: 'step', values: { items: [{ name: 'Burger', qty: 1 }] } },
        cookie,
      ),
      'checkout',
      deps,
    )
    await handleFlow(
      makeFlowRequest(
        'checkout',
        { action: 'step', values: { address: 'A', email: 'a@b.co' } },
        cookie,
      ),
      'checkout',
      deps,
    )
    const first = await handleFlow(
      makeFlowRequest('checkout', { action: 'complete' }, cookie),
      'checkout',
      deps,
    )
    expect(first.status).toBe(200)
    const second = await handleFlow(
      makeFlowRequest('checkout', { action: 'complete' }, cookie),
      'checkout',
      deps,
    )
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toBe('flow-finished')
  })

  it('404s unknown flows and 400s missing flow state', async () => {
    const store = createStoreProvider({ objects: [flowObject(checkoutFlow)] })
    const deps = flowDeps(store)

    const missing = await handleFlow(makeFlowRequest('nope', { action: 'start' }), 'nope', deps)
    expect(missing.status).toBe(404)

    const noState = await handleFlow(
      makeFlowRequest('checkout', { action: 'step', values: {} }),
      'checkout',
      deps,
    )
    expect(noState.status).toBe(400)
    expect(((await noState.json()) as { error: string }).error).toBe('flow-state-required')
  })

  it('silently ignores honeypot calls', async () => {
    const store = createStoreProvider({ objects: [flowObject(checkoutFlow)] })
    const response = await handleFlow(
      makeFlowRequest('checkout', { action: 'start', gw_hp: 'bot' }),
      'checkout',
      flowDeps(store),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('rejects invalid flow calls', async () => {
    const store = createStoreProvider({ objects: [flowObject(checkoutFlow)] })
    const response = await handleFlow(
      makeFlowRequest('checkout', { action: 'jump' }),
      'checkout',
      flowDeps(store),
    )
    expect(response.status).toBe(400)
  })
})

// ------------------------------------------------------------------ runner

describe('flow runner (lib/render/flows)', () => {
  it('emits a Stripe intent STUB from the amount formula (C10 = real)', async () => {
    const store = createStoreProvider({ objects: [flowObject(paymentFlow)] })
    const definition = await loadFlowDefinition(store.provider, site, 'paycheckout')
    expect(definition).not.toBeNull()
    const state: FlowState = {
      id: 'fs-1',
      flowId: 'paycheckout',
      stepIndex: 3,
      currentStep: 'done',
      steps: { cart: { total: 10 }, delivery: { fee: 5 } },
      status: 'in-progress',
    }

    const result = await completeFlow({
      provider: store.provider,
      site,
      definition: definition!,
      state,
      actor,
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'completed') return
    expect(result.result.paymentIntent).toMatchObject({
      provider: 'stripe',
      amount: 15,
      currency: 'usd',
      status: 'requires_payment_method',
      stub: true,
    })
  })

  it('fails complete when a done-step operation fails (state stays in-progress)', async () => {
    const brokenFlow = {
      ...checkoutFlow,
      flowId: 'broken',
      steps: [
        ...checkoutFlow.steps.slice(0, 2),
        { id: 'done', hooks: [{ type: 'operation', operationId: 'missing-op' }] },
      ],
    }
    const store = createStoreProvider({ objects: [flowObject(brokenFlow)] })
    const definition = await loadFlowDefinition(store.provider, site, 'broken')
    const state: FlowState = {
      id: 'fs-2',
      flowId: 'broken',
      stepIndex: 2,
      currentStep: 'done',
      steps: { cart: { items: [{ name: 'Burger', qty: 1 }] }, delivery: { address: 'A' } },
      status: 'in-progress',
    }

    const result = await completeFlow({
      provider: store.provider,
      site,
      definition: definition!,
      state,
      actor,
    })
    expect(result).toMatchObject({ ok: false, error: 'flow-operation-failed', status: 502 })
    expect(store.committed).toHaveLength(0)
  })

  it('validateStepValues implements the zod-ish subset', () => {
    expect(validateStepValues({}, [{ field: 'email', rule: 'required' }])).toHaveLength(1)
    expect(validateStepValues({ email: 'nope' }, [{ field: 'email', rule: 'email' }])).toHaveLength(
      1,
    )
    expect(
      validateStepValues({ email: 'a@b.co' }, [{ field: 'email', rule: 'email' }]),
    ).toHaveLength(0)
    expect(
      validateStepValues({ age: 17 }, [{ field: 'age', rule: 'min', value: 18 }]),
    ).toHaveLength(1)
    expect(
      validateStepValues({ age: 20 }, [{ field: 'age', rule: 'max', value: 18 }]),
    ).toHaveLength(1)
    expect(
      validateStepValues({ items: [] }, [{ field: 'items', rule: 'minLength', value: 1 }]),
    ).toHaveLength(1)
    expect(
      validateStepValues({ code: 'abc' }, [{ field: 'code', rule: 'regex', value: '^[0-9]+$' }]),
    ).toHaveLength(1)
    expect(validateStepValues({ count: 1.5 }, [{ field: 'count', rule: 'integer' }])).toHaveLength(
      1,
    )
    expect(validateStepValues({ count: 2 }, [{ field: 'count', rule: 'integer' }])).toHaveLength(0)
    expect(validateStepValues({}, [{ field: 'x', rule: 'unknownRule' }])).toHaveLength(1)
    // Nested dotted fields resolve through pathGet.
    expect(
      validateStepValues({ address: { city: 'Rome' } }, [
        { field: 'address.city', rule: 'required' },
      ]),
    ).toHaveLength(0)
  })

  it('resolveFlowTemplates resolves steps/user templates recursively', () => {
    const state: FlowState = {
      id: 'fs-3',
      flowId: 'checkout',
      stepIndex: 0,
      currentStep: 'cart',
      steps: { cart: { items: [{ name: 'Burger', qty: 2 }] } },
      status: 'in-progress',
    }
    expect(
      resolveFlowTemplates(
        {
          items: 'steps.cart.items',
          customerId: 'user.id',
          literal: 'plain',
          nested: { qty: 'steps.cart.items[0].qty' },
        },
        state,
        actor,
      ),
    ).toEqual({
      items: [{ name: 'Burger', qty: 2 }],
      customerId: 'user-1',
      literal: 'plain',
      nested: { qty: 2 },
    })
  })

  it('startFlow + advanceFlow build state without any writes besides the state record', async () => {
    const store = createStoreProvider({
      objects: [flowObject(checkoutFlow), operationObject(createOrderOperation)],
    })
    const definition = await loadFlowDefinition(store.provider, site, 'checkout')
    const started = await startFlow({
      provider: store.provider,
      site,
      definition: definition!,
      flowId: 'checkout',
      now: () => new Date('2026-08-15T10:00:00Z'),
    })
    expect(started.ok).toBe(true)
    if (!started.ok || started.kind !== 'started') return
    expect(started.sessionKey).toBe('cart')

    const state = (await store.provider.getRecord({
      collection: 'flow-states',
      id: started.flowStateId,
    })) as unknown as FlowState
    const advanced = await advanceFlow({
      provider: store.provider,
      site,
      definition: definition!,
      state,
      values: { items: [{ name: 'Burger', qty: 1 }] },
      now: () => new Date('2026-08-15T10:01:00Z'),
    })
    expect(advanced.ok).toBe(true)
    if (!advanced.ok || advanced.kind !== 'advanced') return
    expect(advanced.nextStep.id).toBe('delivery')
  })
})

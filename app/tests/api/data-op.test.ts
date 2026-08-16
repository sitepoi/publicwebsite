import { describe, expect, it } from 'vitest'
import { executeOperation, evaluateFormula, runContextFunction } from '@/lib/render/operations'
import { handleDataOp } from '@/app/api/data/op/route'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite, makeOpRequest } from './data-fakes'

const site = makeDataSite()

function operationObject(definition: Record<string, unknown>): ObjectRecord {
  return {
    id: `op-${String(definition.operationId)}`,
    slug: `op-${String(definition.operationId)}`,
    cmsObjectType: site.appId,
    typeId: site.folderId,
    data: definition,
  }
}

const createOrderDefinition = {
  operationId: 'create-order',
  validation: { required: ['items'], properties: { items: { type: 'array' } } },
  permission: { roles: ['customer'], ownerField: 'customerId' },
  formulas: [{ out: 'total', code: 'sum(payload.items, price * qty)' }],
  writes: [
    {
      targetType: 'orders-uniconbaseapps',
      mode: 'create',
      from: 'payload',
      with: { customerId: 'user.id', status: 'new', total: 'payload.total' },
    },
    {
      targetType: 'products-uniconbaseapps',
      mode: 'update',
      by: { id: 'payload.items[].id' },
      fields: { stock: 'decrement' },
    },
  ],
  transaction: true,
}

const actor = { id: 'user-1', roles: ['customer'] }

function runOrderOperation(
  store: ReturnType<typeof createStoreProvider>,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return executeOperation({
    provider: store.provider,
    site,
    operationId: 'create-order',
    payload,
    actor,
    ...overrides,
  })
}

describe('operations engine (Section 30)', () => {
  it('executes create + multi-write atomically (transaction)', async () => {
    const store = createStoreProvider({
      objects: [operationObject(createOrderDefinition)],
      records: new Map([['products-uniconbaseapps:p1', { id: 'p1', stock: 10 }]]),
    })
    const result = await runOrderOperation(store, { items: [{ id: 'p1', price: 3, qty: 2 }] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const summary = result.result as { created: string[]; updated: number }
    expect(summary.created).toHaveLength(1)
    expect(summary.updated).toBe(1)

    const orderWrite = store.committed.find((write) => write.collection === 'orders-uniconbaseapps')
    expect(orderWrite?.data).toMatchObject({ customerId: 'user-1', status: 'new', total: 6 })
    expect(store.records.get('products-uniconbaseapps:p1')?.stock).toBe(9)
  })

  it('returns validation errors (Section 30 zod schema)', async () => {
    const store = createStoreProvider({ objects: [operationObject(createOrderDefinition)] })
    const result = await runOrderOperation(store, {})
    expect(result).toMatchObject({ ok: false, error: 'validation-failed', status: 400 })
    if (!result.ok) expect(result.errors?.[0]?.field).toBe('items')
    expect(store.committed).toHaveLength(0)
  })

  it('denies callers without the required roles (Section 32)', async () => {
    const store = createStoreProvider({ objects: [operationObject(createOrderDefinition)] })
    const result = await runOrderOperation(store, { items: [] }, { actor: { roles: [] } })
    expect(result).toMatchObject({ ok: false, error: 'forbidden', status: 403 })
  })

  it('replays duplicate idempotency keys with the same result (Section 33)', async () => {
    const store = createStoreProvider({
      objects: [operationObject(createOrderDefinition)],
      records: new Map([['products-uniconbaseapps:p1', { id: 'p1', stock: 10 }]]),
    })
    const payload = { items: [{ id: 'p1', price: 3, qty: 1 }] }

    const first = await runOrderOperation(store, payload, { idempotencyKey: 'key-1' })
    const second = await runOrderOperation(store, payload, { idempotencyKey: 'key-1' })

    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: true, idempotent: true })
    if (first.ok && second.ok) expect(second.result).toEqual(first.result)

    // The write executed ONCE; stock decremented once.
    expect(
      store.committed.filter((write) => write.collection === 'orders-uniconbaseapps'),
    ).toHaveLength(1)
    expect(store.records.get('products-uniconbaseapps:p1')?.stock).toBe(9)
  })

  it('rolls back the whole transaction when a write fails (Section 33)', async () => {
    const store = createStoreProvider({
      objects: [operationObject(createOrderDefinition)],
      // p1 missing → update target-not-found → whole transaction rolls back.
      records: new Map(),
    })
    const result = await runOrderOperation(store, { items: [{ id: 'p1', price: 3, qty: 1 }] })
    expect(result).toMatchObject({ ok: false, error: 'transaction-failed', status: 500 })
    expect(store.committed).toHaveLength(0)
  })

  it('computes formulas over the payload (safe subset)', async () => {
    const store = createStoreProvider({
      objects: [operationObject(createOrderDefinition)],
      records: new Map([['products-uniconbaseapps:p1', { id: 'p1', stock: 5 }]]),
    })
    const result = await runOrderOperation(store, { items: [{ id: 'p1', price: 2, qty: 3 }] })
    expect(result.ok).toBe(true)
    const orderWrite = store.committed.find((write) => write.collection === 'orders-uniconbaseapps')
    expect(orderWrite?.data?.total).toBe(6)
  })

  it('evaluateFormula supports the whitelisted functions only', () => {
    expect(
      evaluateFormula('sum(payload.items, price * qty)', {
        payload: {
          items: [
            { price: 2, qty: 3 },
            { price: 1, qty: 4 },
          ],
        },
      }),
    ).toBe(10)
    expect(evaluateFormula('count(payload.items)', { payload: { items: [1, 2, 3] } })).toBe(3)
    expect(evaluateFormula('round(2.6)', {})).toBe(3)
    expect(() => evaluateFormula('evil()', {})).toThrow()
  })

  it('context functions run sandboxed (math/date whitelist only)', () => {
    const sandboxed = runContextFunction('return Math.max(payload.a, payload.b);', {
      payload: { a: 3, b: 7 },
    })
    expect(sandboxed).toBe(7)
    expect(() => runContextFunction('return process.env;', {})).toThrow()
  })

  it('operation hook failures never fail the operation', async () => {
    const store = createStoreProvider({
      objects: [operationObject({ ...createOrderDefinition, hooks: [{ type: 'email' }] })],
      records: new Map([['products-uniconbaseapps:p1', { id: 'p1', stock: 5 }]]),
    })
    const result = await runOrderOperation(
      store,
      { items: [{ id: 'p1', price: 1, qty: 1 }] },
      {
        hooks: {
          runEmailHook: async () => {
            throw new Error('smtp down')
          },
        },
      },
    )
    expect(result.ok).toBe(true)
  })
})

describe('POST /api/data/op route', () => {
  function opDeps(store: ReturnType<typeof createStoreProvider>) {
    return {
      env: dataEnv,
      resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
      providerFor: () => store.provider,
      rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
      getActor: () => ({ id: 'user-1', roles: ['customer'] }),
    }
  }

  it('runs an operation end-to-end', async () => {
    const store = createStoreProvider({
      objects: [operationObject(createOrderDefinition)],
      records: new Map([['products-uniconbaseapps:p1', { id: 'p1', stock: 3 }]]),
    })
    const response = await handleDataOp(
      makeOpRequest({
        operation: 'create-order',
        payload: { items: [{ id: 'p1', price: 1, qty: 1 }] },
      }),
      opDeps(store),
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ ok: true })
    // 2 operation writes + the C11 event-log record for operation.completed.
    expect(store.committed.filter((write) => write.collection !== 'event-log')).toHaveLength(2)
    expect(store.committed.filter((write) => write.collection === 'event-log')).toHaveLength(1)
  })

  it('silently ignores honeypot calls', async () => {
    const store = createStoreProvider({ objects: [operationObject(createOrderDefinition)] })
    const response = await handleDataOp(
      makeOpRequest({ operation: 'create-order', payload: { items: [] }, gw_hp: 'bot' }),
      opDeps(store),
    )
    expect(response.status).toBe(200)
    expect(store.committed).toHaveLength(0)
  })

  it('rejects invalid operation calls', async () => {
    const store = createStoreProvider({})
    const response = await handleDataOp(makeOpRequest({ nope: true }), opDeps(store))
    expect(response.status).toBe(400)
  })

  it('passes the Idempotency-Key header through', async () => {
    const store = createStoreProvider({
      objects: [operationObject(createOrderDefinition)],
      records: new Map([['products-uniconbaseapps:p1', { id: 'p1', stock: 3 }]]),
    })
    const body = { operation: 'create-order', payload: { items: [{ id: 'p1', price: 1, qty: 1 }] } }
    const headers = { 'idempotency-key': 'hdr-key' }
    const first = await handleDataOp(makeOpRequest(body, headers), opDeps(store))
    const second = await handleDataOp(makeOpRequest(body, headers), opDeps(store))
    expect(first.status).toBe(200)
    const secondBody = (await second.json()) as { idempotent?: boolean }
    expect(secondBody.idempotent).toBe(true)
    expect(
      store.committed.filter((write) => write.collection === 'orders-uniconbaseapps'),
    ).toHaveLength(1)
  })
})

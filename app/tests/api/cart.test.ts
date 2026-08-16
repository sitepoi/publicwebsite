import { describe, expect, it } from 'vitest'
import { handleCart, CART_COOKIE } from '@/app/api/cart/route'
import { FixtureAuthService } from '@/lib/auth/fixture'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()

const products: ObjectRecord[] = [
  { id: 'p1', name: 'Cheeseburger', price: 6.5, cmsObjectType: 'menu-items', typeId: 'folder-a' },
  { id: 'p2', name: 'Salad', price: 7, cmsObjectType: 'menu-items', typeId: 'folder-a' },
  { id: 'p3', name: 'Unpriced', cmsObjectType: 'menu-items', typeId: 'folder-a' },
]

function cartDeps(store: ReturnType<typeof createStoreProvider>) {
  return {
    env: dataEnv,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    authService: new FixtureAuthService(),
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
  }
}

function makeRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request('https://site-a.test/api/cart', {
    method,
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function cookieValue(setCookie: string | null): string {
  const match = setCookie?.match(new RegExp(`^${CART_COOKIE}=([^;]*)`))
  if (!match) throw new Error(`No cart cookie in: ${setCookie}`)
  return decodeURIComponent(match[1]!)
}

describe('/api/cart (Section 15 / PART B)', () => {
  it('adds items with SERVER-computed prices and persists across requests (cookie)', async () => {
    const store = createStoreProvider({ objects: products })
    const deps = cartDeps(store)

    const added = await handleCart(
      makeRequest('POST', {
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'p1', qty: 2 },
      }),
      deps,
    )
    expect(added.status).toBe(200)
    const addedBody = (await added.json()) as {
      items: { qty: number; price: number }[]
      total: number
    }
    expect(addedBody.total).toBe(13)
    expect(addedBody.items[0]).toMatchObject({ qty: 2, price: 6.5 })
    const setCookie = added.headers.get('set-cookie')
    expect(setCookie).toContain(`${CART_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')

    // Persistence: GET with the SAME cookie returns the same cart (SPA nav).
    const cookie = cookieValue(setCookie)
    const read = await handleCart(
      makeRequest('GET', undefined, { cookie: `gw-cart=${cookie}` }),
      deps,
    )
    expect(read.status).toBe(200)
    const readBody = (await read.json()) as { items: unknown[]; total: number; count: number }
    expect(readBody.count).toBe(1)
    expect(readBody.total).toBe(13)
  })

  it('supports update / remove / clear with totals always server-side', async () => {
    const store = createStoreProvider({ objects: products })
    const deps = cartDeps(store)

    const added = await handleCart(
      makeRequest('POST', {
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'p1', qty: 1 },
      }),
      deps,
    )
    const cookie = cookieValue(added.headers.get('set-cookie'))
    const withCookie = { cookie: `gw-cart=${cookie}` }

    const updated = await handleCart(
      makeRequest(
        'POST',
        { action: 'update', item: { cmsObjectType: 'menu-items', objectId: 'p1', qty: 3 } },
        withCookie,
      ),
      deps,
    )
    expect(((await updated.json()) as { total: number }).total).toBe(19.5)

    const removed = await handleCart(
      makeRequest(
        'POST',
        { action: 'remove', item: { cmsObjectType: 'menu-items', objectId: 'p1' } },
        withCookie,
      ),
      deps,
    )
    expect(((await removed.json()) as { count: number }).count).toBe(0)

    await handleCart(
      makeRequest(
        'POST',
        { action: 'add', item: { cmsObjectType: 'menu-items', objectId: 'p2', qty: 2 } },
        withCookie,
      ),
      deps,
    )
    const cleared = await handleCart(makeRequest('POST', { action: 'clear' }, withCookie), deps)
    expect(((await cleared.json()) as { total: number }).total).toBe(0)
  })

  it('merges quantities on repeated adds of the same product', async () => {
    const store = createStoreProvider({ objects: products })
    const deps = cartDeps(store)
    const first = await handleCart(
      makeRequest('POST', {
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'p1', qty: 2 },
      }),
      deps,
    )
    const cookie = cookieValue(first.headers.get('set-cookie'))
    const second = await handleCart(
      makeRequest(
        'POST',
        { action: 'add', item: { cmsObjectType: 'menu-items', objectId: 'p1', qty: 3 } },
        { cookie: `gw-cart=${cookie}` },
      ),
      deps,
    )
    const body = (await second.json()) as { items: { qty: number }[]; total: number }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.qty).toBe(5)
    expect(body.total).toBe(32.5)
  })

  it('rejects unknown products and unpriced products', async () => {
    const store = createStoreProvider({ objects: products })
    const deps = cartDeps(store)

    const missing = await handleCart(
      makeRequest('POST', {
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'nope', qty: 1 },
      }),
      deps,
    )
    expect(missing.status).toBe(404)

    const unpriced = await handleCart(
      makeRequest('POST', {
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'p3', qty: 1 },
      }),
      deps,
    )
    expect(unpriced.status).toBe(400)
    expect(((await unpriced.json()) as { error: string }).error).toBe('product-not-priced')
  })

  it('keeps carts separate per anon token', async () => {
    const store = createStoreProvider({ objects: products })
    const deps = cartDeps(store)

    const first = await handleCart(
      makeRequest('POST', {
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'p1', qty: 1 },
      }),
      deps,
    )
    const firstCookie = cookieValue(first.headers.get('set-cookie'))

    const second = await handleCart(makeRequest('GET'), deps)
    const secondBody = (await second.json()) as { count: number }
    expect(secondBody.count).toBe(0)

    const firstRead = await handleCart(
      makeRequest('GET', undefined, { cookie: `gw-cart=${firstCookie}` }),
      deps,
    )
    expect(((await firstRead.json()) as { count: number }).count).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { handleAccount } from '@/app/api/account/[resource]/route'
import { FixtureAuthService, fixtureUidFor } from '@/lib/auth/fixture'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()

function accountDeps(
  store: ReturnType<typeof createStoreProvider>,
  authService = new FixtureAuthService(),
) {
  return {
    env: dataEnv,
    authService,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
  }
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request(`https://site-a.test/api/account/orders`, {
    method: 'GET',
    headers: { 'x-gw-host': 'site-a.test', ...headers },
  })
}

async function registerAndCookie(authService: FixtureAuthService, email: string): Promise<string> {
  const { idToken } = await authService.register(email, 'secret-pass')
  const session = await authService.createSessionFromIdToken(idToken)
  return session.cookie
}

describe('GET /api/account/[resource] (Sections 17/32)', () => {
  it('requires a valid session (401)', async () => {
    const store = createStoreProvider()
    const response = await handleAccount(makeRequest(), 'orders', accountDeps(store))
    expect(response.status).toBe(401)
  })

  it('returns the profile with roles from the users collection', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    const cookie = await registerAndCookie(authService, 'a@b.co')
    const uid = fixtureUidFor('a@b.co')
    store.records.set(`users:${uid}`, { uid, email: 'a@b.co', roles: ['customer'], name: 'Ann' })

    const response = await handleAccount(
      makeRequest({ cookie: `gw-session=${cookie}` }),
      'profile',
      accountDeps(store, authService),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { profile: { user: { roles: string[] }; name: string } }
    expect(body.profile.user.roles).toEqual(['customer'])
    expect(body.profile.name).toBe('Ann')
  })

  it('returns ONLY the caller’s orders (ownerField=customerId, Section 32)', async () => {
    const uid = fixtureUidFor('a@b.co')
    const store = createStoreProvider({
      records: new Map([
        ['orders:o1', { id: 'o1', customerId: uid, total: 10 }],
        ['orders:o2', { id: 'o2', customerId: 'fx-other', total: 99 }],
        ['tickets:t1', { id: 't1', customerId: uid, seat: 'A1' }],
      ]),
    })
    const authService = new FixtureAuthService()
    const cookie = await registerAndCookie(authService, 'a@b.co')

    const response = await handleAccount(
      makeRequest({ cookie: `gw-session=${cookie}` }),
      'orders',
      accountDeps(store, authService),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { resource: string; items: { id: string }[] }
    expect(body.resource).toBe('orders')
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.id).toBe('o1')

    // Tickets use the same scoping.
    const tickets = await handleAccount(
      makeRequest({ cookie: `gw-session=${cookie}` }),
      'tickets',
      accountDeps(store, authService),
    )
    const ticketsBody = (await tickets.json()) as { items: { id: string }[] }
    expect(ticketsBody.items).toHaveLength(1)
    expect(ticketsBody.items[0]?.id).toBe('t1')
  })

  it('rejects unknown resources (404)', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    const cookie = await registerAndCookie(authService, 'a@b.co')
    const response = await handleAccount(
      makeRequest({ cookie: `gw-session=${cookie}` }),
      'passwords',
      accountDeps(store, authService),
    )
    expect(response.status).toBe(404)
  })
})

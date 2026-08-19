import { describe, expect, it } from 'vitest'
import { handleAuthSession, SESSION_COOKIE } from '@/app/api/auth/session/route'
import { handleDataOp } from '@/app/api/data/op/route'
import { resolveSessionActor } from '@/lib/auth'
import { FixtureAuthService } from '@/lib/auth/fixture'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite, makeOpRequest } from './data-fakes'

/**
 * Session-derived actors (Section 32 / C13 closure): data-op + flow routes
 * derive the operation actor from the HttpOnly session cookie so logged-in
 * users run `roles: ['customer']` operations. Anonymous callers stay roleless.
 */
const site = makeDataSite()

function operationObject(definition: Record<string, unknown>): ObjectRecord {
  return {
    id: `op-${String(definition.operationId)}`,
    cmsObjectType: site.appId,
    typeId: site.folderId,
    data: definition,
  }
}

const createOrderDefinition = {
  operationId: 'create-order',
  permission: { roles: ['customer'] },
  writes: [
    {
      targetType: 'orders',
      mode: 'create',
      with: { customerId: 'user.id', status: 'new', total: 'payload.total' },
    },
  ],
  transaction: true,
}

async function registerAndGetCookie(
  store: ReturnType<typeof createStoreProvider>,
  authService: FixtureAuthService,
): Promise<string> {
  const response = await handleAuthSession(
    new Request('https://site-a.test/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test' },
      body: JSON.stringify({
        action: 'register',
        email: 'buyer@example.com',
        password: 'pw123456',
      }),
    }),
    {
      env: dataEnv,
      authService,
      resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
      providerFor: () => store.provider,
      rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
    },
  )
  expect(response.status).toBe(200)
  const setCookie = response.headers.get('set-cookie') ?? ''
  const match = setCookie.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`))
  if (!match) throw new Error('no session cookie')
  return decodeURIComponent(match[1]!)
}

function opDeps(store: ReturnType<typeof createStoreProvider>, authService: FixtureAuthService) {
  return {
    env: dataEnv,
    authService,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
  }
}

describe('resolveSessionActor (lib/auth)', () => {
  it('anonymous requests get an empty actor', async () => {
    const store = createStoreProvider()
    const actor = await resolveSessionActor(
      new Request('https://site-a.test/api/x'),
      new FixtureAuthService(),
      store.provider,
    )
    expect(actor).toEqual({ roles: [] })
  })

  it('a valid session cookie resolves the user id + roles', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    const cookie = await registerAndGetCookie(store, authService)
    const actor = await resolveSessionActor(
      new Request('https://site-a.test/api/x', { headers: { cookie: `gw-session=${cookie}` } }),
      authService,
      store.provider,
    )
    expect(actor.roles).toEqual(['customer'])
    expect(typeof actor.id).toBe('string')
    expect(actor.id?.length).toBeGreaterThan(0)
  })
})

describe('handleDataOp actor derivation (C13 closure)', () => {
  it('anonymous callers are rejected for role-gated operations', async () => {
    const store = createStoreProvider({ objects: [operationObject(createOrderDefinition)] })
    const response = await handleDataOp(
      makeOpRequest({ operation: 'create-order', payload: { total: 5 } }),
      opDeps(store, new FixtureAuthService()),
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('forbidden')
  })

  it('a session cookie gives the customer role and the operation writes', async () => {
    const store = createStoreProvider({ objects: [operationObject(createOrderDefinition)] })
    const authService = new FixtureAuthService()
    const cookie = await registerAndGetCookie(store, authService)
    const response = await handleDataOp(
      makeOpRequest(
        { operation: 'create-order', payload: { total: 5 } },
        { cookie: `gw-session=${cookie}` },
      ),
      opDeps(store, authService),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; result: { created: string[] } }
    expect(body.ok).toBe(true)
    expect(body.result.created.length).toBe(1)
  })
})

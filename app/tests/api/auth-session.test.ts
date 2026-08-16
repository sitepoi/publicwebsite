import { describe, expect, it } from 'vitest'
import { handleAuthSession, SESSION_COOKIE } from '@/app/api/auth/session/route'
import { FixtureAuthService, fixtureUidFor } from '@/lib/auth/fixture'
import { pageRequiresAuth } from '@/lib/auth'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()

function sessionDeps(
  store: ReturnType<typeof createStoreProvider>,
  authService = new FixtureAuthService(),
) {
  return {
    env: dataEnv,
    authService,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
  }
}

function makeRequest(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://site-a.test/api/auth/session', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function cookieValue(setCookie: string | null): string {
  const match = setCookie?.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`))
  if (!match) throw new Error(`No session cookie in: ${setCookie}`)
  return decodeURIComponent(match[1]!)
}

describe('POST/GET /api/auth/session (Section 17)', () => {
  it('register sets an HttpOnly session cookie, roles from users, NO password stored', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    const deps = sessionDeps(store, authService)

    const response = await handleAuthSession(
      makeRequest({ action: 'register', email: 'a@b.co', password: 'secret-pass', name: 'Ann' }),
      deps,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; user: { uid: string; roles: string[] } }
    expect(body.ok).toBe(true)
    expect(body.user.roles).toEqual(['customer'])

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')

    // Users doc (Uniconhub admin schema) — and NEVER any password material.
    const uid = fixtureUidFor('a@b.co')
    const usersDoc = await store.provider.getRecord({ collection: 'users', id: uid })
    expect(usersDoc).toMatchObject({ uid, email: 'a@b.co', name: 'Ann', roles: ['customer'] })
    expect(JSON.stringify(usersDoc)).not.toContain('secret-pass')
    expect(JSON.stringify(body)).not.toContain('secret-pass')
  })

  it('me returns the session user with roles; anonymous gets user null', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    const deps = sessionDeps(store, authService)

    const registered = await handleAuthSession(
      makeRequest({ action: 'register', email: 'a@b.co', password: 'secret-pass' }),
      deps,
    )
    const cookie = cookieValue(registered.headers.get('set-cookie'))

    const me = await handleAuthSession(
      makeRequest(undefined, { cookie: `gw-session=${cookie}` }),
      deps,
    )
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { user: { email: string; roles: string[] } | null }
    expect(meBody.user?.email).toBe('a@b.co')
    expect(meBody.user?.roles).toEqual(['customer'])

    const anonymous = await handleAuthSession(makeRequest(), deps)
    expect(((await anonymous.json()) as { user: unknown }).user).toBeNull()
  })

  it('login persists the session and ensures a users doc when missing', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    await authService.register('a@b.co', 'secret-pass')
    const deps = sessionDeps(store, authService)

    const response = await handleAuthSession(
      makeRequest({ action: 'login', email: 'a@b.co', password: 'secret-pass' }),
      deps,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)

    const uid = fixtureUidFor('a@b.co')
    const usersDoc = await store.provider.getRecord({ collection: 'users', id: uid })
    expect(usersDoc?.['roles']).toEqual(['customer'])
  })

  it('rejects wrong credentials (401) and never reveals details', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    await authService.register('a@b.co', 'secret-pass')
    const response = await handleAuthSession(
      makeRequest({ action: 'login', email: 'a@b.co', password: 'wrong-pass' }),
      sessionDeps(store, authService),
    )
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('invalid-credentials')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('logout clears the cookie and revokes the session', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    const deps = sessionDeps(store, authService)
    const registered = await handleAuthSession(
      makeRequest({ action: 'register', email: 'a@b.co', password: 'secret-pass' }),
      deps,
    )
    const cookie = cookieValue(registered.headers.get('set-cookie'))

    const logout = await handleAuthSession(
      makeRequest({ action: 'logout' }, { cookie: `gw-session=${cookie}` }),
      deps,
    )
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')

    const me = await handleAuthSession(
      makeRequest(undefined, { cookie: `gw-session=${cookie}` }),
      deps,
    )
    expect(((await me.json()) as { user: unknown }).user).toBeNull()
  })

  it('forgot → reset → login with the new password', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    await authService.register('a@b.co', 'old-pass-1')
    const deps = sessionDeps(store, authService)

    const forgot = await handleAuthSession(makeRequest({ action: 'forgot', email: 'a@b.co' }), deps)
    expect(forgot.status).toBe(200)
    const code = authService.lastResetCode
    expect(code).not.toBeNull()

    const reset = await handleAuthSession(
      makeRequest({ action: 'reset', oobCode: code, password: 'new-pass-2' }),
      deps,
    )
    expect(reset.status).toBe(200)

    const login = await handleAuthSession(
      makeRequest({ action: 'login', email: 'a@b.co', password: 'new-pass-2' }),
      deps,
    )
    expect(login.status).toBe(200)
  })

  it('verify marks the email verified', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    await authService.register('a@b.co', 'secret-pass')
    const deps = sessionDeps(store, authService)

    const verify = await handleAuthSession(
      makeRequest({ action: 'verify', oobCode: authService.lastVerifyCode }),
      deps,
    )
    expect(verify.status).toBe(200)

    const login = await authService.login('a@b.co', 'secret-pass')
    expect(login.user.emailVerified).toBe(true)
  })

  it('honeypot is silent and rate limits per IP', async () => {
    const store = createStoreProvider()
    const authService = new FixtureAuthService()
    await authService.register('a@b.co', 'secret-pass')
    const deps = sessionDeps(store, authService)

    const honeypot = await handleAuthSession(
      makeRequest({ action: 'login', email: 'a@b.co', password: 'secret-pass', gw_hp: 'bot' }),
      deps,
    )
    expect(honeypot.status).toBe(200)
    expect(honeypot.headers.get('set-cookie')).toBeNull()

    deps.rateLimiter = createMemoryRateLimiter({ max: 1, windowMs: 60_000 })
    const first = await handleAuthSession(
      makeRequest({ action: 'login', email: 'a@b.co', password: 'secret-pass' }),
      deps,
    )
    expect(first.status).toBe(200)
    const second = await handleAuthSession(
      makeRequest({ action: 'login', email: 'a@b.co', password: 'secret-pass' }),
      deps,
    )
    expect(second.status).toBe(429)
  })

  it('rejects invalid auth calls', async () => {
    const store = createStoreProvider()
    const response = await handleAuthSession(
      makeRequest({ action: 'teleport' }),
      sessionDeps(store),
    )
    expect(response.status).toBe(400)
  })
})

describe('pageRequiresAuth (Section 17 gating)', () => {
  it('recognizes true / yes / 1 and ignores everything else', () => {
    expect(pageRequiresAuth({ requireAuth: true })).toBe(true)
    expect(pageRequiresAuth({ requireAuth: 'yes' })).toBe(true)
    expect(pageRequiresAuth({ requireAuth: 1 })).toBe(true)
    expect(pageRequiresAuth({ requireAuth: '1' })).toBe(true)
    expect(pageRequiresAuth({})).toBe(false)
    expect(pageRequiresAuth({ requireAuth: false })).toBe(false)
    expect(pageRequiresAuth(null)).toBe(false)
    expect(pageRequiresAuth('nope')).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  createFirstPartyCredentialResolver,
  toFirstPartyCredentialMetadata,
  type FirstPartyTenantIdentity,
} from '@/lib/server/cmsFirstPartyCredentials'
import type { CmsServiceEnv } from '@/lib/server/cmsServiceConfig'

const ENV: CmsServiceEnv = {
  CMS_SERVICE_APP_ID: 'publicwebsite',
  CMS_SERVICE_ISSUER: 'https://publicwebsite-app-issuer-service.uniconhub.com',
  CMS_SERVICE_AUDIENCE: 'uniconhub-cms-api',
  CMS_SERVICE_SECRET_API_BASE_URL: 'https://system-sapi.uniconhub.com',
  CMS_SERVICE_SECRET_TOKEN: 'server-only-bearer-token',
  CMS_SERVICE_SECRET_CACHE_SECONDS: '300',
  CMS_SERVICE_SECRET_FETCH_TIMEOUT_MS: '5000',
}

const IDENTITY: FirstPartyTenantIdentity = {
  tenantId: 'tenant-a',
  siteId: 'site-a',
  deploymentId: 'site-a',
}

function runtimeSecret(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    tenantId: 'tenant-a',
    appId: 'publicwebsite',
    kid: 'kid-1',
    alg: 'RS256',
    issuer: ENV['CMS_SERVICE_ISSUER'],
    audience: ENV['CMS_SERVICE_AUDIENCE'],
    cmsBaseUrl: 'https://tenant-a.cms.example/api/v2',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    ...overrides,
  }
}

function makeTransport(body: unknown = runtimeSecret(), status = 200) {
  return vi.fn(
    async (request: { url: string; headers: Record<string, string>; timeoutMs: number }) => {
      void request
      return { status, body: JSON.stringify(body) }
    },
  )
}

describe('first-party credentials resolver (runtime fetch)', () => {
  it('fails closed when the global configuration is missing', async () => {
    const transportFn = makeTransport()
    const resolver = createFirstPartyCredentialResolver({ env: {}, transport: transportFn })
    const result = await resolver.get(IDENTITY)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('FIRST_PARTY_CREDENTIALS_UNAVAILABLE')
      expect(result.missing).toEqual(
        expect.arrayContaining([
          'CMS_SERVICE_ISSUER',
          'CMS_SERVICE_AUDIENCE',
          'CMS_SERVICE_SECRET_API_BASE_URL',
          'CMS_SERVICE_SECRET_TOKEN',
        ]),
      )
    }
    expect(transportFn).not.toHaveBeenCalled()
  })

  it('fetches the tenant secret with the bearer token and caches it (hit on second call)', async () => {
    const transportFn = makeTransport()
    const resolver = createFirstPartyCredentialResolver({
      env: ENV,
      transport: transportFn,
      now: () => 1_000_000,
    })

    const first = await resolver.get(IDENTITY)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.cacheHit).toBe(false)
      expect(first.credentials.tenantId).toBe('tenant-a')
      expect(first.credentials.siteId).toBe('site-a')
      expect(first.credentials.deploymentId).toBe('site-a')
      expect(first.credentials.kid).toBe('kid-1')
      expect(first.credentials.alg).toBe('RS256')
      expect(first.credentials.cmsBaseUrl).toBe('https://tenant-a.cms.example/api/v2')
    }

    const call = transportFn.mock.calls[0]![0]
    expect(call.url).toBe(
      'https://system-sapi.uniconhub.com/api/v1/first-party/runtime-secret?tenantId=tenant-a&appId=publicwebsite',
    )
    expect(call.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer server-only-bearer-token' }),
    )

    const second = await resolver.get(IDENTITY)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.cacheHit).toBe(true)
    expect(transportFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ok-false', runtimeSecret({ ok: false })],
    ['tenant-mismatch', runtimeSecret({ tenantId: 'tenant-b' })],
    ['app-mismatch', runtimeSecret({ appId: 'other-app' })],
    ['kid-missing', runtimeSecret({ kid: '' })],
    ['alg-unsupported', runtimeSecret({ alg: 'HS256' })],
    ['issuer-mismatch', runtimeSecret({ issuer: 'https://evil.example' })],
    ['audience-mismatch', runtimeSecret({ audience: 'other-audience' })],
    ['cms-base-url-invalid', runtimeSecret({ cmsBaseUrl: 'http://insecure.example/api/v2' })],
    ['private-key-invalid', runtimeSecret({ privateKeyPem: 'not-a-pem' })],
    ['invalid-payload', null],
  ])('fails closed on validation failure: %s', async (reason, payload) => {
    const transportFn = makeTransport(payload)
    const resolver = createFirstPartyCredentialResolver({ env: ENV, transport: transportFn })
    const result = await resolver.get(IDENTITY)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('FIRST_PARTY_CREDENTIALS_UNAVAILABLE')
      expect(result.reason).toBe(reason)
    }
  })

  it.each([401, 403, 404, 500])(
    'Secret API status %s becomes a safe unavailable error',
    async (status) => {
      const transportFn = makeTransport({ error: 'nope' }, status)
      const resolver = createFirstPartyCredentialResolver({ env: ENV, transport: transportFn })
      const result = await resolver.get(IDENTITY)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBe('FIRST_PARTY_CREDENTIALS_UNAVAILABLE')
        expect(result.reason).toBe(`secret-api-status-${status}`)
      }
      // The bearer token / response body never leak into the result.
      expect(JSON.stringify(result)).not.toContain('server-only-bearer-token')
    },
  )

  it('negative-caches failures for a few seconds only', async () => {
    let nowMs = 1_000_000
    const transportFn = makeTransport(null, 500)
    const resolver = createFirstPartyCredentialResolver({
      env: ENV,
      transport: transportFn,
      now: () => nowMs,
      negativeCacheMs: 5_000,
    })

    await resolver.get(IDENTITY)
    await resolver.get(IDENTITY)
    expect(transportFn).toHaveBeenCalledTimes(1)

    nowMs += 5_001
    await resolver.get(IDENTITY)
    expect(transportFn).toHaveBeenCalledTimes(2)
  })

  it('single-flight: concurrent cache misses make ONE Secret API call', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transportFn = vi.fn(async () => {
      await gate
      return { status: 200, body: JSON.stringify(runtimeSecret()) }
    })
    const resolver = createFirstPartyCredentialResolver({
      env: ENV,
      transport: transportFn,
      now: () => 1_000_000,
    })

    const first = resolver.get(IDENTITY)
    const second = resolver.get(IDENTITY)
    release?.()
    const [a, b] = await Promise.all([first, second])

    expect(transportFn).toHaveBeenCalledTimes(1)
    expect(a.ok && b.ok).toBe(true)
  })

  it('refreshes after the cache TTL expires', async () => {
    let nowMs = 1_000_000
    const transportFn = makeTransport()
    const resolver = createFirstPartyCredentialResolver({
      env: ENV,
      transport: transportFn,
      now: () => nowMs,
    })

    await resolver.get(IDENTITY)
    nowMs += 300_000 - 1
    await resolver.get(IDENTITY)
    expect(transportFn).toHaveBeenCalledTimes(1)

    nowMs += 2
    const refreshed = await resolver.get(IDENTITY)
    expect(transportFn).toHaveBeenCalledTimes(2)
    expect(refreshed.ok).toBe(true)
    if (refreshed.ok) expect(refreshed.cacheHit).toBe(false)
  })

  it('invalidate() forces a refetch so key rotation works without a redeploy', async () => {
    const transportFn = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(runtimeSecret({ kid: 'kid-1' })) })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(runtimeSecret({ kid: 'kid-2' })) })
    const resolver = createFirstPartyCredentialResolver({
      env: ENV,
      transport: transportFn,
      now: () => 1_000_000,
    })

    const first = await resolver.get(IDENTITY)
    expect(first.ok && first.credentials.kid).toBe('kid-1')

    resolver.invalidate('tenant-a')

    const second = await resolver.get(IDENTITY)
    expect(second.ok && second.credentials.kid).toBe('kid-2')
    expect(transportFn).toHaveBeenCalledTimes(2)
  })

  it('debug metadata never contains the private key or the bearer token', async () => {
    const resolver = createFirstPartyCredentialResolver({
      env: ENV,
      transport: makeTransport(),
      now: () => 1_000_000,
    })
    const result = await resolver.get(IDENTITY)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const metadata = toFirstPartyCredentialMetadata(result.credentials, {
      cacheHit: result.cacheHit,
      fetchedAt: result.fetchedAt,
    })
    expect(Object.keys(metadata).sort()).toEqual(
      [
        'alg',
        'audience',
        'cacheHit',
        'cmsBaseUrl',
        'fetchedAt',
        'issuer',
        'kid',
        'siteId',
        'tenantId',
      ].sort(),
    )
    const serialized = JSON.stringify(metadata)
    expect(serialized).not.toContain('PRIVATE KEY')
    expect(serialized).not.toContain('server-only-bearer-token')
  })
})

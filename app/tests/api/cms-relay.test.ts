import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CAS_CONFLICT_MESSAGE,
  createCmsReadCache,
  handleCmsRelay,
  mapCmsFailure,
  normalizePublicWritePayload,
  resolveCmsRelayRoute,
  sanitizeReadSearch,
  type CmsRelayDeps,
  type CmsRelayLogEntry,
  type CmsRelayRequest,
  type CmsRelaySite,
} from '@/lib/server/cmsRelay'
import { normalizeCmsBaseUrl } from '@/lib/server/cmsServiceFetch'
import type {
  FirstPartyCredentialResolver,
  FirstPartyCredentialResult,
  FirstPartyCredentials,
} from '@/lib/server/cmsFirstPartyCredentials'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const RELAY_ENV: Record<string, string> = {
  RELAY_SECRET: 'relay-secret',
  CMS_SERVICE_APP_ID: 'publicwebsite',
  CMS_SERVICE_ISSUER: 'https://issuer.example',
  CMS_SERVICE_AUDIENCE: 'cms-api',
  CMS_SERVICE_SECRET_API_BASE_URL: 'https://sapi.example',
  CMS_SERVICE_SECRET_TOKEN: 'server-only-bearer-token',
  CMS_SERVICE_TOKEN_TTL_SECONDS: '60',
  CMS_SERVICE_CMS_FETCH_TIMEOUT_MS: '5000',
}

function credentials(overrides: Partial<FirstPartyCredentials> = {}): FirstPartyCredentials {
  return {
    tenantId: 'tenant-a',
    siteId: 'site-a',
    deploymentId: 'site-a',
    appId: 'publicwebsite',
    kid: 'kid-1',
    alg: 'RS256',
    issuer: 'https://issuer.example',
    audience: 'cms-api',
    cmsBaseUrl: 'https://tenant-a.cms.example/api/v2',
    privateKeyPem: PRIVATE_KEY_PEM,
    ...overrides,
  }
}

function makeResolver(resultFactory?: () => FirstPartyCredentialResult): {
  resolver: FirstPartyCredentialResolver
  get: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
} {
  const get = vi.fn(async () =>
    resultFactory
      ? resultFactory()
      : ({
          ok: true,
          credentials: credentials(),
          cacheHit: false,
          fetchedAt: 1,
        } as FirstPartyCredentialResult),
  )
  const invalidate = vi.fn()
  return {
    resolver: { get, invalidate, clear: vi.fn() },
    get,
    invalidate,
  }
}

const SITE: CmsRelaySite = {
  ok: true,
  tenantId: 'tenant-a',
  siteId: 'site-a',
  allowedObjectTypes: ['reviews', 'menu-items'],
}

const UNKNOWN_SITE: CmsRelaySite = {
  ok: false,
  tenantId: '',
  siteId: '',
  allowedObjectTypes: [],
}

function makeRequest(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; search?: string } = {},
): CmsRelayRequest {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    normalized[name.toLowerCase()] = value
  }
  return {
    method,
    nextUrl: { pathname: path, search: options.search ?? '' },
    headers: { get: (name: string) => normalized[name.toLowerCase()] ?? null },
    text: async () => (options.body === undefined ? '' : JSON.stringify(options.body)),
  }
}

function cmsResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function makeDeps(overrides: Partial<CmsRelayDeps> = {}): CmsRelayDeps {
  return {
    env: RELAY_ENV,
    resolveSite: async () => SITE,
    credentialResolver: makeResolver().resolver,
    siteRateLimiter: { check: () => ({ allowed: true }), reset: vi.fn() },
    ipRateLimiter: { check: () => ({ allowed: true }), reset: vi.fn() },
    readCache: createCmsReadCache(),
    now: () => 1_000_000,
    log: () => {},
    fetchFn: vi.fn(async () => cmsResponse({ ok: true })) as unknown as typeof fetch,
    ...overrides,
  }
}

function fetchMock(response: Response | (() => Response)) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input
    void init
    return typeof response === 'function' ? response() : response.clone()
  })
}

describe('cms relay routing helpers', () => {
  it('maps the documented paths and methods', () => {
    expect(resolveCmsRelayRoute('GET', '/api/cms/objects/reviews')).toEqual({
      operation: 'read-list',
      method: 'GET',
      type: 'reviews',
    })
    expect(resolveCmsRelayRoute('GET', '/api/cms/objects/reviews/abc')).toEqual({
      operation: 'read-one',
      method: 'GET',
      type: 'reviews',
      id: 'abc',
    })
    expect(resolveCmsRelayRoute('POST', '/api/cms/objects/reviews/query')).toEqual({
      operation: 'query',
      method: 'POST',
      type: 'reviews',
    })
    expect(resolveCmsRelayRoute('POST', '/api/cms/objects/reviews')).toEqual({
      operation: 'create',
      method: 'POST',
      type: 'reviews',
    })
    expect(resolveCmsRelayRoute('PATCH', '/api/cms/objects/reviews/abc')).toEqual({
      operation: 'update',
      method: 'PATCH',
      type: 'reviews',
      id: 'abc',
    })
    expect(resolveCmsRelayRoute('PUT', '/api/cms/objects/reviews/abc')).toEqual({
      operation: 'update',
      method: 'PUT',
      type: 'reviews',
      id: 'abc',
    })
    expect(resolveCmsRelayRoute('POST', '/api/cms/objects/reviews/abc/extra')).toBeNull()
    expect(resolveCmsRelayRoute('GET', '/api/cms/objects/reviews/abc/extra')).toBeNull()
  })

  it('normalizes cmsBaseUrl so /api/v2 appears exactly once', () => {
    expect(normalizeCmsBaseUrl('https://tenant.cms.example')).toBe(
      'https://tenant.cms.example/api/v2',
    )
    expect(normalizeCmsBaseUrl('https://tenant.cms.example/')).toBe(
      'https://tenant.cms.example/api/v2',
    )
    expect(normalizeCmsBaseUrl('https://tenant.cms.example/api/v2')).toBe(
      'https://tenant.cms.example/api/v2',
    )
    expect(normalizeCmsBaseUrl('https://tenant.cms.example/api/v2/')).toBe(
      'https://tenant.cms.example/api/v2',
    )
    expect(normalizeCmsBaseUrl('https://tenant.cms.example/api/v2/objects')).toBe(
      'https://tenant.cms.example/api/v2',
    )
  })

  it('strips identity parameters from forwarded read query strings', () => {
    expect(sanitizeReadSearch('?tenantId=evil&limit=5')).toBe('?limit=5')
    expect(sanitizeReadSearch('?tenant=evil&appId=other')).toBe('')
  })
})

describe('cms relay — identity, allowlist and rate limits', () => {
  it('resolves the tenant from the trusted host, including alias domains', async () => {
    const resolveSite = vi.fn(async (host: string) =>
      host === 'www.a.example' || host === 'a.example' ? SITE : UNKNOWN_SITE,
    )
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    const deps = makeDeps({ resolveSite, fetchFn: fakeFetch as unknown as typeof fetch })

    const primary = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews', { headers: { host: 'www.a.example' } }),
      deps,
    )
    const alias = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews', { headers: { host: 'a.example' } }),
      deps,
    )
    expect(primary.status).toBe(200)
    expect(alias.status).toBe(200)
    expect(resolveSite).toHaveBeenCalledWith('www.a.example')

    const unknown = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews', { headers: { host: 'evil.example' } }),
      deps,
    )
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: string }).error).toBe('SITE_NOT_FOUND')
  })

  it('prefers the proxy-normalized x-gw-host header', async () => {
    const resolveSite = vi.fn(async () => SITE)
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews', {
        headers: { host: 'raw.example:3000', 'x-gw-host': 'site.example' },
      }),
      makeDeps({ resolveSite, fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(resolveSite).toHaveBeenCalledWith('site.example')
  })

  it('ignores browser-supplied tenantId headers and query parameters', async () => {
    const { resolver, get } = makeResolver()
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews', {
        headers: { 'x-tenant-id': 'evil-tenant', 'x-tenant': 'evil-tenant' },
        search: '?tenantId=evil-tenant&limit=5',
      }),
      makeDeps({ credentialResolver: resolver, fetchFn: fakeFetch as unknown as typeof fetch }),
    )

    expect(get).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      siteId: 'site-a',
      deploymentId: 'site-a',
    })
    const calledUrl = String(fakeFetch.mock.calls[0]![0])
    expect(calledUrl).toBe('https://tenant-a.cms.example/api/v2/objects/reviews?limit=5')
    expect(calledUrl).not.toContain('evil-tenant')
  })

  it('rejects object types outside the site allowlist (and unsafe type strings)', async () => {
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    const deps = makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch })

    const unlisted = await handleCmsRelay(makeRequest('GET', '/api/cms/objects/secret-type'), deps)
    expect(unlisted.status).toBe(400)
    expect(((await unlisted.json()) as { error: string }).error).toBe('OBJECT_TYPE_NOT_ALLOWED')

    const unsafe = await handleCmsRelay(makeRequest('GET', '/api/cms/objects/bad%20type'), deps)
    expect(unsafe.status).toBe(400)

    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('never allows DELETE', async () => {
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    const response = await handleCmsRelay(
      makeRequest('DELETE', '/api/cms/objects/reviews/abc'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('CMS_DELETE_NOT_ALLOWED')
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('rate-limits per site and per IP without calling the CMS', async () => {
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    const siteLimited = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({
        fetchFn: fakeFetch as unknown as typeof fetch,
        siteRateLimiter: { check: () => ({ allowed: false, retryAfterMs: 5000 }), reset: vi.fn() },
      }),
    )
    expect(siteLimited.status).toBe(429)

    const ipLimited = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({
        fetchFn: fakeFetch as unknown as typeof fetch,
        ipRateLimiter: { check: () => ({ allowed: false, retryAfterMs: 5000 }), reset: vi.fn() },
      }),
    )
    expect(ipLimited.status).toBe(429)
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('fails closed with 503 when the global service config is missing', async () => {
    const { resolver, get } = makeResolver()
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({
        env: { RELAY_SECRET: 'x' },
        credentialResolver: resolver,
        fetchFn: fakeFetch as unknown as typeof fetch,
      }),
    )
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: string }).error).toBe(
      'FIRST_PARTY_CREDENTIALS_UNAVAILABLE',
    )
    expect(get).not.toHaveBeenCalled()
  })

  it('fails closed when the credential resolver cannot produce credentials', async () => {
    const { resolver } = makeResolver(() => ({
      ok: false,
      error: 'FIRST_PARTY_CREDENTIALS_UNAVAILABLE',
    }))
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ credentialResolver: resolver, fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(503)
    expect(fakeFetch).not.toHaveBeenCalled()
  })
})

describe('cms relay — reads, writes and sanitization', () => {
  it('reads: forwards GET list/detail without write headers, sanitizes search', async () => {
    const fakeFetch = fetchMock(cmsResponse({ objects: [] }))
    const deps = makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch })

    await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews', { search: '?limit=10' }),
      deps,
    )
    const listCall = fakeFetch.mock.calls[0]!
    expect(String(listCall[0])).toBe('https://tenant-a.cms.example/api/v2/objects/reviews?limit=10')
    const listHeaders = listCall[1]?.headers as Record<string, string>
    expect(listHeaders['x-unicon-service-token']).toBeTruthy()
    expect(listHeaders['x-api-key']).toBeUndefined()
    expect(listHeaders['x-unicon-write-source']).toBeUndefined()

    await handleCmsRelay(makeRequest('GET', '/api/cms/objects/reviews/abc'), deps)
    expect(String(fakeFetch.mock.calls[1]![0])).toBe(
      'https://tenant-a.cms.example/api/v2/objects/reviews/abc',
    )
  })

  it('query: POST /objects/{type}/query forwards ONLY the strict query body', async () => {
    const fakeFetch = fetchMock(cmsResponse({ success: true, objects: [] }))
    await handleCmsRelay(
      makeRequest('POST', '/api/cms/objects/reviews/query', {
        body: { queryItems: [{ field: 'rating', operator: '>=', value: 4 }], limit: 10 },
      }),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    const call = fakeFetch.mock.calls[0]!
    expect(String(call[0])).toBe('https://tenant-a.cms.example/api/v2/objects/reviews/query')
    const body = JSON.parse(String(call[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({ queryItems: [{ field: 'rating', operator: '>=', value: 4 }], limit: 10 })
  })

  it('query: rejects bodies outside the confirmed contract without calling the CMS', async () => {
    const fakeFetch = fetchMock(cmsResponse({ success: true, objects: [] }))
    const deps = makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch })
    const invalidBodies: Record<string, unknown>[] = [
      { filters: [{ field: 'rating', op: '>=', value: 4 }] },
      { queryItems: [{ field: 'rating', operator: 'contains', value: 4 }] },
      { queryItems: [{ field: 'rating', operator: 'in', value: [] }] },
      {
        queryItems: [
          { field: 'rating', operator: 'in', value: Array.from({ length: 11 }, (_, i) => i) },
        ],
      },
      { limit: 201 },
      { queryItems: [], extra: true },
    ]
    for (const body of invalidBodies) {
      const response = await handleCmsRelay(
        makeRequest('POST', '/api/cms/objects/reviews/query', { body }),
        deps,
      )
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toBe('INVALID_QUERY')
    }
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('create: adds the service token + write-source, strips forged identity fields', async () => {
    const fakeFetch = fetchMock(cmsResponse({ id: 'new-1' }))
    const response = await handleCmsRelay(
      makeRequest('POST', '/api/cms/objects/reviews', {
        headers: { 'Idempotency-Key': 'idem-1' },
        body: {
          id: 'forged',
          tenantId: 'evil',
          created: 'x',
          permissions: { admin: true },
          _writeSource: 'cms',
          version: 9,
          data: { text: 'hi', tenantId: 'evil', lastUpdatedBy: 'forged' },
        },
      }),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )

    expect(response.status).toBe(200)
    const call = fakeFetch.mock.calls[0]!
    const headers = call[1]?.headers as Record<string, string>
    expect(headers['x-unicon-write-source']).toBe('public-website')
    expect(headers['x-unicon-service-token']).toBeTruthy()
    expect(headers['Idempotency-Key']).toBe('idem-1')
    expect(headers['x-api-key']).toBeUndefined()

    const body = JSON.parse(String(call[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({
      object: { data: { text: 'hi' } },
      requestEmail: 'service:publicwebsite',
    })
  })

  it('update: keeps the numeric CAS version, strips identity, adds write-source', async () => {
    const fakeFetch = fetchMock(cmsResponse({ id: 'abc' }))
    await handleCmsRelay(
      makeRequest('PATCH', '/api/cms/objects/reviews/abc', {
        body: { id: 'forged', version: 3, data: { text: 'v2' } },
      }),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    const call = fakeFetch.mock.calls[0]!
    expect(call[1]?.method).toBe('PATCH')
    expect((call[1]?.headers as Record<string, string>)['x-unicon-write-source']).toBe(
      'public-website',
    )
    const body = JSON.parse(String(call[1]?.body)) as Record<string, unknown>
    expect(body).toEqual({
      object: { data: { text: 'v2' } },
      version: 3,
      requestEmail: 'service:publicwebsite',
    })
  })

  it('caches published reads for the TTL and never caches writes', async () => {
    const fakeFetch = fetchMock(cmsResponse({ objects: [] }))
    let nowMs = 1_000_000
    const deps = makeDeps({
      fetchFn: fakeFetch as unknown as typeof fetch,
      readCache: createCmsReadCache(),
      now: () => nowMs,
    })

    const first = await handleCmsRelay(makeRequest('GET', '/api/cms/objects/reviews'), deps)
    const second = await handleCmsRelay(makeRequest('GET', '/api/cms/objects/reviews'), deps)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.headers.get('x-gw-cache')).toBe('hit')
    expect(fakeFetch).toHaveBeenCalledTimes(1)

    nowMs += 46_000
    const third = await handleCmsRelay(makeRequest('GET', '/api/cms/objects/reviews'), deps)
    expect(third.status).toBe(200)
    expect(fakeFetch).toHaveBeenCalledTimes(2)

    await handleCmsRelay(
      makeRequest('POST', '/api/cms/objects/reviews', { body: { data: { text: 'one' } } }),
      deps,
    )
    await handleCmsRelay(
      makeRequest('POST', '/api/cms/objects/reviews', { body: { data: { text: 'two' } } }),
      deps,
    )
    expect(fakeFetch).toHaveBeenCalledTimes(4)
  })

  it('returns safe error codes and never leaks tokens or keys', async () => {
    const fakeFetch = fetchMock(
      cmsResponse({ error: 'INTERNAL_DETAIL', stack: 'secret-stack' }, 500),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'CMS_UNAVAILABLE' })
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toContain('server-only-bearer-token')
    expect(text).not.toContain('x-unicon-service-token')
  })

  it('maps CMS failures to the documented safe codes', () => {
    expect(
      mapCmsFailure(
        400,
        JSON.stringify({ success: false, error: { code: 'OBJECT_TYPE_NOT_ALLOWED' } }),
      ),
    ).toEqual({ status: 400, error: 'OBJECT_TYPE_NOT_ALLOWED' })
    expect(
      mapCmsFailure(400, JSON.stringify({ success: false, error: { code: 'BAD_INPUT' } })),
    ).toEqual({ status: 400, error: 'CMS_REQUEST_REJECTED' })
    expect(mapCmsFailure(401, '')).toEqual({ status: 403, error: 'CMS_AUTH_FAILED' })
    expect(
      mapCmsFailure(403, JSON.stringify({ success: false, error: { code: 'FOLDER_NOT_ALLOWED' } })),
    ).toEqual({ status: 403, error: 'FOLDER_NOT_ALLOWED' })
    expect(
      mapCmsFailure(
        403,
        JSON.stringify({ success: false, error: { code: 'OBJECT_TYPE_NOT_ALLOWED' } }),
      ),
    ).toEqual({ status: 403, error: 'OBJECT_TYPE_NOT_ALLOWED' })
    expect(
      mapCmsFailure(
        403,
        JSON.stringify({ success: false, error: { code: 'PRIVATE_OBJECT_TYPE_BLOCKED' } }),
      ),
    ).toEqual({ status: 403, error: 'PRIVATE_OBJECT_TYPE_BLOCKED' })
    expect(
      mapCmsFailure(403, JSON.stringify({ success: false, error: { code: 'MISSING_SCOPE' } })),
    ).toEqual({ status: 403, error: 'CMS_AUTH_FAILED' })
    expect(
      mapCmsFailure(
        403,
        JSON.stringify({ success: false, error: { code: 'PUBLIC_WRITE_OWNERSHIP' } }),
      ),
    ).toEqual({ status: 403, error: 'PUBLIC_WRITE_OWNERSHIP' })
    expect(mapCmsFailure(404, '')).toEqual({ status: 404, error: 'CMS_OBJECT_NOT_FOUND' })
    expect(
      mapCmsFailure(
        409,
        JSON.stringify({
          success: false,
          error: { code: 'CAS_CONFLICT', details: { serverVersion: 4 } },
        }),
      ),
    ).toEqual({ status: 409, error: 'CAS_CONFLICT' })
    expect(mapCmsFailure(429, '')).toEqual({ status: 429, error: 'CMS_RATE_LIMITED' })
    expect(mapCmsFailure(503, '')).toEqual({ status: 502, error: 'CMS_UNAVAILABLE' })
  })

  it('passes the 429 Retry-After through safely as a retryable minute rate', async () => {
    const fakeFetch = fetchMock(cmsResponse({ error: 'RATE_LIMITED' }, 429, { 'retry-after': '2' }))
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(JSON.parse(await response.text())).toEqual({
      ok: false,
      error: 'CMS_RATE_LIMITED',
      reason: 'minute_rate',
      retryAfterMs: 2000,
    })
  })

  it('suggests its own backoff on 429 when the CMS omits Retry-After', async () => {
    const fakeFetch = fetchMock(
      cmsResponse({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED' } }, 429),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(JSON.parse(await response.text())).toEqual({
      ok: false,
      error: 'CMS_RATE_LIMITED',
      reason: 'minute_rate',
      retryAfterMs: 60000,
    })
  })

  it('marks MONTHLY_QUOTA_EXCEEDED as NOT retryable in a minute', async () => {
    const fakeFetch = fetchMock(
      cmsResponse({ success: false, error: { code: 'MONTHLY_QUOTA_EXCEEDED' } }, 429),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(JSON.parse(await response.text())).toEqual({
      ok: false,
      error: 'CMS_RATE_LIMITED',
      reason: 'monthly_quota',
      retryAfterMs: null,
    })
  })

  it('passes CAS version and ownership refusals through safely', async () => {
    const casFetch = fetchMock(
      cmsResponse(
        { success: false, error: { code: 'CAS_CONFLICT', details: { serverVersion: 4 } } },
        409,
      ),
    )
    const cas = await handleCmsRelay(
      makeRequest('PATCH', '/api/cms/objects/reviews/abc', {
        body: { object: { data: {} }, version: 3 },
      }),
      makeDeps({ fetchFn: casFetch as unknown as typeof fetch }),
    )
    expect(cas.status).toBe(409)
    expect(JSON.parse(await cas.text())).toEqual({
      ok: false,
      error: 'CAS_CONFLICT',
      serverVersion: 4,
      message: CAS_CONFLICT_MESSAGE,
    })

    const ownershipFetch = fetchMock(
      cmsResponse({ success: false, error: { code: 'PUBLIC_WRITE_OWNERSHIP' } }, 403),
    )
    const ownership = await handleCmsRelay(
      makeRequest('PATCH', '/api/cms/objects/reviews/abc', {
        body: { object: { data: {} }, version: 3 },
      }),
      makeDeps({ fetchFn: ownershipFetch as unknown as typeof fetch }),
    )
    expect(ownership.status).toBe(403)
    expect(JSON.parse(await ownership.text())).toEqual({
      ok: false,
      error: 'PUBLIC_WRITE_OWNERSHIP',
    })
  })

  it('passes the CMS rate/quota headers through', async () => {
    const fakeFetch = fetchMock(
      cmsResponse({ success: true, objects: [] }, 200, {
        'x-ratelimit-limit-minute': '600',
        'x-ratelimit-remaining-minute': '599',
        'x-quota-limit-month': '100000',
        'x-quota-remaining-month': '99999',
      }),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.headers.get('x-ratelimit-limit-minute')).toBe('600')
    expect(response.headers.get('x-quota-remaining-month')).toBe('99999')
  })

  it('normalizes CMS success:true to ok:true on the browser relay', async () => {
    const fakeFetch = fetchMock(
      cmsResponse({
        success: true,
        mainObjectType: 'reviews',
        count: 0,
        nextCursor: null,
        objects: [],
      }),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(JSON.parse(await response.text())).toEqual({
      ok: true,
      mainObjectType: 'reviews',
      count: 0,
      nextCursor: null,
      objects: [],
    })
  })

  it('normalizePublicWritePayload builds the CMS envelope and preserves folder', () => {
    expect(
      normalizePublicWritePayload(
        {
          id: 'x',
          data: { text: 'hi', tenantId: 'evil' },
          version: 5,
          folder: { name: 'July', ignored: 1 },
        },
        'POST',
        'anon-site-a',
      ),
    ).toEqual({
      object: { data: { text: 'hi' } },
      folder: { name: 'July' },
      requestEmail: 'anon-site-a',
    })
    expect(
      normalizePublicWritePayload({ object: { data: { text: 'hi' } }, version: 5 }, 'PATCH'),
    ).toEqual({ object: { data: { text: 'hi' } }, version: 5 })
    // Client-supplied requestEmail is stripped (never trusted for audit).
    expect(
      normalizePublicWritePayload(
        { data: { text: 'hi' }, requestEmail: 'evil@example.com' },
        'POST',
      )['requestEmail'],
    ).toBeUndefined()
  })
})

describe('cms relay — key rotation, logging and bundle isolation', () => {
  it('retries EXACTLY once on UNKNOWN_KEY with a freshly fetched key and token', async () => {
    const { resolver, get, invalidate } = makeResolver()
    const firstTokenHolder: string[] = []
    const fakeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>)['x-unicon-service-token']
      firstTokenHolder.push(token)
      if (firstTokenHolder.length === 1) {
        return cmsResponse(
          {
            success: false,
            error: {
              code: 'INVALID_SERVICE_TOKEN',
              message: 'unknown key',
              details: { reason: 'UNKNOWN_KEY' },
            },
          },
          401,
        )
      }
      return cmsResponse({ success: true })
    })

    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({
        credentialResolver: resolver,
        fetchFn: fakeFetch as unknown as typeof fetch,
        retryDelaysMs: [0],
      }),
    )

    expect(response.status).toBe(200)
    expect(fakeFetch).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith('tenant-a', 'publicwebsite')
    expect(firstTokenHolder[0]).not.toBe(firstTokenHolder[1])

    const decodePayload = (token: string) =>
      JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >
    expect(decodePayload(firstTokenHolder[0]!).jti).not.toBe(
      decodePayload(firstTokenHolder[1]!).jti,
    )
  })

  it('does not retry on other 401/403 responses', async () => {
    const fakeFetch = fetchMock(
      cmsResponse(
        {
          success: false,
          error: { code: 'INVALID_SERVICE_TOKEN', details: { reason: 'WRONG_TENANT' } },
        },
        401,
      ),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({ fetchFn: fakeFetch as unknown as typeof fetch }),
    )
    expect(response.status).toBe(403)
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('returns retryable CMS_KEY_PROPAGATING after the backoff sequence', async () => {
    const { resolver, get, invalidate } = makeResolver()
    const fakeFetch = fetchMock(
      cmsResponse(
        {
          success: false,
          error: { code: 'INVALID_SERVICE_TOKEN', details: { reason: 'UNKNOWN_KEY' } },
        },
        401,
      ),
    )
    const response = await handleCmsRelay(
      makeRequest('GET', '/api/cms/objects/reviews'),
      makeDeps({
        credentialResolver: resolver,
        fetchFn: fakeFetch as unknown as typeof fetch,
        retryDelaysMs: [0, 0, 0],
      }),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(JSON.parse(await response.text())).toEqual({
      ok: false,
      error: 'CMS_KEY_PROPAGATING',
      retryAfterMs: 5000,
    })
    expect(fakeFetch).toHaveBeenCalledTimes(4)
    expect(get).toHaveBeenCalledTimes(4)
    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it('logs only safe fields (no token, key, body or jti)', async () => {
    const entries: CmsRelayLogEntry[] = []
    const fakeFetch = fetchMock(cmsResponse({ ok: true }))
    await handleCmsRelay(
      makeRequest('POST', '/api/cms/objects/reviews', {
        body: { data: { text: 'private-customer-note' } },
      }),
      makeDeps({
        fetchFn: fakeFetch as unknown as typeof fetch,
        log: (entry) => entries.push(entry),
      }),
    )

    expect(entries).toHaveLength(1)
    expect(Object.keys(entries[0]!).sort()).toEqual(
      [
        'appId',
        'cacheHit',
        'durationMs',
        'kid',
        'objectType',
        'operation',
        'requestId',
        'siteId',
        'status',
        'tenantId',
      ].sort(),
    )
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain('PRIVATE KEY')
    expect(serialized).not.toContain('server-only-bearer-token')
    expect(serialized).not.toContain('private-customer-note')
  })

  it('keeps the service auth server-only: nodejs runtime and no secrets in browser SDK sources', () => {
    const routeSource = readFileSync(
      new URL('../../app/api/cms/objects/[[...path]]/route.ts', import.meta.url),
      'utf8',
    )
    expect(routeSource).toContain("export const runtime = 'nodejs'")

    const browserSurface = [
      readFileSync(new URL('../../lib/gw-sdk/sdk-source.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../lib/gw-sdk/widgets-source.ts', import.meta.url), 'utf8'),
    ].join('\n')
    expect(browserSurface).not.toContain('CMS_SERVICE_SECRET_TOKEN')
    expect(browserSurface).not.toContain('privateKeyPem')
    expect(browserSurface).not.toContain('x-unicon-service-token')
  })
})

import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  handleWidgetWrite,
  type WidgetWriteRequest,
  type WriteGrant,
} from '@/app/api/write/objects/[[...path]]/route'

function makeRequest(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): WidgetWriteRequest {
  const normalizedHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    normalizedHeaders[name.toLowerCase()] = value
  }
  return {
    method,
    nextUrl: { pathname: path },
    headers: { get: (name: string) => normalizedHeaders[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

const okResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Headers(),
  }) as unknown as Response

type RelayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const makeFetchMock = (response: Response) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response)

const quietSite = { ok: true, folderId: 'folder-a', tenant: 'easyorder', cmsApiBaseUrl: '', writeGrants: [] }
const grantSite = (writeGrants: WriteGrant[], cmsApiBaseUrl = '') => ({
  ok: true,
  folderId: 'folder-a',
  tenant: 'easyorder',
  cmsApiBaseUrl,
  writeGrants,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('widget write relay (SSOT 8.9, D-WFLOW-41, T-43)', () => {
  it('create: POSTs to the CMS v2 with the server-side key + write-source header', async () => {
    const fakeFetch = makeFetchMock(okResponse({ id: 'new-1' }))
    const response = await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews', 'POST', { data: { text: 'hi' } }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2/',
        apiKey: 'restricted-key',
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () => quietSite,
        sessionEmail: async () => null,
      },
    )
    expect(response.status).toBe(200)
    const call = fakeFetch.mock.calls[0]!
    expect(String(call[0])).toBe('https://cms.uniconhub.com/api/v2/objects/reviews')
    expect(call[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'restricted-key',
          'x-unicon-write-source': 'public-website',
        }),
      }),
    )
    const forwardedBody = JSON.parse(String(call[1]!.body)) as Record<string, unknown>
    expect(forwardedBody.data).toEqual({ text: 'hi' })
    expect(forwardedBody.requestEmail).toBe('anon-folder-a')
  })

  it('update: PATCHes with the object id and injects the session email when available', async () => {
    const fakeFetch = makeFetchMock(okResponse({ id: 'new-1' }))
    const response = await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews/new-1', 'PATCH', { data: { text: 'v2' }, version: 2 }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        apiKey: 'restricted-key',
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () => quietSite,
        sessionEmail: async () => 'visitor@example.com',
      },
    )
    expect(response.status).toBe(200)
    const call = fakeFetch.mock.calls[0]!
    expect(String(call[0])).toBe('https://cms.uniconhub.com/api/v2/objects/reviews/new-1')
    expect(call[1]!.method).toBe('PATCH')
    const forwardedBody = JSON.parse(String(call[1]!.body)) as Record<string, unknown>
    expect(forwardedBody.requestEmail).toBe('visitor@example.com')
  })

  it('forwards the Idempotency-Key header on create', async () => {
    const fakeFetch = makeFetchMock(okResponse({ id: 'new-1' }))
    await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews', 'POST', { data: {} }, { 'Idempotency-Key': 'idem-1' }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        apiKey: 'k',
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () => quietSite,
        sessionEmail: async () => null,
      },
    )
    expect(fakeFetch.mock.calls[0]![1]!.headers).toEqual(
      expect.objectContaining({ 'Idempotency-Key': 'idem-1' }),
    )
  })

  it('DELETE is refused locally (never forwarded)', async () => {
    const fakeFetch = makeFetchMock(okResponse({}))
    const response = await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews/new-1', 'DELETE', {}),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        apiKey: 'k',
        fetchFn: fakeFetch as unknown as typeof fetch,
      },
    )
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('PUBLIC_WRITE_DELETE_NOT_ALLOWED')
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it('passes the CMS 403/429 status + body through unchanged (the key IS the gate)', async () => {
    const fakeFetch = makeFetchMock(okResponse({ error: 'OBJECT_TYPE_NOT_ALLOWED' }, 403))
    const response = await handleWidgetWrite(
      makeRequest('/api/write/objects/private-type', 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        apiKey: 'k',
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () => quietSite,
        sessionEmail: async () => null,
      },
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('OBJECT_TYPE_NOT_ALLOWED')
  })

  it('503 when the relay has no configured key; 502 when the CMS is unreachable', async () => {
    const noKey = await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews', 'POST', { data: {} }),
      { baseUrl: 'https://cms.uniconhub.com/api/v2', apiKey: undefined, fetchFn: (async () => okResponse({})) as never },
    )
    expect(noKey.status).toBe(503)

    const unreachable = await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews', 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        apiKey: 'k',
        fetchFn: (async () => {
          throw new Error('down')
        }) as unknown as typeof fetch,
        resolveSite: async () => quietSite,
        sessionEmail: async () => null,
      },
    )
    expect(unreachable.status).toBe(502)
  })
})

describe('widget write relay - grant matrix (D-WFLOW-43, T-46)', () => {
  const ordersType = 'restaurant-order-manager-easyorder'

  function routingFetch(lookupResponse: Response, writeResponse: Response) {
    return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).includes('/keys/')) return lookupResponse
      return writeResponse
    })
  }

  it('writeGrant match: fetches the secret by name from the key-lookup endpoint and writes with it', async () => {
    vi.stubEnv('GW_CMS_KEY_LOOKUP_API_KEY', 'lookup-cred')
    const fakeFetch = routingFetch(
      okResponse({ key: { name: 'orders-key', secret: 'grant-secret', scope: 'objects:write' } }),
      okResponse({ id: 'new-1' }),
    )
    const response = await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: { items: [] } }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
        sessionEmail: async () => null,
        keyLookupCache: new Map(),
      },
    )
    expect(response.status).toBe(200)
    const lookupCall = fakeFetch.mock.calls.find((call) => String(call[0]).includes('/keys/'))
    expect(String(lookupCall?.[0])).toBe('https://cms.uniconhub.com/api/v2/keys/orders-key')
    expect((lookupCall?.[1] as RequestInit | undefined)?.headers).toEqual(
      expect.objectContaining({ 'x-api-key': 'lookup-cred', 'x-source-tenant': 'easyorder' }),
    )
    const writeCall = fakeFetch.mock.calls.find((call) => !String(call[0]).includes('/keys/'))
    expect((writeCall?.[1] as RequestInit | undefined)?.headers).toEqual(
      expect.objectContaining({ 'x-api-key': 'grant-secret' }),
    )
  })

  it('caches the key secret for 60 s (one lookup per tenant + keyName)', async () => {
    vi.stubEnv('GW_CMS_KEY_LOOKUP_API_KEY', 'lookup-cred')
    let lookupCalls = 0
    const fakeFetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).includes('/keys/')) {
        lookupCalls += 1
        return okResponse({ key: { name: 'orders-key', secret: 's' } })
      }
      return okResponse({ id: 'x' })
    })
    const deps = {
      baseUrl: 'https://cms.uniconhub.com/api/v2',
      fetchFn: fakeFetch as unknown as typeof fetch,
      resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
      sessionEmail: async () => null,
      keyLookupCache: new Map<string, { secret: string; expiresAt: number }>(),
    }
    await handleWidgetWrite(makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }), deps)
    await handleWidgetWrite(makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }), deps)
    expect(lookupCalls).toBe(1)
  })

  it('403 GRANT_NOT_ALLOWED when the site has grants but none covers the type', async () => {
    const response = await handleWidgetWrite(
      makeRequest('/api/write/objects/other-type', 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: (async () => okResponse({})) as never,
        resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
      },
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('GRANT_NOT_ALLOWED')
  })

  it('lookup 404 -> 502 KEY_NOT_FOUND; lookup 403 -> 502 with the CMS error', async () => {
    vi.stubEnv('GW_CMS_KEY_LOOKUP_API_KEY', 'lookup-cred')
    const notFound = await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: (async () => okResponse({ error: 'KEY_NOT_FOUND' }, 404)) as unknown as typeof fetch,
        resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
        keyLookupCache: new Map(),
      },
    )
    expect(notFound.status).toBe(502)
    expect(((await notFound.json()) as { error: string }).error).toBe('KEY_NOT_FOUND')

    const denied = await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: (async () => okResponse({ error: 'GRANT_NOT_ALLOWED' }, 403)) as unknown as typeof fetch,
        resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
        keyLookupCache: new Map(),
      },
    )
    expect(denied.status).toBe(502)
    expect(((await denied.json()) as { error: string }).error).toBe('GRANT_NOT_ALLOWED')
  })

  it('503 KEY_LOOKUP_NOT_CONFIGURED when a grant matches but no lookup credential exists', async () => {
    const response = await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: (async () => okResponse({})) as never,
        resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
      },
    )
    expect(response.status).toBe(503)
    expect(((await response.json()) as { error: string }).error).toBe('KEY_LOOKUP_NOT_CONFIGURED')
  })

  it('legacy env key applies when the site has no writeGrants', async () => {
    vi.stubEnv('GW_CMS_WRITE_API_KEY', 'legacy-key')
    const fakeFetch = makeFetchMock(okResponse({ id: 'new-1' }))
    const response = await handleWidgetWrite(
      makeRequest('/api/write/objects/reviews', 'POST', { data: { text: 'hi' } }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () => quietSite,
        sessionEmail: async () => null,
      },
    )
    expect(response.status).toBe(200)
    const headers = fakeFetch.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('legacy-key')
  })

  it('SECRET_NOT_STORED (409) -> 502 with a rotate-once hint (Q-43)', async () => {
    vi.stubEnv('GW_CMS_KEY_LOOKUP_API_KEY', 'lookup-cred')
    const response = await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }),
      {
        baseUrl: 'https://cms.uniconhub.com/api/v2',
        fetchFn: (async () => okResponse({ ok: false, error: 'SECRET_NOT_STORED' }, 409)) as unknown as typeof fetch,
        resolveSite: async () => grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }]),
        keyLookupCache: new Map(),
      },
    )
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string; hint?: string }
    expect(body.error).toBe('SECRET_NOT_STORED')
    expect(body.hint).toContain('Rotate this key once')
  })

  it('per-grant cmsBaseUrl targets the lookup AND the write at the tenant CMS host (Q-43)', async () => {
    vi.stubEnv('GW_CMS_KEY_LOOKUP_API_KEY', 'lookup-cred')
    const fakeFetch = routingFetch(
      okResponse({ key: { name: 'orders-key', secret: 'grant-secret' } }),
      okResponse({ id: 'new-1' }),
    )
    const response = await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }),
      {
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () =>
          grantSite([
            { keyName: 'orders-key', objectTypes: [ordersType], cmsBaseUrl: 'https://easyorder.cms.uniconhub.com/api/v2' },
          ]),
        sessionEmail: async () => null,
        keyLookupCache: new Map(),
      },
    )
    expect(response.status).toBe(200)
    const lookupCall = fakeFetch.mock.calls.find((call) => String(call[0]).includes('/keys/'))
    expect(String(lookupCall?.[0])).toBe('https://easyorder.cms.uniconhub.com/api/v2/keys/orders-key')
    const writeCall = fakeFetch.mock.calls.find((call) => !String(call[0]).includes('/keys/'))
    expect(String(writeCall?.[0])).toBe('https://easyorder.cms.uniconhub.com/api/v2/objects/restaurant-order-manager-easyorder')
  })

  it('site cmsApiBaseUrl applies when the grant has no cmsBaseUrl', async () => {
    vi.stubEnv('GW_CMS_KEY_LOOKUP_API_KEY', 'lookup-cred')
    const fakeFetch = routingFetch(
      okResponse({ key: { name: 'orders-key', secret: 'grant-secret' } }),
      okResponse({ id: 'new-1' }),
    )
    await handleWidgetWrite(
      makeRequest(`/api/write/objects/${ordersType}`, 'POST', { data: {} }),
      {
        fetchFn: fakeFetch as unknown as typeof fetch,
        resolveSite: async () =>
          grantSite([{ keyName: 'orders-key', objectTypes: [ordersType] }], 'https://easyorder.cms.uniconhub.com/api/v2'),
        sessionEmail: async () => null,
        keyLookupCache: new Map(),
      },
    )
    const lookupCall = fakeFetch.mock.calls.find((call) => String(call[0]).includes('/keys/'))
    expect(String(lookupCall?.[0])).toBe('https://easyorder.cms.uniconhub.com/api/v2/keys/orders-key')
  })
})

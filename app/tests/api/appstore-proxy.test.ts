import { describe, expect, it, vi } from 'vitest'
import {
  APP_STORE_LIBRARY_TYPE,
  handleAppstoreProxy,
  type AppstoreProxyRequest,
} from '@/app/api/appstore/objects/[[...path]]/route'

function makeRequest(path: string, method = 'GET'): AppstoreProxyRequest {
  return { method, nextUrl: { pathname: path } }
}

function okStoreResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response
}

describe('appstore proxy (website-html-tool publish contract Step C.1)', () => {
  it('proxies the catalog list same-origin with the server-side api key', async () => {
    const fakeFetch = vi.fn(async () => okStoreResponse({ objects: [{ gwAppName: 'w1' }] }))
    const response = await handleAppstoreProxy(
      makeRequest('/api/appstore/objects/website-html-tool-library-applicationstore'),
      {
        baseUrl: 'https://applicationstore.uniconhub.com/api/v2/',
        token: 'secret-key',
        fetchFn: fakeFetch as unknown as typeof fetch,
      },
    )
    expect(response.status).toBe(200)
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://applicationstore.uniconhub.com/api/v2/objects/website-html-tool-library-applicationstore',
      expect.objectContaining({
        headers: { 'x-api-key': 'secret-key' },
      }),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    const body = (await response.json()) as { objects: unknown[] }
    expect(body.objects).toEqual([{ gwAppName: 'w1' }])
  })

  it('proxies a record detail by objectId', async () => {
    const fakeFetch = vi.fn(async (input: string | URL | Request) =>
      okStoreResponse({ object: { gwAppName: 'w1' } }),
    )
    const response = await handleAppstoreProxy(
      makeRequest(`/api/appstore/objects/${APP_STORE_LIBRARY_TYPE}/object-123`),
      {
        baseUrl: 'https://applicationstore.uniconhub.com/api/v2',
        fetchFn: fakeFetch as unknown as typeof fetch,
      },
    )
    expect(response.status).toBe(200)
    expect(String(fakeFetch.mock.calls[0]?.[0])).toContain(
      '/objects/website-html-tool-library-applicationstore/object-123',
    )
  })

  it('rejects non-GET methods and unsupported types', async () => {
    const notAllowed = await handleAppstoreProxy(
      makeRequest(`/api/appstore/objects/${APP_STORE_LIBRARY_TYPE}`, 'POST'),
      { baseUrl: 'https://store.example', fetchFn: (async () => okStoreResponse({})) as never },
    )
    expect(notAllowed.status).toBe(405)

    const unsupported = await handleAppstoreProxy(makeRequest('/api/appstore/objects/private-orders'), {
      baseUrl: 'https://store.example',
      fetchFn: (async () => okStoreResponse({})) as never,
    })
    expect(unsupported.status).toBe(404)
  })

  it('answers 502 when the store is unreachable or errors', async () => {
    const unreachable = await handleAppstoreProxy(
      makeRequest(`/api/appstore/objects/${APP_STORE_LIBRARY_TYPE}`),
      {
        baseUrl: 'https://store.example',
        fetchFn: (async () => {
          throw new Error('boom')
        }) as never,
      },
    )
    expect(unreachable.status).toBe(502)

    const storeError = await handleAppstoreProxy(
      makeRequest(`/api/appstore/objects/${APP_STORE_LIBRARY_TYPE}`),
      {
        baseUrl: 'https://store.example',
        fetchFn: (async () => ({ ok: false, status: 503, text: async () => 'x' })) as never,
      },
    )
    expect(storeError.status).toBe(502)
  })
})

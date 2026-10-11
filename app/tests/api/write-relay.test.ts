import { describe, expect, it, vi } from 'vitest'
import {
  handleWidgetWrite,
  type WidgetWriteRequest,
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
  ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: new Headers() }) as unknown as Response

type RelayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const makeFetchMock = (response: Response) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response)

const quietSite = { ok: true, folderId: 'folder-a' }

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

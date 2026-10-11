import { describe, expect, it, vi } from 'vitest'
import {
  handleExternalFetch,
  hostAllowed,
  type ExternalFetchRequest,
} from '@/app/api/external/fetch/route'

function makeRequest(body: unknown, headers: Record<string, string> = {}): ExternalFetchRequest {
  return {
    method: 'POST',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

const okResponse = (body: string, status = 200): Response =>
  ({ ok: status < 400, status, text: async () => body }) as unknown as Response

const siteWith = (hosts: string[]) => async () => ({ ok: true, externalApiHosts: hosts })

type RelayFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const makeFetchMock = (response: Response) =>
  vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response)

describe('hostAllowed (per-site allowlist matcher)', () => {
  it('matches exact hosts and *.domain wildcards, case-insensitively', () => {
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true)
    expect(hostAllowed('API.EXAMPLE.COM', ['api.example.com'])).toBe(true)
    expect(hostAllowed('x.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('other.com', ['api.example.com'])).toBe(false)
  })
})

describe('outside-API relay (Q-41 (a), D-WFLOW-42, T-45)', () => {
  it('posts to an allowlisted https host and returns the body', async () => {
    const fakeFetch = makeFetchMock(okResponse('pong'))
    const response = await handleExternalFetch(
      makeRequest({ url: 'https://api.example.com/ping', method: 'GET' }),
      { fetchFn: fakeFetch as unknown as typeof fetch, resolveSite: siteWith(['api.example.com']) },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; body: string }
    expect(body).toEqual({ ok: true, status: 200, body: 'pong' })
    expect(String(fakeFetch.mock.calls[0]![0])).toBe('https://api.example.com/ping')
  })

  it('rejects hosts outside the per-site allowlist (403)', async () => {
    const response = await handleExternalFetch(
      makeRequest({ url: 'https://evil.com/x' }),
      { fetchFn: (async () => okResponse('')) as never, resolveSite: siteWith(['api.example.com']) },
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('EXTERNAL_HOST_NOT_ALLOWED')
  })

  it('rejects non-https URLs and credential-in-URL forms', async () => {
    const http = await handleExternalFetch(
      makeRequest({ url: 'http://api.example.com/x' }),
      { fetchFn: (async () => okResponse('')) as never, resolveSite: siteWith(['api.example.com']) },
    )
    expect(http.status).toBe(400)
    expect(((await http.json()) as { error: string }).error).toBe('https-only')

    const creds = await handleExternalFetch(
      makeRequest({ url: 'https://user:pass@api.example.com/x' }),
      { fetchFn: (async () => okResponse('')) as never, resolveSite: siteWith(['api.example.com']) },
    )
    expect(creds.status).toBe(400)
  })

  it('whitelists methods and strips hop-by-hop request headers', async () => {
    const fakeFetch = makeFetchMock(okResponse('ok'))
    await handleExternalFetch(
      makeRequest({
        url: 'https://api.example.com/post',
        method: 'POST',
        headers: { 'X-Custom': 'yes', Cookie: 'secret=1', Host: 'evil' },
        body: 'payload',
      }),
      { fetchFn: fakeFetch as unknown as typeof fetch, resolveSite: siteWith(['api.example.com']) },
    )
    const init = fakeFetch.mock.calls[0]![1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe('payload')
    const sentHeaders = init.headers as Record<string, string>
    expect(sentHeaders['X-Custom']).toBe('yes')
    expect(sentHeaders['Cookie']).toBeUndefined()
    expect(sentHeaders['Host']).toBeUndefined()

    const trace = await handleExternalFetch(
      makeRequest({ url: 'https://api.example.com/x', method: 'TRACE' }),
      { fetchFn: fakeFetch as unknown as typeof fetch, resolveSite: siteWith(['api.example.com']) },
    )
    expect(trace.status).toBe(400)
  })

  it('fails open-loud (502) when the third party is unreachable', async () => {
    const response = await handleExternalFetch(
      makeRequest({ url: 'https://api.example.com/x' }),
      {
        fetchFn: (async () => {
          throw new Error('down')
        }) as unknown as typeof fetch,
        resolveSite: siteWith(['api.example.com']),
      },
    )
    expect(response.status).toBe(502)
  })
})

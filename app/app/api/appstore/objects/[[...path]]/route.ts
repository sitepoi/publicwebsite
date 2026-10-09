import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/appstore/objects/<type>[/<id>] — SAME-ORIGIN proxy for the
 * platform-owned application store public API v2 (website-html-tool widget
 * publish contract, Step C.1 "proxied server-side to the same origin — the
 * recommended option").
 *
 * Widgets and the published page fetch this route instead of the store host
 * directly, so their data requests are same-origin: no CORS surface, no
 * browser-held API keys (x-api-key stays server-side). The response carries
 * Access-Control-Allow-Origin: * anyway for external consumers of the
 * public catalog.
 *
 * Only the library type is served (read-only GET) — everything else 404s.
 * A failed store fetch is a 502 with a readable error (fail-open callers
 * keep rendering).
 */

export const dynamic = 'force-dynamic'

export const APP_STORE_LIBRARY_TYPE = 'website-html-tool-library-applicationstore'
const DEFAULT_STORE_API_URL = 'https://applicationstore.uniconhub.com/api/v2'
const FETCH_TIMEOUT_MS = 10_000

export interface AppstoreProxyDeps {
  baseUrl?: string
  token?: string
  fetchFn?: typeof fetch
}

export interface AppstoreProxyRequest {
  method: string
  nextUrl: { pathname: string }
}

export async function handleAppstoreProxy(
  request: AppstoreProxyRequest,
  deps: AppstoreProxyDeps = {},
): Promise<NextResponse> {
  if (request.method !== 'GET') {
    return new NextResponse('Method Not Allowed', { status: 405 })
  }
  const baseUrl = (deps.baseUrl ?? process.env.GW_APP_STORE_API_URL ?? DEFAULT_STORE_API_URL)
    .replace(/\/+$/, '')
  const token = deps.token ?? process.env.GW_APP_STORE_API_KEY
  const fetchFn = deps.fetchFn ?? fetch

  const segments = request.nextUrl.pathname
    .replace(/^\/api\/appstore\/objects\/?/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  const type = segments[0]
  const id = segments[1]
  if (!type || type !== APP_STORE_LIBRARY_TYPE || segments.length > 2) {
    return NextResponse.json({ error: 'unsupported object type' }, { status: 404 })
  }
  const target = id
    ? `${baseUrl}/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
    : `${baseUrl}/objects/${encodeURIComponent(type)}`

  try {
    const response = await fetchFn(target, {
      headers: token ? { 'x-api-key': token } : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) {
      return NextResponse.json({ error: `store responded ${response.status}` }, { status: 502 })
    }
    const body = await response.text()
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, s-maxage=60',
      },
    })
  } catch {
    return NextResponse.json({ error: 'application store unreachable' }, { status: 502 })
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleAppstoreProxy(request)
}

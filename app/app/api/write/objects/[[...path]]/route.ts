import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST/PATCH/PUT /api/write/objects/<type>[/<id>] — same-origin WRITE relay
 * for widget write-back (SSOT section 8.9, D-WFLOW-41, task T-43).
 *
 * Widgets NEVER touch Firestore and NEVER hold API keys: this route injects
 * the site's tenant-scoped RESTRICTED write key server-side (scope
 * `objects:write`, per-key `allowedObjectTypes`, rate limits + quotas) and
 * forwards to the CMS v2 object endpoints with the header
 * `x-unicon-write-source: public-website`. The CMS applies the source-based
 * protection for that header: payload sanitization, the `_writeSource`
 * ownership marker and delete refusal. The key IS the gate — a CMS 403/429
 * response passes through unchanged so the widget can surface it.
 *
 * - POST  /api/write/objects/<type>            create (Idempotency-Key forwarded)
 * - PATCH /api/write/objects/<type>/<id>       update (body.version → CAS)
 * - DELETE                                     403 PUBLIC_WRITE_DELETE_NOT_ALLOWED
 */

export const dynamic = 'force-dynamic'

const DEFAULT_CMS_WRITE_API_URL = 'https://cms.uniconhub.com/api/v2'
const FETCH_TIMEOUT_MS = 15_000

export interface WidgetWriteSite {
  ok: boolean
  folderId: string
}

export interface WidgetWriteDeps {
  baseUrl?: string
  apiKey?: string
  fetchFn?: typeof fetch
  resolveSite?: (host: string) => Promise<WidgetWriteSite>
  sessionEmail?: (cookieHeader: string | null, host: string) => Promise<string | null>
}

export interface WidgetWriteRequest {
  method: string
  nextUrl: { pathname: string }
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Best-effort site resolution for the anon identity marker (never fatal). */
async function defaultResolveSite(host: string): Promise<WidgetWriteSite> {
  try {
    const { getResolverStack } = await import('@/lib/resolver')
    const result = await getResolverStack().resolveSite(host)
    return { ok: result.ok, folderId: result.ok ? result.site.folderId : '' }
  } catch {
    return { ok: false, folderId: '' }
  }
}

/** Visitor email from the gw-session cookie resolved against the site's
 * tenant (never fatal; null when absent/unverifiable). */
async function defaultSessionEmail(
  cookieHeader: string | null,
  host: string,
): Promise<string | null> {
  if (!cookieHeader) return null
  try {
    const { SESSION_COOKIE, getTenantAuthService } = await import('@/lib/auth')
    const { getResolverStack } = await import('@/lib/resolver')
    const entry = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    if (!entry) return null
    const session = entry.slice(SESSION_COOKIE.length + 1)
    const siteResult = await getResolverStack().resolveSite(host)
    if (!siteResult.ok) return null
    const authService = await getTenantAuthService(siteResult.site.tenant)
    const user = await authService.userFromSessionCookie(session)
    return user?.email ?? null
  } catch {
    return null
  }
}

export async function handleWidgetWrite(
  request: WidgetWriteRequest,
  deps: WidgetWriteDeps = {},
): Promise<NextResponse> {
  if (request.method === 'DELETE') {
    return NextResponse.json({ error: 'PUBLIC_WRITE_DELETE_NOT_ALLOWED' }, { status: 403 })
  }
  if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'PUT') {
    return new NextResponse('Method Not Allowed', { status: 405 })
  }

  const baseUrl = (deps.baseUrl ?? process.env.GW_CMS_WRITE_API_URL ?? DEFAULT_CMS_WRITE_API_URL)
    .replace(/\/+$/, '')
  const apiKey = deps.apiKey ?? process.env.GW_CMS_WRITE_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'WRITE_RELAY_NOT_CONFIGURED',
        hint: 'Set GW_CMS_WRITE_API_KEY (and optionally GW_CMS_WRITE_API_URL) in the deployment environment and redeploy.',
      },
      { status: 503 },
    )
  }
  const fetchFn = deps.fetchFn ?? fetch

  const segments = request.nextUrl.pathname
    .replace(/^\/api\/write\/objects\/?/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  const type = segments[0]
  const id = segments[1]
  if (!type || segments.length > 2) {
    return NextResponse.json({ error: 'invalid object path' }, { status: 404 })
  }

  const payload = await request.json().catch(() => null)
  if (!isRecord(payload)) {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 })
  }
  const data = isRecord(payload['data']) ? payload['data'] : payload

  // Visitor identity (SSOT section 8.9): the verified session email when
  // available, else a per-site anonymous marker. Always injected server-side
  // (never taken from the client payload).
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const site = await (deps.resolveSite ?? defaultResolveSite)(host)
  const email = await (deps.sessionEmail ?? defaultSessionEmail)(
    request.headers.get('cookie'),
    host,
  )
  const requestEmail = email ?? `anon-${site.ok && site.folderId ? site.folderId : 'visitor'}`
  const body: Record<string, unknown> = { ...payload, data, requestEmail }

  const target = id
    ? `${baseUrl}/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
    : `${baseUrl}/objects/${encodeURIComponent(type)}`
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'x-unicon-write-source': 'public-website',
    'Content-Type': 'application/json',
  }
  const idempotencyKey = request.headers.get('Idempotency-Key')
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  try {
    const response = await fetchFn(target, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    const responseBody = await response.text()
    const passthrough = new Headers()
    for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-quota-limit', 'x-quota-remaining']) {
      const value = response.headers.get(name)
      if (value) passthrough.set(name, value)
    }
    passthrough.set('Content-Type', response.headers.get('Content-Type') ?? 'application/json')
    return new NextResponse(responseBody, { status: response.status, headers: passthrough })
  } catch {
    return NextResponse.json({ error: 'cms write relay unreachable' }, { status: 502 })
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleWidgetWrite(request)
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  return handleWidgetWrite(request)
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return handleWidgetWrite(request)
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json({ error: 'PUBLIC_WRITE_DELETE_NOT_ALLOWED' }, { status: 403 })
}

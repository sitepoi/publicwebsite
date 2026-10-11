import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/external/fetch — same-origin OUTSIDE-API relay for widgets
 * (SSOT Q-41 answered (a), D-WFLOW-42, task T-45).
 *
 * Widgets integrate with completely outside systems over THEIR published
 * APIs through this relay (the requestFetch pattern): the target host must
 * be listed in the site's `data.websiteConfig.externalApiHosts` (the
 * per-site host allowlist IS the SSRF guard), https-only, method whitelist,
 * timeout + response-size caps, redirects refused. Widget code never
 * carries third-party credentials.
 *
 * Body: { url, method?, headers?, body? } → { ok, status, body, truncated? }
 * or { ok: false, status, error }.
 */

export const dynamic = 'force-dynamic'

const MAX_RESPONSE_BYTES = 512_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 15_000
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH'])
/** Hop-by-hop / identity headers that must never leave the server. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
])

export interface ExternalFetchSite {
  ok: boolean
  externalApiHosts: string[]
}

export interface ExternalFetchDeps {
  fetchFn?: typeof fetch
  resolveSite?: (host: string) => Promise<ExternalFetchSite>
}

export interface ExternalFetchRequest {
  method: string
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function defaultResolveSite(host: string): Promise<ExternalFetchSite> {
  try {
    const { getResolverStack } = await import('@/lib/resolver')
    const result = await getResolverStack().resolveSite(host)
    return {
      ok: result.ok,
      externalApiHosts: result.ok ? (result.site.settings.externalApiHosts ?? []) : [],
    }
  } catch {
    return { ok: false, externalApiHosts: [] }
  }
}

/** hostMatches-style allowlist check: exact host or `*.domain` wildcard. */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const normalized = host.toLowerCase()
  return allowlist.some((pattern) => {
    const entry = pattern.trim().toLowerCase()
    if (!entry) return false
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1)
      return normalized.endsWith(suffix) && normalized.length > suffix.length
    }
    return normalized === entry
  })
}

export async function handleExternalFetch(
  request: ExternalFetchRequest,
  deps: ExternalFetchDeps = {},
): Promise<NextResponse> {
  if (request.method !== 'POST') {
    return new NextResponse('Method Not Allowed', { status: 405 })
  }
  const fetchFn = deps.fetchFn ?? fetch

  const payload = await request.json().catch(() => null)
  if (!isRecord(payload) || typeof payload['url'] !== 'string' || payload['url'].length === 0) {
    return NextResponse.json({ ok: false, status: 400, error: 'invalid-url' }, { status: 400 })
  }
  const urlString = payload['url']
  let targetUrl: URL
  try {
    targetUrl = new URL(urlString)
  } catch {
    return NextResponse.json({ ok: false, status: 400, error: 'invalid-url' }, { status: 400 })
  }
  if (targetUrl.protocol !== 'https:') {
    return NextResponse.json(
      { ok: false, status: 400, error: 'https-only' },
      { status: 400 },
    )
  }
  if (targetUrl.username || targetUrl.password) {
    return NextResponse.json(
      { ok: false, status: 400, error: 'credentials-in-url-not-allowed' },
      { status: 400 },
    )
  }

  const method = typeof payload['method'] === 'string' ? payload['method'].toUpperCase() : 'GET'
  if (!ALLOWED_METHODS.has(method)) {
    return NextResponse.json({ ok: false, status: 400, error: 'method-not-allowed' }, { status: 400 })
  }

  // The site's host allowlist IS the gate (and the SSRF guard).
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const site = await (deps.resolveSite ?? defaultResolveSite)(host)
  if (!site.ok || !hostAllowed(targetUrl.hostname, site.externalApiHosts)) {
    return NextResponse.json(
      { ok: false, status: 403, error: 'EXTERNAL_HOST_NOT_ALLOWED' },
      { status: 403 },
    )
  }

  const requestHeaders: Record<string, string> = {}
  if (isRecord(payload['headers'])) {
    for (const [name, value] of Object.entries(payload['headers'] as Record<string, unknown>)) {
      if (typeof value === 'string' && !FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
        requestHeaders[name] = value
      }
    }
  }

  const timeoutMs =
    typeof payload['timeoutMs'] === 'number' && payload['timeoutMs'] > 0
      ? Math.min(payload['timeoutMs'], MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS

  try {
    const response = await fetchFn(targetUrl.toString(), {
      method,
      headers: requestHeaders,
      body: typeof payload['body'] === 'string' ? payload['body'] : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      cache: 'no-store',
    })
    const raw = await response.text()
    const truncated = raw.length > MAX_RESPONSE_BYTES
    const body = truncated ? raw.slice(0, MAX_RESPONSE_BYTES) : raw
    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      body,
      ...(truncated ? { truncated: true } : {}),
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, status: 502, error: error instanceof Error ? error.message : 'fetch failed' },
      { status: 502 },
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleExternalFetch(request)
}

import { NextResponse, type NextRequest } from 'next/server'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { normalizeHost } from '@/lib/resolver/host'

/**
 * Request proxy (Section 5 / C2; Next 16 convention — the plan's
 * `middleware.ts` was renamed to `proxy.ts`, same semantics, ADR-002):
 * - host normalization (lowercase, strip port) → x-gw-host header
 * - traffic rules (blocked bots/UA/denied words — typed, configurable)
 *
 * Rule set is configurable here; defaults block nothing (ADR-002). The
 * proxy bundle is edge-safe: it imports only dependency-free pure code.
 */
const TRAFFIC_RULES: TrafficRules = DEFAULT_TRAFFIC_RULES

export function proxy(request: NextRequest): NextResponse {
  // Real requests always carry Host; nextUrl.host covers synthetic requests
  // (and request objects where the Host header was stripped).
  const host = normalizeHost(request.headers.get('host') ?? request.nextUrl.host)

  const headers = new Headers(request.headers)
  if (host) headers.set('x-gw-host', host)

  const verdict = evaluateTraffic(
    {
      userAgent: request.headers.get('user-agent'),
      text: `${request.nextUrl.pathname}${request.nextUrl.search}`,
    },
    TRAFFIC_RULES,
  )
  if (verdict.blocked) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
}

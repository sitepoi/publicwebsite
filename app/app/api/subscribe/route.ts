import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { onEvent, type GwEvent } from '@/lib/events'
import { getLogger, newRequestId } from '@/lib/log/logger'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * GET /api/subscribe (Section 34) — Server-Sent Events for gw.db.subscribe.
 * Provider-agnostic: the DataProvider.subscribe channel (Firestore onSnapshot
 * now, Supabase Realtime later) feeds `added|modified|removed` events; the
 * event bus adds `gw-event` (operations/hooks) for in-page live UI.
 * READ-ONLY — no data is ever sent TO clients, only change notifications.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const SSE_KEEPALIVE_MS = 15_000

export interface SubscribeDeps {
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  trafficRules?: TrafficRules
}

export async function handleSubscribe(
  request: Request,
  deps: SubscribeDeps = {},
): Promise<Response> {
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES
  const log = getLogger()
  const requestId = request.headers.get('x-request-id') ?? newRequestId()

  const url = new URL(request.url)
  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    return json({ error: 'blocked' }, 403)
  }

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )

  const cmsObjectType = url.searchParams.get('cmsObjectType') ?? undefined
  const folder = url.searchParams.get('folder') ?? undefined

  const encoder = new TextEncoder()
  let unsubscribeProvider: (() => void) | null = null
  let offBus: (() => void) | null = null
  let keepalive: ReturnType<typeof setInterval> | null = null
  let closed = false

  const cleanup = () => {
    if (closed) return
    closed = true
    if (unsubscribeProvider) unsubscribeProvider()
    if (offBus) offBus()
    if (keepalive) clearInterval(keepalive)
    log.info({ requestId, host, path: '/api/subscribe', msg: 'sse closed' })
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          /* stream closed */
        }
      }

      unsubscribeProvider = provider.subscribe({ cmsObjectType, folder }, (change) => {
        send(change.type, change.object)
      })

      offBus = onEvent((event: GwEvent) => {
        if (event.folderId === site.folderId) send('gw-event', event)
      })

      keepalive = setInterval(() => send('ping', { t: Date.now() }), SSE_KEEPALIVE_MS)
    },
    cancel() {
      cleanup()
    },
  })

  request.signal.addEventListener('abort', cleanup)

  log.info({ requestId, host, path: '/api/subscribe', cmsObjectType, folder, msg: 'sse open' })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleSubscribe(request)
}

export type { GwEvent }

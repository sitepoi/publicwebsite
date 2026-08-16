import { createHmac } from 'node:crypto'
import { getEnv } from '@/lib/config/env'
import type { SiteConfig } from '@/lib/resolver/site'
import type { GwEvent } from './bus'

/**
 * Outbound webhooks (Section 34) — operations/hooks events POSTed to
 * folder-configured targets (`webSettings.outboundWebhooks`:
 * `{url, secret?, events?: ['operation.completed', '*']}`).
 * Requests are SIGNED: `x-gw-signature: sha256=<HMAC-SHA256(body, secret)>`.
 * Dispatch is NEVER fatal — a failing webhook never fails the operation.
 */
export interface OutboundWebhookConfig {
  url: string
  secret?: string
  events?: string[]
}

function outboundHooks(site: SiteConfig): OutboundWebhookConfig[] {
  const raw = (site.settings.webSettings as unknown as Record<string, unknown> | undefined)?.[
    'outboundWebhooks'
  ]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): OutboundWebhookConfig[] => {
    if (entry === null || typeof entry !== 'object') return []
    const url = (entry as Record<string, unknown>)['url']
    if (typeof url !== 'string' || url.length === 0) return []
    const secret = (entry as Record<string, unknown>)['secret']
    const events = (entry as Record<string, unknown>)['events']
    return [
      {
        url,
        ...(typeof secret === 'string' && secret.length > 0 ? { secret } : {}),
        ...(Array.isArray(events)
          ? { events: events.filter((e): e is string => typeof e === 'string') }
          : {}),
      },
    ]
  })
}

export interface DispatchOptions {
  fetchImpl?: typeof fetch
}

export async function dispatchOutboundWebhooks(
  site: SiteConfig,
  event: GwEvent,
  options: DispatchOptions = {},
): Promise<void> {
  const hooks = outboundHooks(site)
  if (hooks.length === 0) return

  const fetchImpl = options.fetchImpl ?? fetch
  const body = JSON.stringify(event)

  for (const hook of hooks) {
    if (hook.events && hook.events.length > 0) {
      const allowed = hook.events.includes('*') || hook.events.includes(event.type)
      if (!allowed) continue
    }
    try {
      const secret = hook.secret ?? getEnv().RELAY_SECRET
      const signature = createHmac('sha256', secret).update(body).digest('hex')
      await fetchImpl(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gw-event': event.type,
          'x-gw-event-id': event.id,
          'x-gw-signature': `sha256=${signature}`,
        },
        body,
      })
    } catch {
      /* outbound delivery is best-effort — never fatal */
    }
  }
}

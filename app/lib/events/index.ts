import { randomUUID } from 'node:crypto'
import type { DataProvider } from '@/lib/data/provider'
import type { SiteConfig } from '@/lib/resolver/site'
import { dispatchOutboundWebhooks } from './outbound'
import { emitEvent, type GwEvent } from './bus'

/**
 * Event pipeline (Section 34): emitters call `emitSiteEvent`; the event
 * fans out to (1) the in-process bus (SSE live UI), (2) the per-tenant
 * EVENT LOG collection (`event-log${ext}` — admin-compatible audit trail)
 * and (3) folder-configured outbound webhooks (signed). All three are
 * best-effort — none can fail the caller.
 */
export const EVENT_LOG_COLLECTION = 'event-log'

export interface EmitSiteEventInput {
  provider: DataProvider
  site: SiteConfig
  type: string
  payload: Record<string, unknown>
  now?: () => Date
}

export async function emitSiteEvent(input: EmitSiteEventInput): Promise<void> {
  const now = input.now ?? (() => new Date())
  const event: GwEvent = {
    id: randomUUID(),
    type: input.type,
    folderId: input.site.folderId,
    tenantId: input.site.tenant.tenantId,
    payload: input.payload,
    createdAt: now().toISOString(),
  }

  // 1. In-process fan-out (SSE channel + internal handlers).
  emitEvent(event)

  // 2. Audit trail — admin-compatible event-log objects per tenant.
  try {
    await input.provider.createRecord({
      collection: `${EVENT_LOG_COLLECTION}${input.site.tenant.tableExtension ?? ''}`,
      id: event.id,
      data: event as unknown as Record<string, unknown>,
    })
  } catch {
    /* logging must never fail the emitter */
  }

  // 3. Outbound webhooks (signed, best-effort).
  await dispatchOutboundWebhooks(input.site, event)
}

export { emitEvent, onEvent } from './bus'
export type { GwEvent, EventHandler } from './bus'
export { dispatchOutboundWebhooks } from './outbound'
export type { OutboundWebhookConfig } from './outbound'

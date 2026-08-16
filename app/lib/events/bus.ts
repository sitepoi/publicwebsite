/**
 * Event bus (Section 34 / C11) — in-process pub/sub for server events.
 * Operations/hooks emit events; subscribers are the SSE channel (in-page
 * live UI), the per-tenant event log and outbound webhooks.
 */
export interface GwEvent {
  id: string
  type: string
  folderId?: string
  tenantId?: string
  payload: Record<string, unknown>
  createdAt: string
}

export type EventHandler = (event: GwEvent) => void

const listeners = new Set<EventHandler>()

/** Subscribe to ALL events (SSE route fans out per folder itself). */
export function onEvent(handler: EventHandler): () => void {
  listeners.add(handler)
  return () => {
    listeners.delete(handler)
  }
}

/** Fan-out — a throwing listener never breaks emitters. */
export function emitEvent(event: GwEvent): void {
  for (const handler of listeners) {
    try {
      handler(event)
    } catch {
      /* listeners never break the emitter */
    }
  }
}

export type { EventHandler as GwEventHandler }

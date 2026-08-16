import { describe, expect, it, vi } from 'vitest'
import { onEvent, emitEvent, type GwEvent } from '@/lib/events/bus'
import { dispatchOutboundWebhooks } from '@/lib/events/outbound'
import { emitSiteEvent, EVENT_LOG_COLLECTION } from '@/lib/events'
import { executeOperation } from '@/lib/render/operations'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteConfig } from '@/lib/resolver/site'
import { createStoreProvider, makeDataSite } from '../api/data-fakes'

const site = makeDataSite()

function makeEvent(overrides: Partial<GwEvent> = {}): GwEvent {
  return {
    id: 'evt-1',
    type: 'operation.completed',
    folderId: 'folder-a',
    tenantId: 't1',
    payload: { operationId: 'op-1' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('event bus (Section 34)', () => {
  it('fans events out to subscribers and unsubscribe works', () => {
    const seen: GwEvent[] = []
    const off = onEvent((event) => seen.push(event))
    emitEvent(makeEvent())
    emitEvent(makeEvent({ id: 'evt-2' }))
    expect(seen.map((event) => event.id)).toEqual(['evt-1', 'evt-2'])
    off()
    emitEvent(makeEvent({ id: 'evt-3' }))
    expect(seen.map((event) => event.id)).toEqual(['evt-1', 'evt-2'])
  })

  it('a throwing listener never breaks emitters', () => {
    onEvent(() => {
      throw new Error('boom')
    })
    const seen: GwEvent[] = []
    onEvent((event) => seen.push(event))
    emitEvent(makeEvent())
    expect(seen).toHaveLength(1)
  })
})

describe('outbound webhooks (signed)', () => {
  it('POSTs signed events to configured targets and respects the event filter', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    const hookSite: SiteConfig = {
      ...site,
      settings: {
        ...site.settings,
        webSettings: {
          outboundWebhooks: [
            { url: 'https://kitchen.example/hook', secret: 'hook-secret', events: ['*'] },
            { url: 'https://crm.example/hook', events: ['payment.succeeded'] },
          ],
        },
      },
    }
    await dispatchOutboundWebhooks(hookSite, makeEvent(), { fetchImpl: fetchMock as typeof fetch })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://kitchen.example/hook')
    const headers = init.headers as Record<string, string>
    expect(headers['x-gw-event']).toBe('operation.completed')
    expect(headers['x-gw-event-id']).toBe('evt-1')
    expect(headers['x-gw-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    // HMAC-SHA256 of the body with the configured secret.
    const crypto = await import('node:crypto')
    const expected = crypto
      .createHmac('sha256', 'hook-secret')
      .update(String(init.body))
      .digest('hex')
    expect(headers['x-gw-signature']).toBe(`sha256=${expected}`)
  })

  it('never fails the caller when a target is unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('down')
    })
    const hookSite: SiteConfig = {
      ...site,
      settings: {
        ...site.settings,
        webSettings: { outboundWebhooks: [{ url: 'https://down.example/hook', events: ['*'] }] },
      },
    }
    await expect(
      dispatchOutboundWebhooks(hookSite, makeEvent(), { fetchImpl: fetchMock as typeof fetch }),
    ).resolves.toBeUndefined()
  })
})

describe('emitSiteEvent (log + bus + outbound)', () => {
  it('writes an admin-compatible event-log record per tenant', async () => {
    const store = createStoreProvider()
    const hookSite: SiteConfig = {
      ...site,
      settings: {
        ...site.settings,
        webSettings: {
          outboundWebhooks: [{ url: 'https://kitchen.example/hook', events: ['*'] }],
        },
      },
    }
    await emitSiteEvent({
      provider: store.provider,
      site: hookSite,
      type: 'operation.completed',
      payload: { operationId: 'op-1' },
    })
    const logged = store.committed.find((write) => write.collection === 'event-log')
    expect(logged).toBeTruthy()
    expect(logged?.data).toMatchObject({
      type: 'operation.completed',
      folderId: 'folder-a',
      tenantId: 't1',
      payload: { operationId: 'op-1' },
    })
  })

  it('operations emit operation.completed + hook events after success', async () => {
    const operationObject: ObjectRecord = {
      id: 'op-create',
      slug: 'op-create',
      cmsObjectType: site.appId,
      typeId: site.folderId,
      data: {
        operationId: 'create-thing',
        writes: [
          {
            targetType: 'things',
            mode: 'create',
            with: { status: 'new' },
          },
        ],
      },
    }
    const store = createStoreProvider({ objects: [operationObject] })
    const result = await executeOperation({
      provider: store.provider,
      site,
      operationId: 'create-thing',
      payload: {},
      actor: { roles: [] },
    })
    expect(result.ok).toBe(true)

    const logEvents = store.committed.filter((write) => write.collection === 'event-log')
    expect(logEvents.map((write) => write.data['type'])).toContain('operation.completed')
    expect(logEvents).toHaveLength(1) // no hooks in this definition
  })
})

describe('event-log collection naming', () => {
  it('uses the admin-compatible suffix convention', () => {
    expect(EVENT_LOG_COLLECTION).toBe('event-log')
  })
})

import { describe, expect, it } from 'vitest'
import { handleSubscribe } from '@/app/api/subscribe/route'
import { emitEvent, type GwEvent } from '@/lib/events'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, makeDataSite } from './data-fakes'

const site = makeDataSite()

function subscribeDeps(store: ReturnType<typeof createStoreProvider>) {
  return {
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
  }
}

async function readSseChunks(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (chunks.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks
}

describe('GET /api/subscribe (Section 34 SSE)', () => {
  it('streams provider record changes as SSE events (emulator write event)', async () => {
    const store = createStoreProvider()
    const response = await handleSubscribe(
      new Request('https://site-a.test/api/subscribe?cmsObjectType=orders', {
        headers: { 'x-gw-host': 'site-a.test' },
      }),
      subscribeDeps(store),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const chunksPromise = readSseChunks(response.body as ReadableStream<Uint8Array>, 2)
    store.emitRecordChange({ type: 'added', object: { id: 'o1', cmsObjectType: 'orders' } })
    store.emitRecordChange({ type: 'modified', object: { id: 'o1', cmsObjectType: 'orders' } })

    const chunks = (await chunksPromise).join('')
    expect(chunks).toContain('event: added')
    expect(chunks).toContain('event: modified')
    expect(chunks).toContain('"id":"o1"')
  })

  it('forwards matching folder events from the event bus as gw-event', async () => {
    const store = createStoreProvider()
    const response = await handleSubscribe(
      new Request('https://site-a.test/api/subscribe?folder=site-a', {
        headers: { 'x-gw-host': 'site-a.test' },
      }),
      subscribeDeps(store),
    )

    const chunksPromise = readSseChunks(response.body as ReadableStream<Uint8Array>, 1)
    const event: GwEvent = {
      id: 'evt-1',
      type: 'operation.completed',
      folderId: site.folderId,
      tenantId: 't1',
      payload: { operationId: 'op-1' },
      createdAt: new Date().toISOString(),
    }
    emitEvent(event)

    const chunks = (await chunksPromise).join('')
    expect(chunks).toContain('event: gw-event')
    expect(chunks).toContain('"operation.completed"')
  })

  it('rejects unknown sites', async () => {
    const store = createStoreProvider()
    const response = await handleSubscribe(new Request('https://unknown.test/api/subscribe'), {
      resolveSite: async () => ({ ok: false, reason: 'site-not-found' }),
      providerFor: () => store.provider,
    })
    expect(response.status).toBe(404)
  })
})

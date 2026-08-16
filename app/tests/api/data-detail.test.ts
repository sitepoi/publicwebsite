import { describe, expect, it } from 'vitest'
import { handleDataDetail } from '@/app/api/data/[type]/[id]/route'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import { CMS_SETTINGS_DOC_ID } from '@/lib/contracts/app-config'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

function detailDeps(store: ReturnType<typeof createStoreProvider>) {
  const site = makeDataSite()
  return {
    env: dataEnv,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
  }
}

const objects: ObjectRecord[] = [
  { id: 'm1', name: 'Margherita', cmsObjectType: 'menu-items', meta: { language: 'en' } },
  { id: 'm2', name: 'Secret', cmsObjectType: 'menu-items', rules: { publicAccess: 'no' } },
]

describe('GET /api/data/{type}/{id} (Section 29 detail)', () => {
  it('returns the public object', async () => {
    const store = createStoreProvider({
      objects,
      settings: {
        [CMS_SETTINGS_DOC_ID]: {
          objectTypes: [{ id: 'menu-items', rules: { publicAccess: 'yes' } }],
        },
      },
    })
    const response = await handleDataDetail(makeRequest(), 'menu-items', 'm1', detailDeps(store))
    expect(response.status).toBe(200)
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      id: 'm1',
      name: 'Margherita',
    })
  })

  it('hides private records and unknown ids (404)', async () => {
    const store = createStoreProvider({ objects })
    const d = detailDeps(store)
    expect((await handleDataDetail(makeRequest(), 'menu-items', 'm2', d)).status).toBe(404)
    expect((await handleDataDetail(makeRequest(), 'menu-items', 'nope', d)).status).toBe(404)
  })

  it('blocks private types', async () => {
    const store = createStoreProvider({
      objects,
      settings: {
        'cms-settings': { objectTypes: [{ id: 'menu-items', rules: { publicAccess: 'no' } }] },
      },
    })
    const response = await handleDataDetail(makeRequest(), 'menu-items', 'm1', detailDeps(store))
    expect(response.status).toBe(403)
  })
})

function makeRequest(): Request {
  return new Request('https://site-a.test/api/data/menu-items/m1', {
    method: 'GET',
    headers: { 'x-gw-host': 'site-a.test' },
  })
}

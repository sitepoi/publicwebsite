import { describe, expect, it } from 'vitest'
import { handleSearch } from '@/app/api/search/route'
import { createMemoryCache, createMemoryRateLimiter } from '@/lib/cache/memory'
import { CMS_SETTINGS_DOC_ID } from '@/lib/contracts/app-config'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()

const products: ObjectRecord[] = [
  {
    id: 'p1',
    name: 'Cheeseburger Deluxe',
    price: 12,
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
  },
  {
    id: 'p2',
    name: 'Burger Classic',
    price: 9,
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
  },
  {
    id: 'p3',
    name: 'Salad',
    price: 7,
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
  },
  {
    id: 'p4',
    name: 'Secret Burger',
    price: 99,
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
    rules: { publicAccess: 'no' },
  },
  {
    id: 'p5',
    name: 'Burger Klassik',
    price: 9,
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'de' },
  },
]

const publicType = {
  [CMS_SETTINGS_DOC_ID]: { objectTypes: [{ id: 'menu-items', rules: { publicAccess: 'yes' } }] },
}

function searchDeps(store: ReturnType<typeof createStoreProvider>) {
  return {
    env: dataEnv,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
    cache: createMemoryCache<{ items: ObjectRecord[] }>({ ttlMs: 60_000 }),
  }
}

function makeRequest(query: string): Request {
  return new Request(`https://site-a.test/api/search?${query}`, {
    method: 'GET',
    headers: { 'x-gw-host': 'site-a.test' },
  })
}

describe('GET /api/search (Section 15)', () => {
  it('returns RANKED public objects for the query', async () => {
    const store = createStoreProvider({ objects: products, settings: publicType })
    const response = await handleSearch(makeRequest('type=menu-items&q=burger'), searchDeps(store))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: { id: string }[]; total: number }
    // Relevance first: the two burger products rank above the salad.
    expect(
      body.items
        .slice(0, 2)
        .map((item) => item.id)
        .sort(),
    ).toEqual(['p1', 'p2'])
    expect(body.items.map((item) => item.id)).not.toContain('p4') // private excluded
    expect(body.items.map((item) => item.id)).not.toContain('p3')
  })

  it('blocks private types and unknown types without parentTenants', async () => {
    const privateStore = createStoreProvider({
      objects: products,
      settings: {
        [CMS_SETTINGS_DOC_ID]: {
          objectTypes: [{ id: 'menu-items', rules: { publicAccess: 'no' } }],
        },
      },
    })
    const blocked = await handleSearch(
      makeRequest('type=menu-items&q=burger'),
      searchDeps(privateStore),
    )
    expect(blocked.status).toBe(403)

    const unknownStore = createStoreProvider({ objects: products })
    const notFound = await handleSearch(
      makeRequest('type=menu-items&q=burger'),
      searchDeps(unknownStore),
    )
    expect(notFound.status).toBe(404)
  })

  it('applies the language filter and limit', async () => {
    const store = createStoreProvider({ objects: products, settings: publicType })
    const response = await handleSearch(
      makeRequest('type=menu-items&q=burger&lang=de&limit=1'),
      searchDeps(store),
    )
    const body = (await response.json()) as { items: { id: string }[]; total: number }
    expect(body.items.map((item) => item.id)).toEqual(['p5'])
    expect(body.total).toBe(1)
  })

  it('memory-caches identical queries', async () => {
    const store = createStoreProvider({ objects: products, settings: publicType })
    const deps = searchDeps(store)
    await handleSearch(makeRequest('type=menu-items&q=burger'), deps)
    await handleSearch(makeRequest('type=menu-items&q=burger'), deps)
    expect(store.queryCalls()).toBe(1)
  })

  it('rejects invalid queries', async () => {
    const store = createStoreProvider({ objects: products, settings: publicType })
    const response = await handleSearch(makeRequest('q=burger'), searchDeps(store))
    expect(response.status).toBe(400)
  })
})

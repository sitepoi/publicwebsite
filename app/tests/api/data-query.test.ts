import { describe, expect, it } from 'vitest'
import { handleDataQuery, type DataQueryDeps } from '@/app/api/data/query/route'
import { createMemoryRateLimiter, createMemoryCache } from '@/lib/cache/memory'
import { CMS_SETTINGS_DOC_ID } from '@/lib/contracts/app-config'
import type { DataQueryResult } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite, makeQueryRequest } from './data-fakes'

function queryDeps(store: ReturnType<typeof createStoreProvider>, site = makeDataSite()) {
  return {
    env: dataEnv,
    store,
    site,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
    cache: createMemoryCache<DataQueryResult>({ ttlMs: 60_000 }),
  } satisfies DataQueryDeps & { store: typeof store; site: typeof site }
}

const menuItems: ObjectRecord[] = [
  {
    id: 'm1',
    name: 'Margherita',
    price: 9,
    categoryId: 'c1',
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
  },
  {
    id: 'm2',
    name: 'Pepperoni',
    price: 12,
    categoryId: 'c1',
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
  },
  {
    id: 'm3',
    name: 'Private item',
    price: 5,
    categoryId: 'c2',
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'en' },
    rules: { publicAccess: 'no' },
  },
  {
    id: 'm4',
    name: 'Deutsch',
    price: 7,
    categoryId: 'c2',
    cmsObjectType: 'menu-items',
    typeId: 'folder-a',
    meta: { language: 'de' },
  },
  { id: 'c1', name: 'Classic', cmsObjectType: 'categories' },
]

const publicMenuType = {
  [CMS_SETTINGS_DOC_ID]: {
    objectTypes: [{ id: 'menu-items', rules: { publicAccess: 'yes' } }],
  },
}

describe('POST /api/data/query (Section 29 GET fabric)', () => {
  it('serves a public query with facets + relations', async () => {
    const store = createStoreProvider({ objects: menuItems, settings: publicMenuType })
    const d = queryDeps(store)

    const response = await handleDataQuery(
      makeQueryRequest({
        cmsObjectType: 'menu-items',
        filters: [{ field: 'price', op: '>=', value: 6 }],
        facets: ['categoryId'],
        relations: [{ field: 'categoryId', targetType: 'categories', targetField: 'id' }],
      }),
      d,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as DataQueryResult
    expect(body.items.map((item) => item.id)).toEqual(['m1', 'm2', 'm4'])
    expect(body.facets).toEqual({ categoryId: { c1: 2, c2: 1 } })
    expect(body.relations['categoryId']?.map((item) => item.id)).toEqual(['c1'])
  })

  it('blocks private types (publicAccess no)', async () => {
    const store = createStoreProvider({
      objects: menuItems,
      settings: {
        'cms-settings': { objectTypes: [{ id: 'menu-items', rules: { publicAccess: 'no' } }] },
      },
    })
    const response = await handleDataQuery(
      makeQueryRequest({ cmsObjectType: 'menu-items' }),
      queryDeps(store),
    )
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('type-blocked')
  })

  it('unknown types are not-found without parentTenants, allowed with them', async () => {
    const withoutParent = createStoreProvider({ objects: menuItems })
    const denied = await handleDataQuery(
      makeQueryRequest({ cmsObjectType: 'menu-items' }),
      queryDeps(withoutParent),
    )
    expect(denied.status).toBe(404)

    const site = makeDataSite()
    site.tenant.parentTenants = ['parent-tenant']
    const withParent = createStoreProvider({ objects: menuItems })
    const allowed = await handleDataQuery(
      makeQueryRequest({ cmsObjectType: 'menu-items' }),
      queryDeps(withParent, site),
    )
    expect(allowed.status).toBe(200)
  })

  it('applies the server-side language filter', async () => {
    const store = createStoreProvider({ objects: menuItems, settings: publicMenuType })
    const response = await handleDataQuery(
      makeQueryRequest({ cmsObjectType: 'menu-items', language: 'de' }),
      queryDeps(store),
    )
    const body = (await response.json()) as DataQueryResult
    expect(body.items.map((item) => item.id)).toEqual(['m4'])
  })

  it('excludes private records server-side', async () => {
    const store = createStoreProvider({ objects: menuItems, settings: publicMenuType })
    const response = await handleDataQuery(
      makeQueryRequest({ cmsObjectType: 'menu-items' }),
      queryDeps(store),
    )
    const body = (await response.json()) as DataQueryResult
    expect(body.items.map((item) => item.id)).not.toContain('m3')
  })

  it('projects per-folder field allowlists', async () => {
    const store = createStoreProvider({
      objects: menuItems,
      settings: publicMenuType,
      folders: [
        {
          id: 'folder-a',
          slug: 'folder-a',
          mainObjectType: 'x',
          data: { fieldAllowlist: ['name'] },
        },
      ],
    })
    const response = await handleDataQuery(
      makeQueryRequest({ cmsObjectType: 'menu-items', folder: 'folder-a' }),
      queryDeps(store),
    )
    const body = (await response.json()) as DataQueryResult
    expect(body.items[0]).toEqual({ id: 'm1', name: 'Margherita' })
  })

  it('rate-limits per IP', async () => {
    const store = createStoreProvider({ objects: menuItems, settings: publicMenuType })
    const d = queryDeps(store)
    d.rateLimiter = createMemoryRateLimiter({ max: 1, windowMs: 60_000 })
    expect(
      (await handleDataQuery(makeQueryRequest({ cmsObjectType: 'menu-items' }), d)).status,
    ).toBe(200)
    expect(
      (await handleDataQuery(makeQueryRequest({ cmsObjectType: 'menu-items' }), d)).status,
    ).toBe(429)
  })

  it('caches identical queries (short TTL)', async () => {
    const store = createStoreProvider({ objects: menuItems, settings: publicMenuType })
    const d = queryDeps(store)
    await handleDataQuery(makeQueryRequest({ cmsObjectType: 'menu-items' }), d)
    await handleDataQuery(makeQueryRequest({ cmsObjectType: 'menu-items' }), d)
    expect(store.queryCalls()).toBe(1)
  })

  it('rejects invalid query payloads', async () => {
    const store = createStoreProvider({ objects: menuItems })
    const response = await handleDataQuery(makeQueryRequest({ evil: true }), queryDeps(store))
    expect(response.status).toBe(400)
  })
})

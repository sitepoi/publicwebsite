import { describe, expect, it, vi } from 'vitest'
import { createSiteResolver, loadWebsiteAppDefinitions } from '@/lib/resolver/site'
import { CMS_SETTINGS_DOC_ID, DEFAULT_APP_ID } from '@/lib/contracts/app-config'
import type { TenantConfig } from '@/lib/contracts/tenants'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SettingsDoc } from '@/lib/data/provider'
import { createFakeProvider } from './fakes'

const tenant: TenantConfig = {
  tenantId: 't',
  databaseProvider: 'firestore',
  firebase: { projectId: 'p' },
}

function settingsObject(
  folderId: string,
  hostNames: string[],
  overrides: Record<string, unknown> = {},
): ObjectRecord {
  return {
    id: `${folderId}-settings`,
    typeId: folderId,
    slug: 'default-settings',
    cmsObjectType: DEFAULT_APP_ID,
    data: { hostNames, defaultLanguage: 'en', ...overrides },
  }
}

function appDoc(appIds: { id: string; capabilities?: string[] }[]): SettingsDoc {
  return { id: CMS_SETTINGS_DOC_ID, objectTypes: appIds }
}

function providerWith(
  objects: ObjectRecord[],
  apps: SettingsDoc[],
): ReturnType<typeof createFakeProvider> {
  return createFakeProvider({
    getSettings: async (ids) => (ids[0] === CMS_SETTINGS_DOC_ID ? apps : []),
    queryObjects: async (query) => {
      const filtered = objects.filter(
        (record) =>
          record.cmsObjectType === query.cmsObjectType &&
          query.filters?.some(
            (filter) =>
              filter.field === 'slug' && filter.op === '==' && filter.value === 'default-settings',
          ),
      )
      return {
        items: filtered,
        total: filtered.length,
        page: 1,
        pageSize: 24,
        facets: {},
        relations: {},
      }
    },
  })
}

function makeResolver(
  objects: ObjectRecord[],
  apps: SettingsDoc[],
  tenantConfig: TenantConfig = tenant,
) {
  const getTenant = vi.fn(async () => tenantConfig)
  const provider = providerWith(objects, apps)
  const resolver = createSiteResolver({
    getTenant,
    getProvider: () => provider,
    loadAppDefinitions: (tenantArg, providerArg) =>
      loadWebsiteAppDefinitions(tenantArg, providerArg),
  })
  return { resolver, getTenant }
}

describe('resolveSite (Section 7.3)', () => {
  it('folder match: hostNames exact match resolves the site + folder', async () => {
    const { resolver } = makeResolver(
      [settingsObject('folder-a', ['site-a.com'])],
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
    )
    const result = await resolver.resolveSite('site-a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.folderId).toBe('folder-a')
    expect(result.site.appId).toBe(DEFAULT_APP_ID)
    expect(result.site.settings.defaultLanguage).toBe('en')
    expect(result.site.host).toBe('site-a.com')
  })

  it('wildcard match: *.domain matches a subdomain, not the bare domain', async () => {
    const objects = [settingsObject('folder-a', ['*.site-a.com'])]
    const apps = [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])]

    const { resolver } = makeResolver(objects, apps)
    const sub = await resolver.resolveSite('www.site-a.com')
    expect(sub.ok).toBe(true)

    const bare = await resolver.resolveSite('site-a.com')
    expect(bare).toEqual({ ok: false, reason: 'site-not-found' })
  })

  it('app fallback: missing cms-settings doc falls back to the default app id (Q12)', async () => {
    const { resolver } = makeResolver([settingsObject('folder-a', ['site-a.com'])], [])
    const result = await resolver.resolveSite('site-a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.appId).toBe(DEFAULT_APP_ID)
    expect(result.site.folderId).toBe('folder-a')
  })

  it('app fallback: tenant defaultAppId overrides the plan default', async () => {
    const customTenant: TenantConfig = { ...tenant, defaultAppId: 'restaurant-orders-app' }
    const objects = [
      {
        ...settingsObject('folder-a', ['site-a.com']),
        cmsObjectType: 'restaurant-orders-app',
      },
    ]
    const { resolver } = makeResolver(objects, [], customTenant)
    const result = await resolver.resolveSite('site-a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.appId).toBe('restaurant-orders-app')
  })

  it('no-match → notFound (no content-system fallback)', async () => {
    const { resolver } = makeResolver(
      [settingsObject('folder-a', ['other.com'])],
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
    )
    expect(await resolver.resolveSite('site-a.com')).toEqual({
      ok: false,
      reason: 'site-not-found',
    })
  })

  it('tenant-not-found when tenant resolution fails', async () => {
    const provider = providerWith([], [])
    const resolver = createSiteResolver({
      getTenant: async () => null,
      getProvider: () => provider,
      loadAppDefinitions: loadWebsiteAppDefinitions,
    })
    expect(await resolver.resolveSite('site-a.com')).toEqual({
      ok: false,
      reason: 'tenant-not-found',
    })
  })

  it('reads default-settings through the data normalization fallback (Section 6/8)', async () => {
    const legacyObject: ObjectRecord = {
      id: 'folder-b-settings',
      typeId: 'folder-b',
      slug: 'default-settings',
      cmsObjectType: DEFAULT_APP_ID,
      productData: { data_categoriesBased: { hostNames: ['legacy.example'], currency: 'TRY' } },
    }
    const { resolver } = makeResolver(
      [legacyObject],
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
    )
    const result = await resolver.resolveSite('legacy.example')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.folderId).toBe('folder-b')
    expect(result.site.settings.currency).toBe('TRY')
  })

  it('skips invalid default-settings objects (hostNames required)', async () => {
    const { resolver } = makeResolver(
      [settingsObject('folder-a', [])],
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
    )
    expect(await resolver.resolveSite('site-a.com')).toEqual({
      ok: false,
      reason: 'site-not-found',
    })
  })

  it('caches per host; invalidateSite(host) forces a fresh resolution', async () => {
    const { resolver, getTenant } = makeResolver(
      [settingsObject('folder-a', ['site-a.com'])],
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
    )
    await resolver.resolveSite('site-a.com')
    await resolver.resolveSite('site-a.com')
    expect(getTenant).toHaveBeenCalledTimes(1)

    resolver.invalidateSite('site-a.com')
    await resolver.resolveSite('site-a.com')
    expect(getTenant).toHaveBeenCalledTimes(2)
  })

  it('returns site-not-found for an invalid host', async () => {
    const { resolver, getTenant } = makeResolver([], [])
    expect(await resolver.resolveSite('')).toEqual({ ok: false, reason: 'site-not-found' })
    expect(getTenant).not.toHaveBeenCalled()
  })

  it('loadWebsiteAppDefinitions filters to website-capable apps only', async () => {
    const provider = providerWith(
      [],
      [
        appDoc([
          { id: 'site-app', capabilities: ['website'] },
          { id: 'other-app', capabilities: ['ordering'] },
          { id: 'no-caps' },
        ]),
      ],
    )
    const apps = await loadWebsiteAppDefinitions(tenant, provider)
    expect(apps.map((app) => app.id)).toEqual(['site-app'])
  })
})

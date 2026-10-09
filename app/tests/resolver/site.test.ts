import { describe, expect, it, vi } from 'vitest'
import { createSiteResolver, loadWebsiteAppDefinitions } from '@/lib/resolver/site'
import { CMS_SETTINGS_DOC_ID, DEFAULT_APP_ID } from '@/lib/contracts/app-config'
import type { TenantConfig } from '@/lib/contracts/tenants'
import type { ObjectType } from '@/lib/contracts/folder'
import type { SettingsDoc } from '@/lib/data/provider'
import { createFakeProvider } from './fakes'

const tenant: TenantConfig = {
  tenantId: 't',
  databaseProvider: 'firestore',
  firebase: { projectId: 'p' },
}

function folder(
  id: string,
  websiteConfigData?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ObjectType {
  return {
    id,
    mainObjectType: DEFAULT_APP_ID,
    name: id,
    ...(websiteConfigData ? { data: { websiteConfig: websiteConfigData } } : {}),
    ...extra,
  }
}

function appDoc(appIds: { id: string; capabilities?: string[] }[]): SettingsDoc {
  return { id: CMS_SETTINGS_DOC_ID, objectTypes: appIds }
}

function providerWith(
  apps: SettingsDoc[],
  folders: ObjectType[] = [],
): ReturnType<typeof createFakeProvider> {
  return createFakeProvider({
    getSettings: async (ids) => (ids[0] === CMS_SETTINGS_DOC_ID ? apps : []),
    getObjectTypes: async () => folders,
  })
}

function makeResolver(
  apps: SettingsDoc[],
  tenantConfig: TenantConfig = tenant,
  folders: ObjectType[] = [],
) {
  const getTenant = vi.fn(async () => tenantConfig)
  const provider = providerWith(apps, folders)
  const resolver = createSiteResolver({
    getTenant,
    getProvider: () => provider,
    loadAppDefinitions: (tenantArg, providerArg) =>
      loadWebsiteAppDefinitions(tenantArg, providerArg),
  })
  return { resolver, getTenant }
}

describe('folder-based site mapping (D-DWH-22)', () => {
  const websiteApps = [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])]

  it('resolves the site from the folder doc data.hostNames', async () => {
    const { resolver } = makeResolver(
      websiteApps,
      tenant,
      [
        folder('site-root-a', {
          hostNames: ['test1.sitepoi.com'],
          primaryHost: 'test1.sitepoi.com',
          defaultLanguage: 'en',
        }),
      ],
    )
    const result = await resolver.resolveSite('test1.sitepoi.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.folderId).toBe('site-root-a')
    expect(result.site.settings.primaryHost).toBe('test1.sitepoi.com')
  })

  it('multi-domain: two folder docs resolve independently', async () => {
    const { resolver } = makeResolver(websiteApps, tenant, [
      folder('root-a', { hostNames: ['a.com'] }),
      folder('root-b', { hostNames: ['b.com'] }),
    ])
    const a = await resolver.resolveSite('a.com')
    const b = await resolver.resolveSite('b.com')
    expect(a.ok && a.site.folderId).toBe('root-a')
    expect(b.ok && b.site.folderId).toBe('root-b')
  })

  it('collects the site folder tree (root + descendants via parentId, D-DWH-24)', async () => {
    const { resolver } = makeResolver(websiteApps, tenant, [
      folder('root-a', { hostNames: ['a.com'] }),
      { id: 'child-1', mainObjectType: DEFAULT_APP_ID, name: 'c1', parentId: 'root-a' },
      { id: 'child-2', mainObjectType: DEFAULT_APP_ID, name: 'c2', parentId: 'child-1' },
      { id: 'other-site-child', mainObjectType: DEFAULT_APP_ID, name: 'o', parentId: 'root-other' },
    ])
    const result = await resolver.resolveSite('a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...(result.site.folderIds ?? [])].sort()).toEqual([
      'child-1',
      'child-2',
      'root-a',
    ])
  })

  it('folder data without hostNames does not match', async () => {
    const { resolver } = makeResolver(websiteApps, tenant, [
      folder('categorized-pages', { seo: true, base: true }),
    ])
    expect(await resolver.resolveSite('test1.sitepoi.com')).toEqual({
      ok: false,
      reason: 'site-not-found',
    })
  })

  it('wildcard match: *.domain matches a subdomain, not the bare domain', async () => {
    const { resolver } = makeResolver(websiteApps, tenant, [
      folder('folder-a', { hostNames: ['*.site-a.com'] }),
    ])
    const sub = await resolver.resolveSite('www.site-a.com')
    expect(sub.ok).toBe(true)

    const bare = await resolver.resolveSite('site-a.com')
    expect(bare).toEqual({ ok: false, reason: 'site-not-found' })
  })
})

describe('resolveSite (Section 7.3)', () => {
  it('folder match: hostNames exact match resolves the site + folder', async () => {
    const { resolver } = makeResolver(
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
      tenant,
      [folder('folder-a', { hostNames: ['site-a.com'], defaultLanguage: 'en' })],
    )
    const result = await resolver.resolveSite('site-a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.folderId).toBe('folder-a')
    expect(result.site.appId).toBe(DEFAULT_APP_ID)
    expect(result.site.settings.defaultLanguage).toBe('en')
    expect(result.site.host).toBe('site-a.com')
  })

  it('app fallback: missing cms-settings doc falls back to the default app id (Q12)', async () => {
    const { resolver } = makeResolver([], tenant, [
      folder('folder-a', { hostNames: ['site-a.com'] }),
    ])
    const result = await resolver.resolveSite('site-a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.appId).toBe(DEFAULT_APP_ID)
    expect(result.site.folderId).toBe('folder-a')
  })

  it('app fallback: tenant defaultAppId overrides the plan default', async () => {
    const customTenant: TenantConfig = { ...tenant, defaultAppId: 'restaurant-orders-app' }
    const { resolver } = makeResolver([], customTenant, [
      folder('folder-a', { hostNames: ['site-a.com'] }),
    ])
    const result = await resolver.resolveSite('site-a.com')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.appId).toBe('restaurant-orders-app')
  })

  it('no-match → notFound (no content-system fallback)', async () => {
    const { resolver } = makeResolver(
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
      tenant,
      [folder('folder-a', { hostNames: ['other.com'] })],
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

  it('reads folder hostNames through the data normalization fallback (Section 6/8)', async () => {
    const legacyFolder: ObjectType = {
      id: 'folder-b',
      mainObjectType: DEFAULT_APP_ID,
      name: 'legacy',
      productData: {
        data_categoriesBased: { websiteConfig: { hostNames: ['legacy.example'], currency: 'TRY' } },
      },
    }
    const { resolver } = makeResolver(
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
      tenant,
      [legacyFolder],
    )
    const result = await resolver.resolveSite('legacy.example')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.site.folderId).toBe('folder-b')
    expect(result.site.settings.currency).toBe('TRY')
  })

  it('skips folders with empty hostNames', async () => {
    const { resolver } = makeResolver(
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
      tenant,
      [folder('folder-a', { hostNames: [] })],
    )
    expect(await resolver.resolveSite('site-a.com')).toEqual({
      ok: false,
      reason: 'site-not-found',
    })
  })

  it('caches per host; invalidateSite(host) forces a fresh resolution', async () => {
    const { resolver, getTenant } = makeResolver(
      [appDoc([{ id: DEFAULT_APP_ID, capabilities: ['website'] }])],
      tenant,
      [folder('folder-a', { hostNames: ['site-a.com'] })],
    )
    await resolver.resolveSite('site-a.com')
    await resolver.resolveSite('site-a.com')
    expect(getTenant).toHaveBeenCalledTimes(1)

    resolver.invalidateSite('site-a.com')
    await resolver.resolveSite('site-a.com')
    expect(getTenant).toHaveBeenCalledTimes(2)
  })

  it('returns site-not-found for an invalid host', async () => {
    const { resolver, getTenant } = makeResolver([], tenant, [])
    expect(await resolver.resolveSite('')).toEqual({ ok: false, reason: 'site-not-found' })
    expect(getTenant).not.toHaveBeenCalled()
  })

  it('loadWebsiteAppDefinitions filters to website-capable apps only', async () => {
    const provider = providerWith([
      appDoc([
        { id: 'site-app', capabilities: ['website'] },
        { id: 'other-app', capabilities: ['ordering'] },
        { id: 'no-caps' },
      ]),
    ])
    const apps = await loadWebsiteAppDefinitions(tenant, provider)
    expect(apps.map((app) => app.id)).toEqual(['site-app'])
  })
})

import type { DataProvider } from '@/lib/data/provider'
import {
  AppDefinitionSchema,
  CMS_SETTINGS_DOC_ID,
  CmsSettingsDocSchema,
  DEFAULT_APP_ID,
  isWebsiteCapable,
  type AppDefinition,
} from '@/lib/contracts/app-config'
import { DEFAULT_SETTINGS_SLUG } from '@/lib/contracts/folder'
import { SiteSettingsSchema, type SiteSettings } from '@/lib/contracts/site-settings'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { getObjectData } from '@/lib/render/normalize'
import { hostMatches, normalizeHost } from './host'

/**
 * Site resolution (Section 7.3) — host → website source.
 *
 * 1. Normalize host (strip port, lowercase).
 * 2. Website-capable apps come from the `cms-settings` settings doc
 *    (`objectTypes[]` entries with `capabilities` including 'website').
 *    NO hardcoded app id; fallback = tenant's `defaultAppId`, then the plan
 *    default `website-builder-uniconbaseapps` (Q12).
 * 3. In those apps, find the object with slug `default-settings` whose
 *    `data.hostNames` contains the host (exact or `*.wildcard`) → its folder
 *    (record.typeId) is the website and its data is the site config.
 * 4. Else: notFound — NO content-system fallback.
 * 5. Result cached per host (short TTL); invalidated by the publish webhook
 *    (C11) via the exported invalidation hooks.
 *
 * ALL reads go through the DataProvider interface (Section 6B) — never the
 * Firestore SDK directly.
 */

export const SITE_CACHE_TTL_MS = 60_000

/** Max default-settings candidates scanned per app (Section 29 pageSize cap). */
export const SETTINGS_SCAN_PAGE_SIZE = 200

export interface SiteConfig {
  host: string
  tenant: TenantConfig
  appId: string
  folderId: string
  settings: SiteSettings
}

export type SiteResolution =
  { ok: true; site: SiteConfig } | { ok: false; reason: 'tenant-not-found' | 'site-not-found' }

export type GetTenant = (host: string) => Promise<TenantConfig | null>
export type GetProvider = (tenant: TenantConfig) => DataProvider
export type LoadAppDefinitions = (
  tenant: TenantConfig,
  provider: DataProvider,
) => Promise<AppDefinition[]>

export interface SiteResolverDeps {
  getTenant: GetTenant
  getProvider: GetProvider
  loadAppDefinitions: LoadAppDefinitions
}

export interface SiteResolver {
  resolveSite(host: string): Promise<SiteResolution>
  invalidateSite(host?: string): void
  clearSiteCache(): void
}

/**
 * Default app-definition loader: `cms-settings.objectTypes[]` entries filtered
 * to website-capable apps. When no website-capable app is found (empty/missing
 * doc), falls back to the tenant-configurable default app id (Q12) — the
 * "app fallback" path.
 */
export async function loadWebsiteAppDefinitions(
  tenant: TenantConfig,
  provider: DataProvider,
): Promise<AppDefinition[]> {
  const docs = await provider.getSettings([CMS_SETTINGS_DOC_ID])
  const parsed = docs[0] ? CmsSettingsDocSchema.safeParse(docs[0]) : undefined

  const apps = (parsed?.success ? (parsed.data.objectTypes ?? []) : []).flatMap((entry) => {
    const result = AppDefinitionSchema.safeParse(entry)
    return result.success && isWebsiteCapable(result.data) ? [result.data] : []
  })

  if (apps.length > 0) return apps

  const fallbackId = tenant.defaultAppId ?? DEFAULT_APP_ID
  return [{ id: fallbackId, capabilities: ['website'] }]
}

export function createSiteResolver(
  deps: SiteResolverDeps,
  ttlMs = SITE_CACHE_TTL_MS,
): SiteResolver {
  const cache = new Map<string, { value: SiteResolution; expiresAt: number }>()

  async function resolveSite(host: string): Promise<SiteResolution> {
    const normalized = normalizeHost(host)
    if (!normalized) return { ok: false, reason: 'site-not-found' }

    const now = Date.now()
    const cached = cache.get(normalized)
    if (cached && cached.expiresAt > now) return cached.value

    const tenant = await deps.getTenant(normalized)
    if (!tenant) {
      const resolution: SiteResolution = { ok: false, reason: 'tenant-not-found' }
      cache.set(normalized, { value: resolution, expiresAt: now + ttlMs })
      return resolution
    }

    const provider = deps.getProvider(tenant)
    const apps = await deps.loadAppDefinitions(tenant, provider)

    let resolution: SiteResolution = { ok: false, reason: 'site-not-found' }
    for (const app of apps) {
      const result = await provider.queryObjects({
        cmsObjectType: app.id,
        filters: [{ field: 'slug', op: '==', value: DEFAULT_SETTINGS_SLUG }],
        pageSize: SETTINGS_SCAN_PAGE_SIZE,
      })
      for (const record of result.items) {
        const data = getObjectData(record)
        const parsed = data ? SiteSettingsSchema.safeParse(data) : undefined
        if (!parsed?.success) continue
        if (!parsed.data.hostNames.some((pattern) => hostMatches(normalized, pattern))) continue

        const folderId =
          typeof record.typeId === 'string' && record.typeId.length > 0 ? record.typeId : record.id
        resolution = {
          ok: true,
          site: {
            host: normalized,
            tenant,
            appId: app.id,
            folderId,
            settings: parsed.data,
          },
        }
        break
      }
      if (resolution.ok) break
    }

    cache.set(normalized, { value: resolution, expiresAt: now + ttlMs })
    return resolution
  }

  function invalidateSite(host?: string): void {
    if (host === undefined) {
      cache.clear()
      return
    }
    const normalized = normalizeHost(host)
    if (normalized) cache.delete(normalized)
  }

  function clearSiteCache(): void {
    cache.clear()
  }

  return { resolveSite, invalidateSite, clearSiteCache }
}

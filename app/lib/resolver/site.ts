import type { DataProvider } from '@/lib/data/provider'
import {
  AppDefinitionSchema,
  CMS_SETTINGS_DOC_ID,
  CmsSettingsDocSchema,
  DEFAULT_APP_ID,
  isWebsiteCapable,
  type AppDefinition,
} from '@/lib/contracts/app-config'
import { type ObjectType } from '@/lib/contracts/folder'
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
 * 3. The website ROOT folder doc in `om_object_types` carries the domain
 *    mapping — `data.hostNames` (CMS folder data) or a top-level `hostNames`
 *    — and the site config lives in the folder's `data`. Subfolders under it
 *    organize pages; several folders = several websites/domains under one app.
 * 4. Else: notFound — NO content-system fallback.
 * 5. Result cached per host (short TTL); invalidated by the publish webhook
 *    (C11) via the exported invalidation hooks.
 *
 * ALL reads go through the DataProvider interface (Section 6B) — never the
 * Firestore SDK directly.
 */

export const SITE_CACHE_TTL_MS = 60_000

export interface SiteConfig {
  host: string
  tenant: TenantConfig
  appId: string
  /** rules.publicAccess of the matched website app - drives the object
   * collection rule (om_objects vs om_private_objects, Section 6.5). */
  appPublicAccess?: string
  folderId: string
  /** Site folder TREE (D-DWH-24): the root folder + every descendant folder
   * (parentId chain). Pages are scoped to this set - a page object carries
   * no domain info, so its folder membership decides which website it
   * belongs to. Undefined in fixtures/tests = root-only scope. */
  folderIds?: string[]
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

/**
 * The CMS folderConfigSection namespace (D-DWH-25): the folder's website
 * config lives at `data.websiteConfig.*` - declared once per app in the CMS
 * App Designer and stored per folder. Root folders carry hostNames; child
 * folders leave fields empty.
 */
function websiteConfig(folder: ObjectType): Record<string, unknown> | undefined {
  const data = getObjectData(folder)
  if (!data) return undefined
  const config = data['websiteConfig']
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : undefined
}

/** Hostnames carried by a folder: `data.websiteConfig.hostNames` only. */
export function folderHostNames(folder: ObjectType): string[] {
  const hostNames = websiteConfig(folder)?.['hostNames']
  return Array.isArray(hostNames)
    ? hostNames.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * The site's folder TREE (D-DWH-24): the root folder plus every folder that
 * descends from it via `parentId`. Deterministic: folders are walked in the
 * provider's order, transitively.
 */
export function collectFolderTree(rootId: string, folders: ObjectType[]): string[] {
  const tree: string[] = [rootId]
  const known = new Set<string>(tree)
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      const parent = typeof folder.parentId === 'string' ? folder.parentId : undefined
      if (parent && known.has(parent) && !known.has(folder.id)) {
        known.add(folder.id)
        tree.push(folder.id)
        changed = true
      }
    }
  }
  return tree
}

/**
 * PRIMARY site mapping (D-DWH-22): scan the website apps' FOLDER docs in
 * om_object_types; the folder whose hostNames match the host IS the website
 * root and its data is the site config.
 */
async function resolveFromFolderDocs(
  normalized: string,
  apps: AppDefinition[],
  provider: DataProvider,
  tenant: TenantConfig,
): Promise<SiteResolution> {
  for (const app of apps) {
    const folders = await provider.getObjectTypes(app.id)
    for (const folder of folders) {
      const config = websiteConfig(folder)
      const hostNames = folderHostNames(folder)
      if (!hostNames.some((pattern) => hostMatches(normalized, pattern))) continue

      const parsed = config ? SiteSettingsSchema.safeParse(config) : undefined
      return {
        ok: true,
        site: {
          host: normalized,
          tenant,
          appId: app.id,
          appPublicAccess: app.rules?.publicAccess,
          folderId: folder.id,
          folderIds: collectFolderTree(folder.id, folders),
          settings: parsed?.success ? parsed.data : ({ hostNames } as SiteSettings),
        },
      }
    }
  }
  return { ok: false, reason: 'site-not-found' }
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

    const resolution = await resolveFromFolderDocs(normalized, apps, provider, tenant)

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

import type { DataProvider, ObjectReadOptions } from '@/lib/data/provider'
import type { SiteConfig } from './site'
import type { AppDefinition } from '@/lib/contracts/app-config'
import type { PageObjectLoader } from './page'

/** Resolves a cmsObjectType to its registered app definition (publicAccess). */
export type AppAccessResolver = (cmsObjectType: string) => AppDefinition | undefined

/**
 * PageObjectLoader backed by the DataProvider (Section 6B) — the bridge that
 * keeps lib/resolver/page.ts Firestore-free (C4 wires it; ADR-003).
 *
 * Object reads honor the app's `rules.publicAccess` (Section 6.5): the scope
 * comes from the registered app definition (via the injected resolver) with
 * the matched site app's publicAccess as fallback for the site's own types.
 */
export function createPageObjectLoader(
  provider: DataProvider,
  site: SiteConfig,
  resolveAppAccess?: AppAccessResolver,
): PageObjectLoader {
  const scopeFor = (cmsObjectType: string): ObjectReadOptions | undefined => {
    const app = resolveAppAccess?.(cmsObjectType)
    const publicAccess =
      app?.rules?.publicAccess ?? (cmsObjectType === site.appId ? site.appPublicAccess : undefined)
    return publicAccess === 'no' ? { usePrivateObjects: true } : undefined
  }
  return {
    queryInFolder: async ({ cmsObjectType, folderIds, slug }) => {
      const result = await provider.queryObjects(
        {
          cmsObjectType,
          // Folder TREE scope (D-DWH-24); undefined → no folder filter.
          folders: folderIds,
          filters: slug !== undefined ? [{ field: 'slug', op: '==', value: slug }] : [],
          pageSize: 200,
        },
        scopeFor(cmsObjectType),
      )
      return result.items
    },
    getById: async ({ cmsObjectType, id }) =>
      provider.getObject({ type: cmsObjectType, id }, scopeFor(cmsObjectType)),
    querySiblings: async (contentId) => {
      const result = await provider.queryObjects(
        {
          cmsObjectType: site.appId,
          folder: site.folderId,
          filters: [{ field: 'contentId', op: '==', value: contentId }],
          pageSize: 200,
        },
        scopeFor(site.appId),
      )
      return result.items
    },
  }
}

import type { DataProvider } from '@/lib/data/provider'
import type { SiteConfig } from './site'
import type { PageObjectLoader } from './page'

/**
 * PageObjectLoader backed by the DataProvider (Section 6B) — the bridge that
 * keeps lib/resolver/page.ts Firestore-free (C4 wires it; ADR-003).
 */
export function createPageObjectLoader(provider: DataProvider, site: SiteConfig): PageObjectLoader {
  return {
    queryInFolder: async ({ cmsObjectType, folderId, slug }) => {
      const result = await provider.queryObjects({
        cmsObjectType,
        folder: folderId,
        filters: slug !== undefined ? [{ field: 'slug', op: '==', value: slug }] : [],
        pageSize: 200,
      })
      return result.items
    },
    getById: async ({ cmsObjectType, id }) => provider.getObject({ type: cmsObjectType, id }),
    querySiblings: async (contentId) => {
      const result = await provider.queryObjects({
        cmsObjectType: site.appId,
        folder: site.folderId,
        filters: [{ field: 'contentId', op: '==', value: contentId }],
        pageSize: 200,
      })
      return result.items
    },
  }
}

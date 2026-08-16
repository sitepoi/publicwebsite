/**
 * Cache tags (Section 18): site-<folderId>, page-<objectId>, type-<appId>,
 * host-<host>. Purge semantics live in app/api/revalidate + lib/cache/purge.
 */
export function siteTag(folderId: string): string {
  return `site-${folderId}`
}

export function pageTag(objectId: string): string {
  return `page-${objectId}`
}

export function typeTag(appId: string): string {
  return `type-${appId}`
}

export function hostTag(host: string): string {
  return `host-${host}`
}

export const TAG_PREFIXES = ['site-', 'page-', 'type-', 'host-'] as const

/** A purgeable tag — unknown shapes are rejected by the revalidate route. */
export function isPurgeableTag(tag: unknown): tag is string {
  return typeof tag === 'string' && TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))
}

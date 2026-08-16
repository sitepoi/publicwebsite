import { getResolverStack } from '@/lib/resolver'
import { siteTag, isPurgeableTag } from './tags'

/**
 * Tag purge (Section 18) — `revalidateTag` per tag plus resolver memory-cache
 * invalidation. `site-*` tags clear the host/site resolution caches so
 * folder/app config changes are visible immediately (Section 18).
 * Injectables let tests run outside the Next request scope.
 */
export interface PurgeDeps {
  revalidateTagImpl?: (tag: string) => void | Promise<void>
  clearResolverCaches?: () => void
}

export async function purgeTags(tags: string[], deps: PurgeDeps = {}): Promise<string[]> {
  const revalidateTagImpl = deps.revalidateTagImpl ?? defaultRevalidateTag
  const clearResolverCaches = deps.clearResolverCaches ?? (() => getResolverStack().clearCaches())

  const purged: string[] = []
  let touchesSiteCache = false

  for (const tag of tags) {
    if (!isPurgeableTag(tag)) continue
    await revalidateTagImpl(tag)
    purged.push(tag)
    if (tag.startsWith('site-')) touchesSiteCache = true
  }

  if (touchesSiteCache) clearResolverCaches()
  return purged
}

function defaultRevalidateTag(tag: string): void | Promise<void> {
  // Lazy import: 'next/cache' revalidateTag is only valid inside the Next
  // request lifecycle — tests inject their own implementation.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { revalidateTag } = require('next/cache') as {
    revalidateTag: (tag: string, maxAge: 'max') => void
  }
  // 'max' = full purge of the tag's data cache (Section 18 purge semantics).
  return revalidateTag(tag, 'max')
}

export { siteTag }

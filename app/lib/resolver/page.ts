import type { ObjectRecord } from '@/lib/contracts/objects'
import { HOME_PAGE_SLUG } from '@/lib/contracts/folder'
import type { SiteConfig } from './site'
import { getObjectData, isPublishedPage } from '@/lib/render/normalize'

/**
 * Pure page resolver (Section 9) — Firestore-free.
 *
 * Route kinds:
 *   '/'                 → home (object with slug 'home-page', language match)
 *   '/slug'             → object by (website folder, object-level slug,
 *                         meta.language)
 *   '/<cmsObjectType>/<id>' → object-detail page (Section 24)
 *   '/t/<template>/<contentId>' → template page kind with templatedContentId
 *                         variable (Section 2B template-pages row); the
 *                         content object may carry its own data.html (M8)
 *   '/app/<appId>/...'  → capability pages registered as page objects with
 *                         slug `app-<appId>` (M10)
 *   unknown             → notFound
 *
 * This module takes FETCHED objects (or a PageObjectLoader the caller wires
 * to the DataProvider) — never the Firestore SDK. Drafts (`data.status` ≠
 * published) are hidden unless preview (Section 8 / Q9).
 */

export type PageKind = 'home' | 'slug' | 'object' | 'template' | 'app'

export type PageRoute =
  | { kind: 'home' }
  | { kind: 'slug'; slug: string }
  | { kind: 'object'; cmsObjectType: string; id: string }
  | { kind: 'template'; template: string; contentId: string }
  | { kind: 'app'; rest: string[] }
  | { kind: 'not-found' }

export const TEMPLATE_PREFIX = 't'

/**
 * Parse the URL pathname into a route kind. '/', '' and '/' → home; trailing
 * slashes are trimmed; segments are decoded. '/t/<a>/<b>' is the template
 * form (exactly 3 segments); two segments are always '<cmsObjectType>/<id>'.
 */
export function parsePath(path: string): PageRoute {
  const trimmed = path.trim()
  const segments = trimmed
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => safeDecode(segment))
    .filter((segment) => segment.length > 0)

  if (segments.length === 0) return { kind: 'home' }

  if (segments[0] === 'app') {
    return { kind: 'app', rest: segments.slice(1) }
  }

  if (segments[0] === TEMPLATE_PREFIX) {
    if (segments.length === 3) {
      return { kind: 'template', template: segments[1]!, contentId: segments[2]! }
    }
    return { kind: 'not-found' }
  }

  if (segments.length === 1) return { kind: 'slug', slug: segments[0]! }
  if (segments.length === 2) {
    return { kind: 'object', cmsObjectType: segments[0]!, id: segments[1]! }
  }
  return { kind: 'not-found' }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Section 9 step 4: v1 has no locale path prefixes (Q4). */
export function resolveLanguage(settings: SiteConfig['settings']): string {
  return settings.defaultLanguage && settings.defaultLanguage.length > 0
    ? settings.defaultLanguage
    : 'en'
}

export function getPageLanguage(record: ObjectRecord): string | undefined {
  const language = record.meta?.['language']
  return typeof language === 'string' && language.length > 0 ? language : undefined
}

export function getPageSlug(record: ObjectRecord): string | undefined {
  return typeof record.slug === 'string' && record.slug.length > 0 ? record.slug : undefined
}

export function getPageContentId(record: ObjectRecord): string | undefined {
  return typeof record.contentId === 'string' && record.contentId.length > 0
    ? record.contentId
    : undefined
}

/**
 * Language rule (Section 8): `meta.language` must equal the requested
 * language; records WITHOUT meta.language count as the site's default
 * language (tolerant match for pre-migration objects).
 */
export function pageMatchesLanguage(
  record: ObjectRecord,
  language: string,
  defaultLanguage: string,
): boolean {
  const pageLanguage = getPageLanguage(record) ?? defaultLanguage
  return pageLanguage === language
}

/** Draft rule (Section 8/Q9): non-published pages are visible only in preview. */
export function isPageVisible(record: ObjectRecord, preview: boolean): boolean {
  if (preview) return true
  return isPublishedPage(getObjectData(record))
}

export interface SelectPageOptions {
  slug?: string
  language: string
  defaultLanguage: string
  preview?: boolean
}

/** Pure selection over already-fetched candidate objects. */
export function selectPageObject(
  objects: ObjectRecord[],
  options: SelectPageOptions,
): ObjectRecord | null {
  for (const record of objects) {
    if (options.slug !== undefined && getPageSlug(record) !== options.slug) continue
    if (!pageMatchesLanguage(record, options.language, options.defaultLanguage)) continue
    if (!isPageVisible(record, options.preview ?? false)) continue
    return record
  }
  return null
}

/** Siblings: same contentId, other languages — hreflang + language switcher. */
export function findSiblings(objects: ObjectRecord[], page: ObjectRecord): ObjectRecord[] {
  const contentId = getPageContentId(page)
  if (!contentId) return []
  const language = getPageLanguage(page)

  return objects
    .filter((record) => record.id !== page.id && getPageContentId(record) === contentId)
    .filter((record) => getPageLanguage(record) !== language)
    .sort((a, b) => (getPageLanguage(a) ?? '').localeCompare(getPageLanguage(b) ?? ''))
}

/** Caller wires this to the DataProvider (Section 6B) — page.ts stays pure. */
export interface PageObjectLoader {
  queryInFolder(args: {
    cmsObjectType: string
    folderId: string
    slug?: string
  }): Promise<ObjectRecord[]>
  getById(args: { cmsObjectType: string; id: string }): Promise<ObjectRecord | null>
  querySiblings(contentId: string): Promise<ObjectRecord[]>
}

export interface ResolvePageInput {
  site: SiteConfig
  loader: PageObjectLoader
  path: string
  language?: string
  preview?: boolean
}

export interface ResolvedPage {
  kind: PageKind
  route: ResolvedPageRoute
  page: ObjectRecord
  siblings: ObjectRecord[]
  language: string
}

export type ResolvedPageRoute = PageRoute & { kind: PageKind }

export type PageResolution =
  { ok: true; resolved: ResolvedPage } | { ok: false; reason: 'not-found' }

const NOT_FOUND: PageResolution = { ok: false, reason: 'not-found' }

export async function resolvePage(input: ResolvePageInput): Promise<PageResolution> {
  const route = parsePath(input.path)
  const language = input.language ?? resolveLanguage(input.site.settings)
  const defaultLanguage = resolveLanguage(input.site.settings)
  const preview = input.preview ?? false

  switch (route.kind) {
    case 'home': {
      const candidates = await input.loader.queryInFolder({
        cmsObjectType: input.site.appId,
        folderId: input.site.folderId,
        slug: HOME_PAGE_SLUG,
      })
      const page = selectPageObject(candidates, {
        slug: HOME_PAGE_SLUG,
        language,
        defaultLanguage,
        preview,
      })
      return finish(page, input, route, language)
    }
    case 'slug': {
      const candidates = await input.loader.queryInFolder({
        cmsObjectType: input.site.appId,
        folderId: input.site.folderId,
        slug: route.slug,
      })
      const page = selectPageObject(candidates, {
        slug: route.slug,
        language,
        defaultLanguage,
        preview,
      })
      return finish(page, input, route, language)
    }
    case 'object': {
      const page = await input.loader.getById({ cmsObjectType: route.cmsObjectType, id: route.id })
      if (!page || !isPageVisible(page, preview)) return NOT_FOUND
      return finish(page, input, route, language)
    }
    case 'template': {
      const candidates = await input.loader.queryInFolder({
        cmsObjectType: input.site.appId,
        folderId: input.site.folderId,
        slug: route.template,
      })
      const page = selectPageObject(candidates, {
        slug: route.template,
        language,
        defaultLanguage,
        preview,
      })
      if (!page) return NOT_FOUND
      // M8 template content fetch: the content object may carry its own
      // data.html (htmlPage) — when it does, that content is what renders.
      // The content type is declared on the template page
      // (`data.templateContentType`), falling back to the template slug.
      const templateData = getObjectData(page)
      const contentType =
        typeof templateData?.['templateContentType'] === 'string' &&
        templateData.templateContentType.length > 0
          ? templateData.templateContentType
          : route.template
      const content = await input.loader.getById({
        cmsObjectType: contentType,
        id: route.contentId,
      })
      const renderRecord = content && hasPageCode(content) ? content : page
      return finish(renderRecord, input, route, language)
    }
    case 'app': {
      // M10 capability pages: /app/<appId>/... renders the app object
      // registered as a page with slug `app-<appId>`.
      const appId = route.rest[0]
      if (!appId) return NOT_FOUND
      const candidates = await input.loader.queryInFolder({
        cmsObjectType: input.site.appId,
        folderId: input.site.folderId,
        slug: `app-${appId}`,
      })
      const page = selectPageObject(candidates, {
        slug: `app-${appId}`,
        language,
        defaultLanguage,
        preview,
      })
      return finish(page, input, route, language)
    }
    case 'not-found':
      return NOT_FOUND
  }
}

/** True when a record carries its own renderable data.html page code. */
function hasPageCode(record: ObjectRecord): boolean {
  return getObjectData(record)?.['htmlPage'] !== undefined
}

async function finish(
  page: ObjectRecord | null,
  input: ResolvePageInput,
  route: ResolvedPageRoute,
  language: string,
): Promise<PageResolution> {
  if (!page) return NOT_FOUND
  const contentId = getPageContentId(page)
  const siblingCandidates = contentId ? await input.loader.querySiblings(contentId) : []
  const siblings = findSiblings(siblingCandidates, page)

  return {
    ok: true,
    resolved: {
      kind: route.kind,
      route,
      page,
      siblings,
      language,
    },
  }
}

import type { ObjectRecord } from '@/lib/contracts/objects'
import { SeoSectionSchema, type SeoSection } from '@/lib/contracts/seo'
import type { SiteConfig } from '@/lib/resolver/site'
import { HOME_PAGE_SLUG } from '@/lib/contracts/folder'
import {
  getPageLanguage,
  getPageSlug,
  resolveLanguage,
  type PageKind,
  type PageRoute,
} from '@/lib/resolver/page'
import { getPageCode } from './normalize'

/**
 * RenderPlan (Section 9 step 7 / C3) — pure data, unit-testable without
 * Firestore:
 *
 *   (siteConfig, pageObject, siblings, request) → RenderPlan
 *
 * Only `data.html` (htmlPage.code.{html,css,js}) is rendered — no block
 * rendering (Section 13 hard rule). Chrome is carried via optional
 * `chromeObjects` on the site config (filled by C4 from the reserved-slug
 * objects — Section 7.4).
 */

export interface RenderSiteConfig extends SiteConfig {
  chromeObjects?: {
    header?: ObjectRecord | null
    footer?: ObjectRecord | null
  }
}

export interface RenderRequest {
  route: PageRoute & { kind: Exclude<PageKind, 'not-found'> }
  query?: Record<string, string>
}

export interface StructuredDataEntry {
  id?: string
  type: string
  json: unknown
}

export interface HrefLangEntry {
  language: string
  url: string
}

export interface LanguageSwitchEntry {
  language: string
  slug: string
  isCurrent: boolean
}

export interface RenderPlanVariables {
  pageId: string
  folderId: string
  language: string
  query: Record<string, string>
  pathParams: Record<string, string>
  templatedContentId?: string
  template?: string
}

export interface RenderPlan {
  pageId: string
  kind: PageKind
  language: string
  html: string
  css: string
  js: string
  seo: SeoSection
  structuredData: StructuredDataEntry[]
  hreflang: HrefLangEntry[]
  languageSwitch: LanguageSwitchEntry[]
  chrome: { header: ObjectRecord | null; footer: ObjectRecord | null }
  variables: RenderPlanVariables
}

const EMPTY_SEO: SeoSection = {}

/** Content is ONLY data.html: htmlPage.code.{html,css,js} (Section 8/13). */
function extractPageCode(record: ObjectRecord): { html: string; css: string; js: string } {
  const code = getPageCode(record)
  return {
    html: code?.html ?? '',
    css: code?.css ?? '',
    js: code?.js ?? '',
  }
}

function parseSeo(record: ObjectRecord): SeoSection {
  const parsed = SeoSectionSchema.safeParse(record.seo)
  return parsed.success ? parsed.data : EMPTY_SEO
}

/**
 * JSON-LD from `seo.schemaItems` (Section 16): use `json` when present (and
 * parse it when it is a JSON string), else fall back to a bare type entry.
 * No schemaItems → default WebPage entry (builders arrive in C4/M4).
 */
function buildStructuredData(seo: SeoSection): StructuredDataEntry[] {
  const items = (seo.schemaItems ?? []).map((item) => ({
    id: item.id,
    type: item.type ?? 'WebPage',
    json: parseJsonOrRaw(item.json),
  }))
  return items.length > 0 ? items : [{ type: 'WebPage', json: {} }]
}

function parseJsonOrRaw(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Canonical origin for hreflang/OG links: primaryHost, else resolved host. */
function originOf(site: RenderSiteConfig): string {
  const host = site.settings.primaryHost ?? site.host
  return `https://${host}`
}

/** URL of a page object for its route kind (hreflang / language switcher). */
export function buildPageUrl(kind: PageKind, record: ObjectRecord, site: RenderSiteConfig): string {
  const origin = originOf(site)
  const slug = getPageSlug(record) ?? ''
  switch (kind) {
    case 'home':
      return `${origin}/`
    case 'slug':
      return `${origin}/${slug}`
    case 'object':
      return `${origin}/${typeof record.cmsObjectType === 'string' ? record.cmsObjectType : ''}/${record.id}`
    case 'template':
      return `${origin}/t/${slug}/${record.id}`
  }
}

export interface BuildRenderPlanInput {
  site: RenderSiteConfig
  page: ObjectRecord
  siblings: ObjectRecord[]
  request: RenderRequest
}

export function buildRenderPlan(input: BuildRenderPlanInput): RenderPlan {
  const { site, page, siblings, request } = input
  const kind = request.route.kind
  const language = getPageLanguage(page) ?? resolveLanguage(site.settings)
  const code = extractPageCode(page)
  const seo = parseSeo(page)

  const pathParams = pathParamsOf(request.route)
  const variables: RenderPlanVariables = {
    pageId: page.id,
    folderId: site.folderId,
    language,
    query: request.query ?? {},
    pathParams,
    templatedContentId: request.route.kind === 'template' ? request.route.contentId : undefined,
    template: request.route.kind === 'template' ? request.route.template : undefined,
  }

  const allPages = [page, ...siblings]
  const hreflang = allPages
    .map((record) => ({
      language: getPageLanguage(record) ?? language,
      url: buildPageUrl(kind, record, site),
    }))
    .sort((a, b) => a.language.localeCompare(b.language))

  const languageSwitch = allPages
    .map((record) => ({
      language: getPageLanguage(record) ?? language,
      slug: kind === 'home' ? HOME_PAGE_SLUG : (getPageSlug(record) ?? ''),
      isCurrent: record.id === page.id,
    }))
    .sort((a, b) => a.language.localeCompare(b.language))

  return {
    pageId: page.id,
    kind,
    language,
    html: code.html,
    css: code.css,
    js: code.js,
    seo,
    structuredData: buildStructuredData(seo),
    hreflang,
    languageSwitch,
    chrome: {
      header: site.chromeObjects?.header ?? null,
      footer: site.chromeObjects?.footer ?? null,
    },
    variables,
  }
}

function pathParamsOf(route: RenderRequest['route']): Record<string, string> {
  switch (route.kind) {
    case 'home':
      return {}
    case 'slug':
      return { slug: route.slug }
    case 'object':
      return { cmsObjectType: route.cmsObjectType, id: route.id }
    case 'template':
      return { template: route.template, contentId: route.contentId }
  }
}

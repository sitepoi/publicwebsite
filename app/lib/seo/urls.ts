import { HOME_PAGE_SLUG } from '@/lib/contracts/folder'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { DataProvider } from '@/lib/data/provider'
import { isPublishedPage, getObjectData } from '@/lib/render/normalize'
import type { SiteConfig } from '@/lib/resolver/site'
import {
  isWebsiteCapable,
  type AppDefinition,
} from '@/lib/contracts/app-config'
import type { SeoSection } from '@/lib/contracts/seo'

/**
 * Site URL collection (M4) — shared by sitemap.xml / robots.txt / llms.txt.
 * Pure helper: the caller supplies the site + provider.
 */

export interface SiteUrlEntry {
  /** Absolute https URL. */
  url: string
  /** Entry label (page name / slug) for llms.txt. */
  label: string
  priority?: string
  changefreq?: string
  /** Language of the page object, when known. */
  language?: string
}

/** Absolute URL for a page slug — home slug collapses to '/'. */
export function pageUrlFor(site: SiteConfig, slug: string, language?: string): string {
  const host = site.settings.primaryHost ?? site.host
  const base = `https://${host}`
  const langPrefix = language && language !== site.settings.defaultLanguage ? `/${language}` : ''
  const path = slug === HOME_PAGE_SLUG ? '' : `/${slug}`
  return `${base}${langPrefix}${path}`
}

export function objectUrlFor(site: SiteConfig, record: ObjectRecord): string {
  const host = site.settings.primaryHost ?? site.host
  const cmsObjectType = typeof record.cmsObjectType === 'string' ? record.cmsObjectType : ''
  return `https://${host}/${cmsObjectType}/${record.id}`
}

function entryFor(site: SiteConfig, record: ObjectRecord): SiteUrlEntry {
  const data = getObjectData(record)
  const slug = typeof record.slug === 'string' ? record.slug : record.id
  const language =
    typeof data?.meta?.language === 'string' ? data.meta.language : undefined
  const seo = record.seo as SeoSection | undefined
  return {
    url: pageUrlFor(site, slug, language),
    label:
      (typeof record.name === 'string' && record.name) ||
      (typeof data?.title === 'string' && data.title) ||
      slug,
    priority: seo?.sitemapPriority,
    changefreq: seo?.sitemapChangefreq,
    language,
  }
}

/** Object types registered to appear in the sitemap (app webSettings). */
export function sitemapObjectTypes(
  apps: AppDefinition[],
  siteAppId: string,
): string[] {
  const app = apps.find((entry) => entry.id === siteAppId && isWebsiteCapable(entry))
  const raw = app?.webSettings?.sitemapSettings?.addObjectsToSitemap
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export async function collectSiteUrls(
  site: SiteConfig,
  provider: DataProvider,
  objectTypes: string[],
): Promise<SiteUrlEntry[]> {
  const entries: SiteUrlEntry[] = []

  // Pages of the website folder (published only).
  const pages = await provider.queryObjects({
    cmsObjectType: site.appId,
    folderId: site.folderId,
    pageSize: 500,
  })
  for (const record of pages.items) {
    if (!isPublishedPage(record)) continue
    entries.push(entryFor(site, record))
  }

  // Registered object types → detail URLs.
  for (const cmsObjectType of objectTypes) {
    const result = await provider.queryObjects({
      cmsObjectType,
      folderId: site.folderId,
      pageSize: 500,
    })
    for (const record of result.items) {
      if (!isPublishedPage(record)) continue
      entries.push({
        url: objectUrlFor(site, record),
        label: (typeof record.name === 'string' && record.name) || record.id,
      })
    }
  }

  // Stable, deduped order — home first.
  const seen = new Set<string>()
  return entries
    .filter((entry) => {
      if (seen.has(entry.url)) return false
      seen.add(entry.url)
      return true
    })
    .sort((a, b) => a.url.localeCompare(b.url))
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

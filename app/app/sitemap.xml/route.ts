import type { DataProvider } from '@/lib/data/provider'
import { getResolverStack } from '@/lib/resolver'
import { loadWebsiteAppDefinitions } from '@/lib/resolver/site'
import type { SiteResolution } from '@/lib/resolver/site'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { collectSiteUrls, escapeXml, sitemapObjectTypes } from '@/lib/seo/urls'

/**
 * GET /sitemap.xml (M4 / Section 16) — per-tenant XML sitemap driven by the
 * host header. Pages of the website folder plus object types registered via
 * app `webSettings.sitemapSettings.addObjectsToSitemap`.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export interface SitemapDeps {
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
}

export async function handleSitemap(request: Request, deps: SitemapDeps = {}): Promise<Response> {
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return new Response('Not found', { status: 404 })
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const apps = await loadWebsiteAppDefinitions(site.tenant, provider)
  const objectTypes = sitemapObjectTypes(apps, site.appId)
  const entries = await collectSiteUrls(site, provider, objectTypes)

  const urlElements = entries
    .map((entry) => {
      const priority = entry.priority ? `<priority>${escapeXml(entry.priority)}</priority>` : ''
      const changefreq = entry.changefreq
        ? `<changefreq>${escapeXml(entry.changefreq)}</changefreq>`
        : ''
      return `  <url><loc>${escapeXml(entry.url)}</loc>${changefreq}${priority}</url>`
    })
    .join('\n')

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urlElements}\n` +
    `</urlset>\n`

  return new Response(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleSitemap(request)
}

import type { DataProvider } from '@/lib/data/provider'
import { getResolverStack } from '@/lib/resolver'
import { loadWebsiteAppDefinitions } from '@/lib/resolver/site'
import type { SiteResolution } from '@/lib/resolver/site'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { collectSiteUrls, sitemapObjectTypes } from '@/lib/seo/urls'

/**
 * GET /llms.txt (M4 / Section 16) — Markdown site index for LLM crawlers,
 * per tenant via the host header.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export interface LlmsDeps {
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
}

export async function handleLlms(request: Request, deps: LlmsDeps = {}): Promise<Response> {
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return new Response('Not found', { status: 404 })
  const site = siteResult.site

  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const apps = await loadWebsiteAppDefinitions(site.tenant, provider)
  const entries = await collectSiteUrls(site, provider, sitemapObjectTypes(apps, site.appId))

  const title = site.settings.primaryHost ?? site.host
  const body = entries.map((entry) => `- [${entry.label}](${entry.url})`).join('\n')

  const text = `# ${title}\n\n${body}\n`
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleLlms(request)
}

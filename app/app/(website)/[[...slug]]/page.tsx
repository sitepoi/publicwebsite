import type { Metadata } from 'next'
import { cookies, headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import { ContentMount } from '@/components/ContentMount'
import { ScriptSlot } from '@/components/ScriptSlot'
import {
  createPageObjectLoader,
  getResolverStack,
  resolveLanguage,
  resolvePage,
  selectPageObject,
  type PageObjectLoader,
} from '@/lib/resolver'
import { DEFAULT_FOOTER_SLUG, DEFAULT_HEADER_SLUG } from '@/lib/contracts/folder'
import { getObjectData, getPageCode } from '@/lib/render/normalize'
import { readField } from '@/lib/data/common'
import { getAuthService, pageRequiresAuth } from '@/lib/auth'
import { SESSION_COOKIE } from '@/app/api/auth/session/route'
import { buildRenderPlan, type RenderPlan } from '@/lib/render/render-plan'
import {
  buildAnalyticsScripts,
  buildBootstrapScript,
  buildJsonLdScripts,
  buildThemeClasses,
  buildThemeStyle,
  bodyEndCodeOf,
  bodyStartCodeOf,
  headCodeOf,
} from '@/lib/render/shell'
import type { SiteConfig } from '@/lib/resolver/site'
import type { ObjectRecord } from '@/lib/contracts/objects'
import { getLogger, logRequest, newRequestId } from '@/lib/log/logger'

/**
 * Website pipeline (Section 10) — resolve tenant → site → page → RenderPlan,
 * then render the shell as React Server Components. Content/chrome mount via
 * the ONE client component (ContentMount). v1 renders ONLY data.html
 * (htmlPage.code) — no blocks.
 */

export const dynamic = 'force-dynamic'

interface WebsitePageProps {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

interface WebsiteResolution {
  site: SiteConfig
  plan: RenderPlan
  preview: boolean
  requireAuth: boolean
  header: { html: string; css: string; js: string } | null
  footer: { html: string; css: string; js: string } | null
}

function previewAllowed(
  query: Record<string, string | string[] | undefined>,
  site: SiteConfig,
): boolean {
  const secret = site.settings.previewSecret
  if (!secret) return false
  const value = query['gw-preview']
  return typeof value === 'string' && value.length > 0 && value === secret
}

async function loadChrome(
  loader: PageObjectLoader,
  site: SiteConfig,
  preview: boolean,
): Promise<{ header: ObjectRecord | null; footer: ObjectRecord | null }> {
  const language = resolveLanguage(site.settings)
  const [headerCandidates, footerCandidates] = await Promise.all([
    loader.queryInFolder({
      cmsObjectType: site.appId,
      folderId: site.folderId,
      slug: DEFAULT_HEADER_SLUG,
    }),
    loader.queryInFolder({
      cmsObjectType: site.appId,
      folderId: site.folderId,
      slug: DEFAULT_FOOTER_SLUG,
    }),
  ])
  const pick = (candidates: ObjectRecord[], slug: string): ObjectRecord | null =>
    selectPageObject(candidates, {
      slug,
      language,
      defaultLanguage: language,
      preview,
    }) ??
    candidates[0] ??
    null
  return {
    header: pick(headerCandidates, DEFAULT_HEADER_SLUG),
    footer: pick(footerCandidates, DEFAULT_FOOTER_SLUG),
  }
}

function codeOf(record: ObjectRecord | null): { html: string; css: string; js: string } | null {
  if (!record) return null
  const code = getPageCode(record)
  return { html: code?.html ?? '', css: code?.css ?? '', js: code?.js ?? '' }
}

const resolveWebsite = cache(
  async (
    path: string,
    host: string,
    query: Record<string, string | string[] | undefined>,
  ): Promise<WebsiteResolution | null> => {
    const stack = getResolverStack()
    const siteResult = await stack.resolveSite(host)
    if (!siteResult.ok) return null

    const site = siteResult.site
    const provider = stack.getProvider(site.tenant)
    const loader = createPageObjectLoader(provider, site)
    const preview = previewAllowed(query, site)

    const resolved = await resolvePage({
      site,
      loader,
      path,
      language: resolveLanguage(site.settings),
      preview,
    })
    if (!resolved.ok) return null

    const chrome = await loadChrome(loader, site, preview)
    const pageData = getObjectData(resolved.resolved.page)
    const plan = buildRenderPlan({
      site: { ...site, chromeObjects: chrome },
      page: resolved.resolved.page,
      siblings: resolved.resolved.siblings,
      request: { route: resolved.resolved.route, query: stringQueryOf(query) },
    })

    // Section 17 gating: requireAuth data field OR private page object.
    const requireAuth =
      pageRequiresAuth(pageData) || readField(resolved.resolved.page, 'rules.publicAccess') === 'no'

    return {
      site,
      plan,
      preview,
      requireAuth,
      header: codeOf(chrome.header),
      footer: codeOf(chrome.footer),
    }
  },
)

function stringQueryOf(
  query: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

async function resolveWithLatency(
  path: string,
  host: string,
  query: Record<string, string | string[] | undefined>,
): Promise<{ result: WebsiteResolution | null; latencyMs: number }> {
  const startedAt = Date.now()
  const result = await resolveWebsite(path, host, query)
  return { result, latencyMs: Date.now() - startedAt }
}

export async function generateMetadata({
  params,
  searchParams,
}: WebsitePageProps): Promise<Metadata> {
  const [{ slug }, query, headerList] = await Promise.all([params, searchParams, headers()])
  const host = headerList.get('x-gw-host') ?? headerList.get('host') ?? ''
  const path = slug && slug.length > 0 ? `/${slug.join('/')}` : '/'
  const result = await resolveWebsite(path, host, query)
  if (!result) return {}

  const seo = result.plan.seo
  const robotsNoIndex = result.preview || (seo.metaRobots ?? '').includes('noindex')
  const robotsNoFollow = (seo.metaRobots ?? '').includes('nofollow')
  const ogType = seo.ogType === 'website' || seo.ogType === 'article' ? seo.ogType : undefined
  const twitterCard =
    seo.twitterCard === 'summary' || seo.twitterCard === 'summary_large_image'
      ? seo.twitterCard
      : undefined

  return {
    title: seo.metaTitle || undefined,
    description: seo.metaDesc,
    keywords: seo.metaKeywords
      ? seo.metaKeywords.split(',').map((entry) => entry.trim())
      : undefined,
    authors: seo.metaAuthor ? [{ name: seo.metaAuthor }] : undefined,
    alternates: {
      canonical: seo.canonicalUrl,
      languages: Object.fromEntries(
        result.plan.hreflang.map((entry) => [entry.language, entry.url]),
      ),
    },
    robots: {
      index: !robotsNoIndex,
      follow: !robotsNoFollow,
    },
    openGraph: {
      title: seo.ogTitle ?? seo.metaTitle,
      description: seo.ogDesc,
      ...(ogType !== undefined ? { type: ogType } : {}),
      ...(seo.ogImage ? { images: [seo.ogImage] } : {}),
      ...((seo.ogUrl ?? seo.canonicalUrl) ? { url: seo.ogUrl ?? seo.canonicalUrl } : {}),
    },
    twitter: twitterCard
      ? {
          card: twitterCard,
          ...(seo.twitterSite ? { site: seo.twitterSite } : {}),
          ...(seo.twitterTitle ? { title: seo.twitterTitle } : {}),
          ...(seo.twitterCreator ? { creator: seo.twitterCreator } : {}),
          ...(seo.twitterImage ? { images: [seo.twitterImage] } : {}),
        }
      : undefined,
  }
}

export default async function WebsitePage({ params, searchParams }: WebsitePageProps) {
  const [{ slug }, query, headerList] = await Promise.all([params, searchParams, headers()])
  const host = headerList.get('x-gw-host') ?? headerList.get('host') ?? ''
  const path = slug && slug.length > 0 ? `/${slug.join('/')}` : '/'
  const { result, latencyMs } = await resolveWithLatency(path, host, query)
  if (!result) notFound()

  // Server-aware gating (Section 17): requireAuth pages and private page
  // objects redirect anonymous visitors to the first-party login page.
  if (result.requireAuth) {
    const cookieStore = await cookies()
    const session = cookieStore.get(SESSION_COOKIE)?.value
    const authService = await getAuthService()
    const authUser = session ? await authService.userFromSessionCookie(session) : null
    if (!authUser) {
      redirect(`/p/user/login?returnUrl=${encodeURIComponent(path)}`)
    }
  }

  const { site, plan, header, footer } = result

  // Structured request log (Section 20): request id, host, site, page, latency.
  logRequest(getLogger(), {
    requestId: headerList.get('x-request-id') ?? newRequestId(),
    method: 'GET',
    path,
    host,
    status: 200,
    site: site.folderId,
    page: plan.pageId,
    latencyMs,
  })
  const settings = site.settings
  const bootstrap = buildBootstrapScript({
    pageId: plan.pageId,
    siteId: site.folderId,
    folderId: site.folderId,
    language: plan.language,
    host: site.host,
    currency: settings.currency,
    query: plan.variables.query,
    pathParams: plan.variables.pathParams,
  })
  const themeStyle = buildThemeStyle(settings)
  const themeClasses = buildThemeClasses(settings)
  const analytics = buildAnalyticsScripts(settings.plugins)
  const headCode = headCodeOf(settings)
  const bodyStartCode = bodyStartCodeOf(settings)
  const bodyEndCode = bodyEndCodeOf(settings)
  const jsonLd = buildJsonLdScripts(plan.structuredData)

  return (
    <div className={themeClasses}>
      {/* gw bootstrap BEFORE content scripts (Section 12); headCode replaces
          additions-inside-head; admin slots only (Section 19 trust boundary).
          ScriptSlot appends real <head>/<body> nodes post-hydration — before
          ContentMount's double-rAF content scripts, and without React's
          script-tag warnings (ADR-004). DOMPurify (vendored) loads first. */}
      <ScriptSlot id="gw-dompurify" src="/vendor/purify.min.js" />
      <ScriptSlot id="gw-bootstrap" content={bootstrap} />
      {headCode ? <ScriptSlot id="site-head-code" content={headCode} /> : null}
      {themeStyle ? <style>{themeStyle}</style> : null}
      {analytics.head.map((snippet, index) => (
        <ScriptSlot
          key={`analytics-head-${index}`}
          id={`analytics-head-${index}`}
          src={snippet.src}
          content={snippet.content}
          async={snippet.async}
        />
      ))}
      {bodyStartCode ? <div dangerouslySetInnerHTML={{ __html: bodyStartCode }} /> : null}
      {analytics.body.map((snippet, index) => (
        <div key={`analytics-body-${index}`} dangerouslySetInnerHTML={{ __html: snippet }} />
      ))}

      {header ? <ContentMount contentId="default-header" {...header} /> : null}

      <ContentMount
        contentId={`page-${plan.pageId}`}
        html={plan.html}
        css={plan.css}
        js={plan.js}
        className="gw-page-content"
      />

      {footer ? <ContentMount contentId="default-footer" {...footer} /> : null}

      {jsonLd.map((payload, index) => (
        <ScriptSlot
          key={`jsonld-${index}`}
          id={`jsonld-${index}`}
          type="application/ld+json"
          content={payload}
        />
      ))}
      {bodyEndCode ? <div dangerouslySetInnerHTML={{ __html: bodyEndCode }} /> : null}
    </div>
  )
}

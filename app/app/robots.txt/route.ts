import { getResolverStack } from '@/lib/resolver'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * GET /robots.txt (M4 / Section 16) — per-tenant robots driven by the host
 * header; disallow list from site settings `webSettings.robots.disallow`,
 * plus a Sitemap reference.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export interface RobotsDeps {
  resolveSite?: (host: string) => Promise<SiteResolution>
}

export async function handleRobots(request: Request, deps: RobotsDeps = {}): Promise<Response> {
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return new Response('Not found', { status: 404 })
  const site = siteResult.site

  const base = site.settings.primaryHost ?? site.host
  const disallow = site.settings.webSettings?.robots?.disallow ?? []

  const lines = disallow.map((path) => `Disallow: ${path}`)
  lines.push('', `Sitemap: https://${base}/sitemap.xml`)

  const text = `User-agent: *\n${lines.join('\n')}\n`
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleRobots(request)
}

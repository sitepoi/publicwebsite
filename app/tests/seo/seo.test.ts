import { describe, expect, it } from 'vitest'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteConfig, SiteResolution } from '@/lib/resolver/site'
import { handleSitemap } from '@/app/sitemap.xml/route'
import { handleRobots } from '@/app/robots.txt/route'
import { handleLlms } from '@/app/llms.txt/route'
import { notifyIndexNow } from '@/lib/seo/indexnow'
import { createStoreProvider } from '../api/data-fakes'

/**
 * M4 (Section 16) — sitemap.xml / robots.txt / llms.txt + IndexNow ping.
 */
const site: SiteConfig = {
  host: 'www.site-a.com',
  tenant: { tenantId: 't', databaseProvider: 'firestore' },
  appId: 'website-builder-uniconbaseapps',
  folderId: 'folder-a',
  settings: {
    hostNames: ['www.site-a.com'],
    primaryHost: 'www.site-a.com',
    defaultLanguage: 'en',
    webSettings: { robots: { disallow: ['/admin'] } },
  },
}

function page(overrides: Record<string, unknown>): ObjectRecord {
  return {
    id: 'p1',
    slug: 'about',
    name: 'About',
    cmsObjectType: site.appId,
    typeId: site.folderId,
    data: { status: 'published' },
    ...overrides,
  }
}

function requestFor(host: string): Request {
  return new Request('http://internal/sitemap.xml', { headers: { host } })
}

function resolution(): SiteResolution {
  return { ok: true, site }
}

describe('sitemap.xml (M4)', () => {
  it('lists published pages + registered object types (addObjectsToSitemap)', async () => {
    const store = createStoreProvider({
      objects: [
        page({ id: 'home', slug: 'home-page', name: 'Home' }),
        page({ id: 'about', slug: 'about', name: 'About' }),
        page({ id: 'draft', slug: 'draft', data: { status: 'draft' } }),
        page({ id: 'infra', slug: 'default-settings', name: 'Settings' }),
        page({
          id: 'op-x',
          data: { status: 'published', operationId: 'x' },
          slug: undefined,
        }),
        {
          id: 'prod-1',
          slug: 'pizza',
          name: 'Pizza',
          cmsObjectType: 'products',
          typeId: site.folderId,
          data: { status: 'published' },
        },
      ],
      settings: {
        'cms-settings': {
          objectTypes: [
            {
              id: site.appId,
              capabilities: ['website'],
              webSettings: { sitemapSettings: { addObjectsToSitemap: 'products' } },
            },
          ],
        },
      },
    })

    const response = await handleSitemap(requestFor('www.site-a.com'), {
      resolveSite: async () => resolution(),
      providerFor: () => store.provider,
    })

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('<urlset')
    expect(body).toContain('<loc>https://www.site-a.com/</loc>')
    expect(body).toContain('<loc>https://www.site-a.com/about</loc>')
    expect(body).toContain('<loc>https://www.site-a.com/products/prod-1</loc>')
    expect(body).not.toContain('draft')
    expect(body).not.toContain('default-settings')
    expect(body).not.toContain('op-x')
  })

  it('404s for unknown hosts', async () => {
    const store = createStoreProvider()
    const response = await handleSitemap(requestFor('nope.test'), {
      resolveSite: async () => ({ ok: false, reason: 'site-not-found' }),
      providerFor: () => store.provider,
    })
    expect(response.status).toBe(404)
  })
})

describe('robots.txt (M4)', () => {
  it('serves disallow rules from settings + the sitemap reference', async () => {
    const response = await handleRobots(requestFor('www.site-a.com'), {
      resolveSite: async () => resolution(),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('User-agent: *')
    expect(body).toContain('Disallow: /admin')
    expect(body).toContain('Sitemap: https://www.site-a.com/sitemap.xml')
  })
})

describe('llms.txt (M4)', () => {
  it('serves a markdown index of site URLs', async () => {
    const store = createStoreProvider({
      objects: [page({ id: 'home', slug: 'home-page', name: 'Home' })],
    })
    const response = await handleLlms(requestFor('www.site-a.com'), {
      resolveSite: async () => resolution(),
      providerFor: () => store.provider,
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('# www.site-a.com')
    expect(body).toContain('- [Home](https://www.site-a.com/)')
  })
})

describe('notifyIndexNow (M4)', () => {
  it('POSTs the IndexNow payload and never throws', async () => {
    const calls: string[] = []
    const ok = await notifyIndexNow({ url: 'https://www.site-a.com/about', key: 'k123' }, (async (
      _url: string,
      init?: RequestInit,
    ) => {
      calls.push(JSON.stringify(JSON.parse(String(init?.body ?? ''))))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch)
    expect(ok).toBe(true)
    expect(calls[0]).toContain('"host":"www.site-a.com"')
    expect(calls[0]).toContain('"key":"k123"')
    expect(calls[0]).toContain('https://www.site-a.com/about')

    const failed = await notifyIndexNow(
      { url: 'https://www.site-a.com/about', key: 'k123' },
      (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
    )
    expect(failed).toBe(false)
  })
})

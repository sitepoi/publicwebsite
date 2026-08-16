import { describe, expect, it } from 'vitest'
import { buildPageUrl, buildRenderPlan, type RenderSiteConfig } from '@/lib/render/render-plan'
import type { ObjectRecord } from '@/lib/contracts/objects'

const site: RenderSiteConfig = {
  host: 'www.site-a.com',
  tenant: { tenantId: 't', databaseProvider: 'firestore' },
  appId: 'website-builder-uniconbaseapps',
  folderId: 'folder-a',
  settings: {
    hostNames: ['www.site-a.com', 'site-a.com'],
    primaryHost: 'www.site-a.com',
    defaultLanguage: 'en',
  },
  chromeObjects: {
    header: {
      id: 'default-header',
      slug: 'default-header',
      data: { htmlPage: { code: { html: '<header/>' } } },
    },
    footer: {
      id: 'default-footer',
      slug: 'default-footer',
      data: { htmlPage: { code: { html: '<footer/>' } } },
    },
  },
}

/** Section 8 REAL page object shape (new `data` field + fixed SEO section). */
const page: ObjectRecord = {
  id: 'sample-page-1',
  slug: 'sample-page-1',
  contentId: 'sample-page-content',
  cmsObjectType: site.appId,
  typeId: site.folderId,
  meta: { language: 'en' },
  data: {
    htmlPage: {
      code: {
        html: '<main>hello</main>',
        css: '.gw-hero { color: red }',
        js: '(function(){ window.ready = true })()',
      },
    },
    status: 'published',
  },
  seo: {
    schemaItems: [{ id: 'seo-1', type: 'WebPage', json: '{"@type":"WebPage"}' }],
    metaTitle: 'Meta TITLE goes here',
    canonicalUrl: 'https://www.site-a.com/sample-page-1',
    aiEntityType: 'WebPage',
  },
}

const siblingDe: ObjectRecord = {
  id: 'sample-page-de',
  slug: 'beispielseite',
  contentId: 'sample-page-content',
  cmsObjectType: site.appId,
  typeId: site.folderId,
  meta: { language: 'de' },
  data: { htmlPage: { code: { html: '<main>hallo</main>' } } },
  seo: { metaTitle: 'Deutsch' },
}

describe('buildPageUrl (hreflang origins, Section 16)', () => {
  it('uses primaryHost as the canonical origin', () => {
    expect(buildPageUrl('slug', page, site)).toBe('https://www.site-a.com/sample-page-1')
  })

  it('home pages map to the root URL', () => {
    expect(buildPageUrl('home', { ...page, slug: 'home-page' }, site)).toBe(
      'https://www.site-a.com/',
    )
  })

  it('object pages map to /<cmsObjectType>/<id>', () => {
    expect(buildPageUrl('object', { ...page, cmsObjectType: 'products', id: 'p1' }, site)).toBe(
      'https://www.site-a.com/products/p1',
    )
  })

  it('template pages map to /t/<template>/<contentId>', () => {
    expect(buildPageUrl('template', { ...page, slug: 'recipe', id: 'c1' }, site)).toBe(
      'https://www.site-a.com/t/recipe/c1',
    )
  })
})

describe('buildRenderPlan (pure render props)', () => {
  it('extracts html/css/js from htmlPage.code (data.html only — no blocks)', () => {
    const plan = buildRenderPlan({
      site,
      page,
      siblings: [],
      request: { route: { kind: 'slug', slug: 'sample-page-1' } },
    })
    expect(plan.html).toBe('<main>hello</main>')
    expect(plan.css).toBe('.gw-hero { color: red }')
    expect(plan.js).toBe('(function(){ window.ready = true })()')
    expect(plan.kind).toBe('slug')
    expect(plan.pageId).toBe('sample-page-1')
  })

  it('carries the fixed SEO section', () => {
    const plan = buildRenderPlan({
      site,
      page,
      siblings: [],
      request: { route: { kind: 'slug', slug: 'sample-page-1' } },
    })
    expect(plan.seo.metaTitle).toBe('Meta TITLE goes here')
    expect(plan.seo.canonicalUrl).toBe('https://www.site-a.com/sample-page-1')
  })

  it('structuredData parses schemaItems json; empty → default WebPage', () => {
    const withItems = buildRenderPlan({
      site,
      page,
      siblings: [],
      request: { route: { kind: 'slug', slug: 'sample-page-1' } },
    })
    expect(withItems.structuredData).toEqual([
      { id: 'seo-1', type: 'WebPage', json: { '@type': 'WebPage' } },
    ])

    const withoutItems = buildRenderPlan({
      site,
      page: { ...page, seo: {} },
      siblings: [],
      request: { route: { kind: 'slug', slug: 'sample-page-1' } },
    })
    expect(withoutItems.structuredData).toEqual([{ type: 'WebPage', json: {} }])
  })

  it('carries chrome objects from the site config (C4 fills them)', () => {
    const plan = buildRenderPlan({
      site,
      page,
      siblings: [],
      request: { route: { kind: 'slug', slug: 'sample-page-1' } },
    })
    expect(plan.chrome.header?.slug).toBe('default-header')
    expect(plan.chrome.footer?.slug).toBe('default-footer')
  })

  it('variables merge query + path params; template adds templatedContentId', () => {
    const slugPlan = buildRenderPlan({
      site,
      page,
      siblings: [],
      request: {
        route: { kind: 'slug', slug: 'sample-page-1' },
        query: { utm_source: 'x' },
      },
    })
    expect(slugPlan.variables.query).toEqual({ utm_source: 'x' })
    expect(slugPlan.variables.pathParams).toEqual({ slug: 'sample-page-1' })
    expect(slugPlan.variables.templatedContentId).toBeUndefined()

    const templatePlan = buildRenderPlan({
      site,
      page: { ...page, slug: 'recipe', id: 'recipe' },
      siblings: [],
      request: { route: { kind: 'template', template: 'recipe', contentId: 'c1' } },
    })
    expect(templatePlan.variables.templatedContentId).toBe('c1')
    expect(templatePlan.variables.template).toBe('recipe')
    expect(templatePlan.variables.pathParams).toEqual({ template: 'recipe', contentId: 'c1' })
  })

  it('hreflang covers page + siblings; language switcher flags current', () => {
    const plan = buildRenderPlan({
      site,
      page,
      siblings: [siblingDe],
      request: { route: { kind: 'slug', slug: 'sample-page-1' } },
    })
    expect(plan.hreflang).toEqual([
      { language: 'de', url: 'https://www.site-a.com/beispielseite' },
      { language: 'en', url: 'https://www.site-a.com/sample-page-1' },
    ])
    expect(plan.languageSwitch).toEqual([
      { language: 'de', slug: 'beispielseite', isCurrent: false },
      { language: 'en', slug: 'sample-page-1', isCurrent: true },
    ])
  })

  it('home hreflang entries map to root URLs per language', () => {
    const plan = buildRenderPlan({
      site,
      page: { ...page, slug: 'home-page' },
      siblings: [{ ...siblingDe, slug: 'home-page' }],
      request: { route: { kind: 'home' } },
    })
    expect(plan.hreflang.every((entry) => entry.url === 'https://www.site-a.com/')).toBe(true)
  })

  it('normalization fallback: productData.data_categoriesBased carries the html', () => {
    const legacyPage: ObjectRecord = {
      id: 'legacy',
      slug: 'legacy',
      meta: { language: 'en' },
      productData: {
        data_categoriesBased: { htmlPage: { code: { html: '<main>legacy html</main>' } } },
      },
    }
    const plan = buildRenderPlan({
      site,
      page: legacyPage,
      siblings: [],
      request: { route: { kind: 'slug', slug: 'legacy' } },
    })
    expect(plan.html).toBe('<main>legacy html</main>')
  })
})

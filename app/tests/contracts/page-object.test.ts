import { describe, expect, it } from 'vitest'
import { HtmlPageCodeSchema, PageDataSchema, PageObjectSchema } from '@/lib/contracts/page-object'

/** The REAL page object schema from Section 8 — parsed EXACTLY. */
const section8PageObject = {
  name: 'Sample Page 1',
  slug: 'sample-page-1', // object-level slug (per language)
  id: '2026-08-15-sample-page', // object id
  meta: { language: 'en' },
  productData: {
    data_categoriesBased: {
      htmlPage: {
        // ★ content field name (the html-tool field)
        code: {
          html: '<main>…</main>', // inner page HTML (no document shell)
          css: '.gw-hero { … }', // page CSS — appended to <head>
          js: '(function(){ … })()', // page JS — executed after mount
        },
        history: [
          {
            version: '1.1.0',
            time: '2026-08-15T00:00:00Z',
            label: 'publish',
            html: '<main>old</main>',
            css: '',
            js: '',
          },
        ],
        version: '1.1.0',
        activeSessionId: '',
        _instanceId: 'inst_123',
        _parentRecordId: '',
      },
    },
  },
  seo: {
    schemaItems: [{ id: 'seo-1', type: 'WebPage', json: '' }],
    metaTitle: 'Meta TITLE goes here',
    metaDesc: 'Meta Desc goes here',
    metaImage: 'https://some-image-url.com',
    canonicalUrl: 'https://canonical-url.com',
    metaRobots: 'index, follow',
    ogTitle: '…',
    ogType: 'website',
    ogDesc: '…',
    ogImage: '…',
    ogUrl: '…',
    twitterCard: 'summary',
    twitterSite: '@sample',
    twitterTitle: '…',
    twitterCreator: '…',
    twitterImage: '…',
    aiDescription: '…',
    aiEntityType: 'WebPage',
    aiIntent: 'informational',
    aiKeyTopics: '…',
    aiAudience: '…',
    metaAuthor: '…',
    metaKeywords: '…',
    sitemapPriority: '0.9',
    sitemapChangefreq: 'weekly',
  },
  blocks: [], // object blocks capability remains; NEXT-GEN renders only htmlPage
  source: { tenantId: 't1', cmsObjectType: 'website-builder-uniconbaseapps' },
}

describe('PageObjectSchema (Section 8 — REAL schema)', () => {
  it('parses the Section 8 page object example exactly', () => {
    const parsed = PageObjectSchema.parse(section8PageObject)
    expect(parsed.slug).toBe('sample-page-1')
    expect(parsed.meta?.language).toBe('en')
    const htmlPage = parsed.productData?.data_categoriesBased?.htmlPage
    expect(htmlPage?.code?.html).toBe('<main>…</main>')
    expect(htmlPage?.code?.css).toBe('.gw-hero { … }')
    expect(htmlPage?.code?.js).toBe('(function(){ … })()')
    expect(htmlPage?.history).toHaveLength(1)
    expect(htmlPage?.history?.[0]?.version).toBe('1.1.0')
    expect(parsed.seo?.metaTitle).toBe('Meta TITLE goes here')
    expect(parsed.seo?.schemaItems?.[0]?.type).toBe('WebPage')
  })

  it('htmlPage is the FIXED html-tool field name — no aliases', () => {
    const withAlias = PageObjectSchema.safeParse({
      ...section8PageObject,
      productData: { data_categoriesBased: { htmlCode: { code: { html: 'x' } } } },
    })
    // htmlPage absent → no content, but the object itself still parses
    expect(withAlias.success).toBe(true)
    expect(withAlias.data?.productData?.data_categoriesBased?.htmlPage).toBeUndefined()
  })

  it('new objects use `data` (top-level) with the same htmlPage shape', () => {
    const parsed = PageObjectSchema.parse({
      ...section8PageObject,
      data: { htmlPage: { code: { html: '<h1>new</h1>' } }, status: 'draft' },
    })
    expect(parsed.data?.htmlPage?.code?.html).toBe('<h1>new</h1>')
    expect(parsed.data?.status).toBe('draft')
  })

  it('PageDataSchema accepts requireAuth gating (Section 17)', () => {
    const parsed = PageDataSchema.parse({ htmlPage: { code: { html: 'x' } }, requireAuth: true })
    expect(parsed.requireAuth).toBe(true)
  })

  it('HtmlPageCodeSchema requires html; css/js are separate optional fields', () => {
    expect(HtmlPageCodeSchema.parse({ html: '<p>hi</p>' })).toEqual({ html: '<p>hi</p>' })
    expect(HtmlPageCodeSchema.safeParse({ css: '.a{}' }).success).toBe(false)
    const full = HtmlPageCodeSchema.parse({ html: 'a', css: 'b', js: 'c' })
    expect(full).toEqual({ html: 'a', css: 'b', js: 'c' })
  })
})

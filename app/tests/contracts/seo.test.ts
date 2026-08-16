import { describe, expect, it } from 'vitest'
import { SeoSectionSchema } from '@/lib/contracts/seo'

/** The FIXED object SEO section from Section 8 — parsed EXACTLY. */
const section8Seo = {
  schemaItems: [{ id: 'seo-1', type: 'WebPage', json: '' }],
  metaTitle: 'Meta TITLE goes here',
  metaDesc: 'Meta Desc goes here',
  metaImage: 'https://some-image-url.com',
  canonicalUrl: 'https://canonical-url.com',
  metaRobots: 'index, follow',
  ogTitle: 'OG title',
  ogType: 'website',
  ogDesc: 'OG desc',
  ogImage: 'https://og-image',
  ogUrl: 'https://og-url',
  twitterCard: 'summary',
  twitterSite: '@sample',
  twitterTitle: 'Tweet title',
  twitterCreator: '@creator',
  twitterImage: 'https://tw-image',
  aiDescription: 'AI desc',
  aiEntityType: 'WebPage',
  aiIntent: 'informational',
  aiKeyTopics: 'topic a, topic b',
  aiAudience: 'everyone',
  metaAuthor: 'Author',
  metaKeywords: 'k1, k2',
  sitemapPriority: '0.9',
  sitemapChangefreq: 'weekly',
}

describe('SeoSectionSchema (Section 8 — fixed SEO section)', () => {
  it('parses the fixed SEO section exactly', () => {
    const parsed = SeoSectionSchema.parse(section8Seo)
    expect(parsed.schemaItems).toHaveLength(1)
    expect(parsed.schemaItems?.[0]?.type).toBe('WebPage')
    expect(parsed.metaTitle).toBe('Meta TITLE goes here')
    expect(parsed.canonicalUrl).toBe('https://canonical-url.com')
    expect(parsed.ogType).toBe('website')
    expect(parsed.twitterCard).toBe('summary')
    expect(parsed.aiEntityType).toBe('WebPage')
    expect(parsed.sitemapPriority).toBe('0.9')
    expect(parsed.sitemapChangefreq).toBe('weekly')
  })

  it('empty SEO section is valid (fields are optional)', () => {
    expect(SeoSectionSchema.safeParse({}).success).toBe(true)
  })

  it('schemaItems tolerate extra fields', () => {
    const parsed = SeoSectionSchema.parse({
      schemaItems: [{ id: 'x', type: 'FAQPage', json: '{"a":1}', extra: true }],
    })
    expect(parsed.schemaItems?.[0]?.json).toBe('{"a":1}')
  })
})

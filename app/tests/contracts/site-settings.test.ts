import { describe, expect, it } from 'vitest'
import { SiteSettingsSchema } from '@/lib/contracts/site-settings'

/** The default-settings object DATA from Section 7.4 — parsed EXACTLY. */
const section74Example = {
  hostNames: ['site-a.com', 'www.site-a.com'], // REQUIRED (≥1) — domain mapping
  primaryHost: 'www.site-a.com', // canonical
  defaultLanguage: 'en',
  previewSecret: 's3cret', // enables ?gw-preview=
  currency: 'USD',
  theme: {
    colors: { primary: '#111263' },
    cssVariables: { '--gw-radius': '12px' },
    cssClasses: [],
  },
  headCode: '<style>body{}</style>',
  bodyStartCode: '<noscript>JS disabled</noscript>',
  bodyEndCode: '<script>gtag()</script>',
  plugins: {
    googleAnalyticsId: 'G-XXXX',
    googleTagId: 'GTM-XXXX',
    facebookPixelId: '123',
    shareThis: 'abc',
  },
  webSettings: {
    sitemap: { include: 'yes' },
    robots: { disallow: ['/private'] },
    indexNow: { keyEnv: 'SITE_A_INDEXNOW_KEY' },
  },
}

describe('SiteSettingsSchema (Section 7.4)', () => {
  it('parses the Section 7.4 default-settings example exactly', () => {
    const parsed = SiteSettingsSchema.parse(section74Example)
    expect(parsed.hostNames).toEqual(['site-a.com', 'www.site-a.com'])
    expect(parsed.primaryHost).toBe('www.site-a.com')
    expect(parsed.defaultLanguage).toBe('en')
    expect(parsed.currency).toBe('USD')
    expect(parsed.theme?.colors?.primary).toBe('#111263')
    expect(parsed.theme?.cssVariables?.['--gw-radius']).toBe('12px')
    expect(parsed.plugins?.googleAnalyticsId).toBe('G-XXXX')
    expect(parsed.headCode).toContain('body{}')
    expect(parsed.webSettings?.indexNow?.keyEnv).toBe('SITE_A_INDEXNOW_KEY')
  })

  it('hostNames is REQUIRED and must have at least one entry', () => {
    expect(SiteSettingsSchema.safeParse({}).success).toBe(false)
    expect(SiteSettingsSchema.safeParse({ hostNames: [] }).success).toBe(false)
    expect(SiteSettingsSchema.safeParse({ hostNames: ['only.example'] }).success).toBe(true)
  })

  it('tolerates theme-only minimal settings with hostNames', () => {
    const parsed = SiteSettingsSchema.parse({
      hostNames: ['x.example'],
      theme: { cssVariables: { '--primary': '#000' } },
    })
    expect(parsed.theme?.colors).toBeUndefined()
  })
})

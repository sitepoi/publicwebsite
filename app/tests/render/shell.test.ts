import { describe, expect, it } from 'vitest'
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
import type { SiteSettings } from '@/lib/contracts/site-settings'

const settings: SiteSettings = {
  hostNames: ['site-a.test'],
  theme: {
    colors: { primary: '#111263' },
    cssVariables: { '--gw-radius': '12px' },
    cssClasses: ['theme-a', ' theme-b '],
  },
  headCode: 'window.headRan = true;',
  bodyStartCode: '<div id="start"></div>',
  bodyEndCode: '<div id="end"></div>',
  plugins: {
    googleAnalyticsId: 'G-ABC123',
    googleTagId: 'GTM-ABC123',
    facebookPixelId: '123456789',
    shareThis: 'abc-xyz-123',
  },
}

describe('buildBootstrapScript (Section 12 inline context)', () => {
  it('serializes the full gw SDK + context into the bootstrap source', () => {
    const script = buildBootstrapScript({
      pageId: 'p1',
      siteId: 'site-a',
      folderId: 'site-a',
      language: 'en',
      host: 'site-a.test',
      currency: 'USD',
      query: { utm_source: 'x' },
      pathParams: { slug: 'about' },
    })
    expect(script).toContain('function installGwSdk')
    expect(script).toContain('"pageId":"p1"')
    expect(script).toContain('"slug":"about"')
    expect(script).not.toContain('</script>')
  })
})

describe('buildThemeStyle / buildThemeClasses (Section 7.4)', () => {
  it('maps colors to --gw-color-* and keeps cssVariables as-is', () => {
    const css = buildThemeStyle(settings)
    expect(css).toContain('--gw-color-primary: #111263;')
    expect(css).toContain('--gw-radius: 12px;')
    expect(css.startsWith(':root {')).toBe(true)
  })

  it('returns empty strings for absent theme', () => {
    expect(buildThemeStyle({ hostNames: ['x.com'] })).toBe('')
    expect(buildThemeClasses({ hostNames: ['x.com'] })).toBe('')
  })

  it('trims cssClasses into wrapper tokens', () => {
    expect(buildThemeClasses(settings)).toBe('theme-a theme-b')
  })
})

describe('slot helpers (replace legacy additions-*)', () => {
  it('returns non-empty slot code', () => {
    expect(headCodeOf(settings)).toBe('window.headRan = true;')
    expect(bodyStartCodeOf(settings)).toBe('<div id="start"></div>')
    expect(bodyEndCodeOf(settings)).toBe('<div id="end"></div>')
    expect(headCodeOf({ hostNames: ['x.com'] })).toBe('')
  })
})

describe('buildAnalyticsScripts (2B chrome rows)', () => {
  it('builds gtag/GTM/pixel/sharethis snippets from plugin config', () => {
    const { head, body } = buildAnalyticsScripts(settings.plugins)
    expect(head.some((entry) => entry.src?.includes('gtag/js?id=G-ABC123'))).toBe(true)
    expect(head.some((entry) => entry.content?.includes("gtm.js?id='"))).toBe(true)
    expect(head.some((entry) => entry.content?.includes("fbq('init','123456789')"))).toBe(true)
    expect(head.some((entry) => entry.src?.includes('sharethis.js#property=abc-xyz-123'))).toBe(
      true,
    )
    expect(body.some((entry) => entry.includes('googletagmanager.com/ns.html'))).toBe(true)
  })

  it('skips unsafe or absent ids', () => {
    const { head } = buildAnalyticsScripts({ googleAnalyticsId: 'G-EVIL"><script>' })
    expect(head).toHaveLength(0)
    expect(buildAnalyticsScripts(undefined).head).toHaveLength(0)
  })
})

describe('buildJsonLdScripts (Section 16)', () => {
  it('serializes structured data entries as script payloads', () => {
    const scripts = buildJsonLdScripts([{ type: 'WebPage', json: { '@type': 'WebPage' } }])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toBe('{"@type":"WebPage"}')
    expect(scripts[0]).not.toContain('<script')
  })
})

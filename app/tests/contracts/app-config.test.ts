import { describe, expect, it } from 'vitest'
import { AppDefinitionSchema, isWebsiteCapable } from '@/lib/contracts/app-config'

/** The JSON example from Section 7.1 — parsed EXACTLY. */
const section71Example = {
  id: 'website-builder-uniconbaseapps',
  capabilities: ['website'],
  rules: { publicAccess: 'yes' },
  webSettings: { sitemapSettings: { addObjectsToSitemap: 'yes' } },
}

describe('AppDefinitionSchema (Section 7.1)', () => {
  it('parses the Section 7.1 JSON example exactly', () => {
    const parsed = AppDefinitionSchema.parse(section71Example)
    expect(parsed.id).toBe('website-builder-uniconbaseapps')
    expect(parsed.capabilities).toContain('website')
    expect(parsed.rules?.publicAccess).toBe('yes')
    expect(parsed.webSettings?.sitemapSettings?.addObjectsToSitemap).toBe('yes')
  })

  it('parses a third-party app manifest with renderer (Section 23)', () => {
    const parsed = AppDefinitionSchema.parse({
      id: 'restaurant-orders-app',
      capabilities: ['website', 'ordering'],
      renderer: { package: '@uniconhub/restaurant-orders', version: '1.2.0' },
      routes: { '/order': { page: 'ordering' } },
      schema: { folderConfig: { type: 'object' } },
    })
    expect(parsed.renderer?.package).toBe('@uniconhub/restaurant-orders')
  })

  it('requires an app id', () => {
    expect(AppDefinitionSchema.safeParse({ capabilities: ['website'] }).success).toBe(false)
  })

  it('isWebsiteCapable: website capability marks the app', () => {
    expect(isWebsiteCapable(section71Example)).toBe(true)
    expect(isWebsiteCapable({ capabilities: ['ordering'] })).toBe(false)
    expect(isWebsiteCapable({ capabilities: [] })).toBe(false)
    expect(isWebsiteCapable({})).toBe(false)
  })
})

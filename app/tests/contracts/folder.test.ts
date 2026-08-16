import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS_SLUG,
  FolderObjectTypeSchema,
  HOME_PAGE_SLUG,
  RESERVED_SITE_SLUGS,
} from '@/lib/contracts/folder'

/** The JSON example from Section 7.2 — parsed EXACTLY. */
const section72Example = {
  id: 'site-a', // folder id = website id
  slug: 'site-a',
  mainObjectType: 'websites-uniconbaseapps',
  name: 'Site A',
  categories: [],
  data: { base: true, seo: true },
  // ← nothing website-specific here
}

describe('FolderObjectTypeSchema (Section 7.2)', () => {
  it('parses the Section 7.2 JSON example exactly', () => {
    const parsed = FolderObjectTypeSchema.parse(section72Example)
    expect(parsed.id).toBe('site-a')
    expect(parsed.slug).toBe('site-a')
    expect(parsed.mainObjectType).toBe('websites-uniconbaseapps')
    expect(parsed.name).toBe('Site A')
    expect(parsed.data).toEqual({ base: true, seo: true })
  })

  it('folders carry NO website-specific fields (still parses when absent)', () => {
    const parsed = FolderObjectTypeSchema.parse({ id: 'site-b' })
    expect(parsed.id).toBe('site-b')
    expect(parsed.slug).toBeUndefined()
    expect(parsed.data).toBeUndefined()
  })

  it('requires a folder id', () => {
    expect(FolderObjectTypeSchema.safeParse({ name: 'no-id' }).success).toBe(false)
  })

  it('reserved site slugs are the three fixed ones (Section 7.4)', () => {
    expect(RESERVED_SITE_SLUGS).toEqual(['default-header', 'default-footer', 'default-settings'])
    expect(DEFAULT_SETTINGS_SLUG).toBe('default-settings')
    expect(HOME_PAGE_SLUG).toBe('home-page')
  })
})

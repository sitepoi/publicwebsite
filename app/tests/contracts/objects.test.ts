import { describe, expect, it } from 'vitest'
import { ObjectRecordSchema } from '@/lib/contracts/objects'

describe('ObjectRecordSchema (Section 6 — generic object record)', () => {
  it('parses the Section 6 object schema fields', () => {
    const parsed = ObjectRecordSchema.parse({
      id: 'obj-1',
      _id: 'obj-1',
      contentId: 'c-1',
      slug: 'home-page',
      name: 'Home',
      cmsObjectType: 'website-builder-uniconbaseapps',
      typeId: 'site-a',
      data: { htmlPage: { code: { html: '<h1>hi</h1>' } } },
      blocks: [],
      meta: { language: 'en' },
      permissions: {},
      created: 0,
      lastUpdated: 0,
    })
    expect(parsed.id).toBe('obj-1')
    expect(parsed.meta?.language).toBe('en')
    expect(parsed.typeId).toBe('site-a')
  })

  it('id is required (provider maps doc ids into it)', () => {
    expect(ObjectRecordSchema.safeParse({ name: 'no-id' }).success).toBe(false)
  })
})

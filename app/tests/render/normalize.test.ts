import { describe, expect, it } from 'vitest'
import { getObjectData, getPageCode, getPageStatus, isPublishedPage } from '@/lib/render/normalize'

describe('lib/render/normalize (Sections 6/8 — data → productData.data_categoriesBased)', () => {
  const legacyRecord = {
    id: 'page-1',
    productData: {
      data_categoriesBased: {
        htmlPage: { code: { html: '<h1>legacy</h1>', css: 'h1{}', js: 'void 0' } },
        status: 'published',
      },
    },
  }

  const newRecord = {
    id: 'page-2',
    data: { htmlPage: { code: { html: '<h1>new</h1>' } }, status: 'draft' },
  }

  const bothRecord = {
    id: 'page-3',
    data: { htmlPage: { code: { html: '<h1>new wins</h1>' } } },
    productData: {
      data_categoriesBased: { htmlPage: { code: { html: '<h1>legacy</h1>' } } },
    },
  }

  it('reads `data` first', () => {
    const data = getObjectData(newRecord)
    expect(data?.['status']).toBe('draft')
  })

  it('falls back to productData.data_categoriesBased', () => {
    const data = getObjectData(legacyRecord)
    expect(data?.['status']).toBe('published')
  })

  it('`data` wins when both are present (no merging)', () => {
    const data = getObjectData(bothRecord)
    expect(getPageCode(bothRecord)?.html).toBe('<h1>new wins</h1>')
    expect(data?.['htmlPage']).toEqual(bothRecord.data.htmlPage)
  })

  it('returns undefined when neither field exists', () => {
    expect(getObjectData({ id: 'x' })).toBeUndefined()
    expect(getObjectData({ id: 'x', productData: {} })).toBeUndefined()
    expect(
      getObjectData({ id: 'x', data: null, productData: { data_categoriesBased: null } }),
    ).toBe(undefined)
  })

  it('getPageCode extracts htmlPage.code.{html,css,js} from the new data field', () => {
    expect(getPageCode(newRecord)).toEqual({ html: '<h1>new</h1>' })
  })

  it('getPageCode extracts from the legacy fallback', () => {
    const code = getPageCode(legacyRecord)
    expect(code).toEqual({ html: '<h1>legacy</h1>', css: 'h1{}', js: 'void 0' })
  })

  it('getPageCode returns undefined when htmlPage is absent or malformed', () => {
    expect(getPageCode({ id: 'x' })).toBeUndefined()
    expect(getPageCode({ id: 'x', data: { other: true } })).toBeUndefined()
    expect(
      getPageCode({ id: 'x', data: { htmlPage: { code: { css: 'no html' } } } }),
    ).toBeUndefined()
  })

  it('status: absent = published, drafts only in preview (Section 8/Q9)', () => {
    expect(getPageStatus(undefined)).toBe('published')
    expect(getPageStatus({})).toBe('published')
    expect(getPageStatus({ status: 'draft' })).toBe('draft')
    expect(getPageStatus({ status: '' })).toBe('published')
    expect(isPublishedPage({ status: 'published' })).toBe(true)
    expect(isPublishedPage({ status: 'draft' })).toBe(false)
    expect(isPublishedPage(undefined)).toBe(true)
  })
})

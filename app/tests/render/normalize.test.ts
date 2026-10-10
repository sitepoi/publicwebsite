import { describe, expect, it } from 'vitest'
import { getObjectData, getPageCode, getPageStatus, isPublishedPage } from '@/lib/render/normalize'

describe('lib/render/normalize (Sections 6/8 — data → productData.data_categoriesBased)', () => {
  const legacyRecord = {
    id: 'page-1',
    productData: {
      data_categoriesBased: {
        htmlPage: { code: { html: '<h1>legacy</h1>', css: 'h1{}', js: 'void 0' } },
        marker: 'published',
      },
    },
  }

  const newRecord = {
    id: 'page-2',
    data: { htmlPage: { code: { html: '<h1>new</h1>' } }, marker: 'draft' },
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
    expect(data?.['marker']).toBe('draft')
  })

  it('falls back to productData.data_categoriesBased', () => {
    const data = getObjectData(legacyRecord)
    expect(data?.['marker']).toBe('published')
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

  it('getPageCode accepts the CMS builder alias webpageContentWithBuilder.code (D-DWH-21)', () => {
    const cmsBuiltPage = {
      id: 'page-4',
      productData: {
        data_categoriesBased: {
          webpageContentWithBuilder: {
            code: { html: '<h1>cms-built</h1>', css: '.a{}', js: 'void 0' },
            seo: { metaTitle: 't' },
          },
        },
      },
    }
    expect(getPageCode(cmsBuiltPage)).toEqual({
      html: '<h1>cms-built</h1>',
      css: '.a{}',
      js: 'void 0',
    })
    // htmlPage wins over the alias when both are present.
    const both = {
      id: 'page-5',
      data: {
        htmlPage: { code: { html: '<h1>htmlPage</h1>' } },
        webpageContentWithBuilder: { code: { html: '<h1>builder</h1>' } },
      },
    }
    expect(getPageCode(both)).toEqual({ html: '<h1>htmlPage</h1>' })
    // Malformed alias still yields undefined.
    expect(
      getPageCode({ id: 'x', data: { webpageContentWithBuilder: { code: { css: 'x' } } } }),
    ).toBeUndefined()
  })

  it('publish gate: meta.status disabled hides, absent/empty/other = published (D-WFLOW-28)', () => {
    expect(getPageStatus(undefined)).toBe('published')
    expect(getPageStatus({})).toBe('published')
    expect(getPageStatus({ meta: { status: 'disabled' } })).toBe('disabled')
    expect(getPageStatus({ meta: { status: '' } })).toBe('published')
    expect(getPageStatus({ meta: { status: 'enabled' } })).toBe('enabled')
    expect(isPublishedPage({ meta: { status: 'disabled' } })).toBe(false)
    expect(isPublishedPage({ meta: { status: 'enabled' } })).toBe(true)
    expect(isPublishedPage(undefined)).toBe(true)
    // The retired data-section status key is never read.
    expect(isPublishedPage({ data: { status: 'draft' } })).toBe(true)
  })
})

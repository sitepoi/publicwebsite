import { describe, expect, it } from 'vitest'
import { DataQueryRequestSchema, DataQueryResultSchema } from '@/lib/contracts/data-query'

/** The READ (get) payload example from Section 29 — parsed EXACTLY. */
const section29Query = {
  cmsObjectType: 'menu-items',
  folder: 'site-a',
  filters: [{ field: 'price', op: '>=', value: 10 }],
  search: 'pizza',
  orderBy: 'price',
  orderDir: 'asc',
  page: 1,
  pageSize: 24,
  language: 'en',
  relations: [{ field: 'categoryId', targetType: 'categories', targetField: 'id' }],
  facets: ['categoryId'],
}

describe('DataQueryRequestSchema (Section 29 — get fabric)', () => {
  it('parses the Section 29 query example exactly', () => {
    const parsed = DataQueryRequestSchema.parse(section29Query)
    expect(parsed.cmsObjectType).toBe('menu-items')
    expect(parsed.filters?.[0]).toEqual({ field: 'price', op: '>=', value: 10 })
    expect(parsed.relations?.[0]?.targetField).toBe('id')
    expect(parsed.facets).toEqual(['categoryId'])
    expect(parsed.page).toBe(1)
    expect(parsed.pageSize).toBe(24)
  })

  it('is strict: unknown keys are rejected (platform-controlled API)', () => {
    const result = DataQueryRequestSchema.safeParse({ ...section29Query, evil: true })
    expect(result.success).toBe(false)
  })

  it('rejects unknown filter operators', () => {
    const result = DataQueryRequestSchema.safeParse({
      cmsObjectType: 'x',
      filters: [{ field: 'a', op: '<>', value: 1 }],
    })
    expect(result.success).toBe(false)
  })

  it('optional fields may be omitted (defaults live in lib/data/common)', () => {
    expect(DataQueryRequestSchema.parse({ cmsObjectType: 'x' }).filters).toBeUndefined()
  })
})

describe('DataQueryResultSchema (Section 29 — response)', () => {
  it('parses a query result', () => {
    const parsed = DataQueryResultSchema.parse({
      items: [{ id: 'o1', name: 'Margherita' }],
      total: 1,
      page: 1,
      pageSize: 24,
      facets: { categoryId: { c1: 1 } },
      relations: { categoryId: [{ id: 'c1', name: 'Pizza' }] },
    })
    expect(parsed.items[0]?.id).toBe('o1')
    expect(parsed.facets.categoryId?.c1).toBe(1)
    expect(parsed.relations.categoryId).toHaveLength(1)
  })
})

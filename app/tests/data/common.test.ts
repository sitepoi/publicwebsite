import { describe, expect, it } from 'vitest'
import { interpretQuery, withQueryDefaults } from '@/lib/data/common'
import { applyFilters, matchesFilter, readField, sortItems } from '@/lib/data/common/filters'
import { searchItems } from '@/lib/data/common/search'
import { computeFacets } from '@/lib/data/common/facets'
import type { ObjectRecord } from '@/lib/contracts/objects'

const items: ObjectRecord[] = [
  { id: 'o1', name: 'Margherita', price: 9, categoryId: 'c1', tags: ['classic', 'veg'] },
  { id: 'o2', name: 'Pepperoni', price: 12, categoryId: 'c1', tags: ['classic'] },
  { id: 'o3', name: 'Quattro Formaggi', price: 14, categoryId: 'c2', tags: ['cheese'] },
  { id: 'o4', name: 'Salad', price: 6, categoryId: 'c2', tags: ['veg', 'light'] },
]

describe('lib/data/common (Section 6B shared interpreter)', () => {
  it('withQueryDefaults fills the Section 29 defaults', () => {
    const resolved = withQueryDefaults({ cmsObjectType: 'menu-items' })
    expect(resolved.filters).toEqual([])
    expect(resolved.orderDir).toBe('asc')
    expect(resolved.page).toBe(1)
    expect(resolved.pageSize).toBe(24)
    expect(resolved.relations).toEqual([])
    expect(resolved.facets).toEqual([])
  })

  it('readField reads top-level and dotted fields', () => {
    expect(readField(items[0]!, 'price')).toBe(9)
    expect(readField({ id: 'x', a: { b: 'deep' } }, 'a.b')).toBe('deep')
    expect(readField({ id: 'x' }, 'missing')).toBeUndefined()
  })

  it('matchesFilter supports the Section 29 operators', () => {
    expect(matchesFilter(items[1]!, { field: 'price', op: '>=', value: 10 })).toBe(true)
    expect(matchesFilter(items[0]!, { field: 'price', op: '>=', value: 10 })).toBe(false)
    expect(matchesFilter(items[0]!, { field: 'name', op: 'contains', value: 'gher' })).toBe(true)
    expect(matchesFilter(items[0]!, { field: 'categoryId', op: 'in', value: ['c2', 'c9'] })).toBe(
      false,
    )
    expect(matchesFilter(items[2]!, { field: 'categoryId', op: 'in', value: ['c2', 'c9'] })).toBe(
      true,
    )
    expect(matchesFilter(items[0]!, { field: 'price', op: '==', value: '9' })).toBe(true)
    expect(matchesFilter(items[0]!, { field: 'price', op: '!=', value: 9 })).toBe(false)
  })

  it('applyFilters ANDs all filters', () => {
    const result = applyFilters(items, [
      { field: 'price', op: '>=', value: 10 },
      { field: 'name', op: 'contains', value: 'o' },
    ])
    expect(result.map((record) => record.id)).toEqual(['o2', 'o3'])
  })

  it('searchItems matches case-insensitively on string fields', () => {
    expect(searchItems(items, 'FORMAGGI').map((record) => record.id)).toEqual(['o3'])
  })

  it('computeFacets buckets values, arrays per element', () => {
    const facets = computeFacets(items, ['categoryId', 'tags'])
    expect(facets.categoryId).toEqual({ c1: 2, c2: 2 })
    expect(facets.tags?.['classic']).toBe(2)
    expect(facets.tags?.['veg']).toBe(2)
  })

  it('sortItems orders by field, direction aware', () => {
    expect(sortItems(items, 'price', 'asc')[0]?.id).toBe('o4')
    expect(sortItems(items, 'price', 'desc')[0]?.id).toBe('o3')
  })

  it('interpretQuery runs the full pipeline: filter → search → facets → sort → page', async () => {
    const result = await interpretQuery({
      items,
      query: {
        cmsObjectType: 'menu-items',
        filters: [{ field: 'price', op: '>=', value: 6 }],
        orderBy: 'price',
        orderDir: 'desc',
        page: 2,
        pageSize: 2,
        facets: ['categoryId'],
      },
    })
    expect(result.items.map((record) => record.id)).toEqual(['o1', 'o4'])
    expect(result.total).toBe(4)
    expect(result.page).toBe(2)
    expect(result.facets.categoryId).toEqual({ c1: 2, c2: 2 })
  })

  it('interpretQuery resolves relations via a loader, keyed by field', async () => {
    const categories: ObjectRecord[] = [
      { id: 'c1', name: 'Classic' },
      { id: 'c2', name: 'Cheese' },
    ]
    const result = await interpretQuery({
      items,
      query: {
        cmsObjectType: 'menu-items',
        pageSize: 2,
        relations: [{ field: 'categoryId', targetType: 'categories', targetField: 'id' }],
      },
      loadRelated: async (targetType, ids) => {
        expect(targetType).toBe('categories')
        expect(ids).toEqual(['c1'])
        return categories.filter((category) => ids.includes(category.id))
      },
    })
    expect(result.relations.categoryId?.map((record) => record.id)).toEqual(['c1'])
  })
})

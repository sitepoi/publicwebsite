import type { DataQueryRequest, DataQueryResult, DataRelation } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import { applyFilters, sortItems } from './filters'
import { searchItems } from './search'
import { computeFacets } from './facets'
import { resolveRelations, type RelatedLoader } from './relations'

/**
 * Shared query interpreter (Section 6B — lib/data/common/).
 *
 * The provider-neutral query pipeline used by BOTH adapters (Firestore now,
 * Supabase later): filters → search → facets → sort → paginate → relations.
 * Adapters are responsible for fetching a candidate item set and (optionally)
 * delegating tail work here.
 */

export const DEFAULT_PAGE = 1
export const DEFAULT_PAGE_SIZE = 24
export const MAX_PAGE_SIZE = 200

export interface ResolvedDataQuery {
  cmsObjectType: string
  folder?: string
  filters: NonNullable<DataQueryRequest['filters']>
  search?: string
  orderBy?: string
  orderDir: 'asc' | 'desc'
  page: number
  pageSize: number
  language?: string
  relations: NonNullable<DataQueryRequest['relations']>
  facets: NonNullable<DataQueryRequest['facets']>
}

export function withQueryDefaults(query: DataQueryRequest): ResolvedDataQuery {
  return {
    ...query,
    filters: query.filters ?? [],
    orderDir: query.orderDir ?? 'asc',
    page: query.page ?? DEFAULT_PAGE,
    pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
    relations: query.relations ?? [],
    facets: query.facets ?? [],
  }
}

export interface InterpretQueryOptions {
  items: ObjectRecord[]
  query: DataQueryRequest
  loadRelated?: RelatedLoader
}

/**
 * Pure in-memory interpretation of a Section 29 query over candidate items.
 * Facets are computed over the FULL filtered set (not just the current page);
 * relations resolve against the current page's foreign ids.
 */
export async function interpretQuery({
  items,
  query,
  loadRelated,
}: InterpretQueryOptions): Promise<DataQueryResult> {
  const resolved = withQueryDefaults(query)

  let filtered = applyFilters(items, resolved.filters)
  if (resolved.search !== undefined) filtered = searchItems(filtered, resolved.search)

  const facets = computeFacets(filtered, resolved.facets)

  if (resolved.orderBy !== undefined) {
    filtered = sortItems(filtered, resolved.orderBy, resolved.orderDir)
  }

  const total = filtered.length
  const start = (resolved.page - 1) * resolved.pageSize
  const pageItems = filtered.slice(start, start + resolved.pageSize)

  const relations = loadRelated
    ? await resolveRelations(pageItems, resolved.relations, loadRelated)
    : {}

  return {
    items: pageItems,
    total,
    page: resolved.page,
    pageSize: resolved.pageSize,
    facets,
    relations,
  }
}

export type { DataRelation }

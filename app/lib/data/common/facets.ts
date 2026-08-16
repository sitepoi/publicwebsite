import type { ObjectRecord } from '@/lib/contracts/objects'
import { readField } from './filters'

/**
 * Shared facet interpreter (Section 6B — lib/data/common/).
 *
 * Buckets values per requested field: scalars become their string form,
 * arrays contribute one bucket per element, objects serialize as JSON.
 * `undefined`/`null` bucket as '(none)'.
 */
export type FacetBuckets = Record<string, Record<string, number>>

export function computeFacets(items: ObjectRecord[], fields: string[]): FacetBuckets {
  const result: FacetBuckets = {}
  for (const field of fields) {
    const buckets: Record<string, number> = {}
    for (const item of items) {
      for (const part of toBucketParts(readField(item, field))) {
        buckets[part] = (buckets[part] ?? 0) + 1
      }
    }
    result[field] = buckets
  }
  return result
}

function toBucketParts(value: unknown): string[] {
  if (value === undefined || value === null) return ['(none)']
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => toBucketParts(entry))
    return parts.length > 0 ? parts : ['(none)']
  }
  if (typeof value === 'object') return [JSON.stringify(value)]
  return [String(value)]
}

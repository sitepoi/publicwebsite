import type { DataRelation } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import { readField } from './filters'

/**
 * Shared relation interpreter (Section 6B — lib/data/common/).
 *
 * `field` on each item holds the foreign id(s); the loader fetches the target
 * objects (provider-specific), and results are keyed by request field in the
 * response `relations` map.
 */
export type RelatedLoader = (targetType: string, ids: string[]) => Promise<ObjectRecord[]>

export async function resolveRelations(
  items: ObjectRecord[],
  relations: DataRelation[],
  loadRelated: RelatedLoader,
): Promise<Record<string, ObjectRecord[]>> {
  const result: Record<string, ObjectRecord[]> = {}

  for (const relation of relations) {
    const ids = new Set<string>()
    for (const item of items) {
      const raw = readField(item, relation.field)
      if (typeof raw === 'string') ids.add(raw)
      else if (Array.isArray(raw)) {
        for (const entry of raw) if (typeof entry === 'string') ids.add(entry)
      }
    }

    const related = await loadRelated(relation.targetType, [...ids])
    const targetField = relation.targetField ?? 'id'
    result[relation.field] = related.filter((record) => {
      const key = readField(record, targetField)
      return typeof key === 'string' && ids.has(key)
    })
  }

  return result
}

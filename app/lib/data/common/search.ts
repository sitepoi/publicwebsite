import Fuse from 'fuse.js'
import type { ObjectRecord } from '@/lib/contracts/objects'

/**
 * Shared search interpreter (Section 6B — lib/data/common/).
 *
 * Fuse.js ranked search over the record's scalar fields (Section 15 / C7).
 * Empty query returns items unchanged. Provider-agnostic — both adapters
 * and the query route use this.
 */
export function searchItems(items: ObjectRecord[], query: string): ObjectRecord[] {
  const needle = query.trim()
  if (needle.length === 0 || items.length === 0) return items

  const keys = Object.keys(items[0] ?? {}).filter((key) => key !== 'id')
  const fuse = new Fuse(items, { keys, threshold: 0.4, ignoreLocation: true })
  return fuse.search(needle).map((result) => result.item)
}

import type { DataFilter } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'

/**
 * Shared filter interpreter (Section 6B — lib/data/common/).
 *
 * Provider-neutral: adapters hand in provider-neutral ObjectRecords and this
 * module does the interpretation. Supports dotted field paths (`a.b`).
 */

export function readField(record: ObjectRecord, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, record)
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a === 'object' || typeof b === 'object') return false
  return String(a) === String(b)
}

function compareValues(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (
    (typeof a === 'number' || typeof a === 'string') &&
    (typeof b === 'number' || typeof b === 'string')
  ) {
    const an = Number(a)
    const bn = Number(b)
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an < bn ? -1 : an > bn ? 1 : 0
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
  }
  return null
}

export function matchesFilter(record: ObjectRecord, filter: DataFilter): boolean {
  const actual = readField(record, filter.field)
  const { op, value } = filter

  switch (op) {
    case '==':
      return isEqual(actual, value)
    case '!=':
      return !isEqual(actual, value)
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const cmp = compareValues(actual, value)
      if (cmp === null) return false
      if (op === '>') return cmp > 0
      if (op === '>=') return cmp >= 0
      if (op === '<') return cmp < 0
      return cmp <= 0
    }
    case 'in':
      return Array.isArray(value) && value.some((entry) => isEqual(actual, entry))
    case 'contains':
      return typeof actual === 'string' && actual.includes(String(value))
  }
}

export function applyFilters(items: ObjectRecord[], filters: DataFilter[]): ObjectRecord[] {
  if (filters.length === 0) return items
  return items.filter((record) => filters.every((filter) => matchesFilter(record, filter)))
}

/** Sorts a COPY; records without the field sort last. */
export function sortItems(
  items: ObjectRecord[],
  field: string,
  direction: 'asc' | 'desc',
): ObjectRecord[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    const cmp = compareValues(readField(a, field), readField(b, field))
    if (cmp === null) return 1 // missing values last, regardless of direction
    return cmp * multiplier
  })
}

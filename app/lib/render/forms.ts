import type { DataProvider } from '@/lib/data/provider'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteConfig } from '@/lib/resolver/site'
import type { FormTypeConfig } from '@/lib/contracts/forms'
import { getObjectData } from './normalize'

/**
 * Server-side form logic (Section 14 / 2B forms row).
 *
 * destinationTable + afterSaveApiHooks come ONLY from the server-side
 * form-type config — never from the client (hard rule). The record shape is
 * saveForm-compatible so Uniconhub admin views keep working.
 */

export const FORM_TYPE_SLUG = 'form-type-definition'

export interface FormTypeLookupResult {
  config: FormTypeConfig | null
  queried: boolean
}

/** Find the form-type definition for a formTypeId (tolerant matching). */
export async function loadFormTypeConfig(
  provider: DataProvider,
  site: SiteConfig,
  formTypeId: string,
): Promise<FormTypeConfig | null> {
  const result = await provider.queryObjects({ cmsObjectType: 'system-items', pageSize: 200 })
  const candidates = result.items.filter((record) => {
    const data = getObjectData(record)
    return record.meta?.['slug'] === FORM_TYPE_SLUG || data?.['type'] === 'json'
  })

  const match = candidates.find((record) => {
    const data = getObjectData(record) ?? {}
    return (
      data['formTypeId'] === formTypeId ||
      record.id === formTypeId ||
      record.contentId === formTypeId
    )
  })
  if (!match) return null

  const data = getObjectData(match) ?? {}
  const destinationTable =
    typeof data['destinationTable'] === 'string' && data['destinationTable'].length > 0
      ? data['destinationTable']
      : undefined

  const hooksRaw = data['afterSaveApiHooks']
  const afterSaveApiHooks = Array.isArray(hooksRaw)
    ? hooksRaw
        .map((hook) => {
          if (typeof hook === 'string') return hook
          if (hook !== null && typeof hook === 'object') {
            const url = (hook as Record<string, unknown>)['url']
            return typeof url === 'string' ? url : null
          }
          return null
        })
        .filter((url): url is string => url !== null && url.length > 0)
    : []

  return { destinationTable, afterSaveApiHooks }
}

export interface SaveFormRecordOptions {
  docId: string
  formTypeId?: string
  values: Record<string, string>
  now: Date
}

/** saveForm-compatible record (Section 14): formKeyValues/name/formType/... */
export function buildSaveFormRecord(options: SaveFormRecordOptions): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: options.docId,
    docId: options.docId,
    name: options.values['name'] ?? options.values['fullName'] ?? '',
    formType: options.formTypeId ?? '',
    formKeyValues: options.values,
    serverTimeStamp: options.now.toISOString(),
    date_str: options.now.toISOString().slice(0, 10),
  }
  return record
}

/** users destination special case (Section 14): roles ['customer']. */
export function applyUserDestination(
  record: Record<string, unknown>,
  destinationTable: string,
): Record<string, unknown> {
  if (destinationTable.toLowerCase() === 'users') {
    return { ...record, roles: ['customer'] }
  }
  return record
}

export { type ObjectRecord }

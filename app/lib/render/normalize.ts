/**
 * Data-field normalization (Sections 6 / 8 — decision 2026-08-14).
 *
 * The object data part is read as `data` first, falling back to the legacy
 * `productData.data_categoriesBased` — the ONLY backward compatibility in
 * NEXT-GEN (CMS-side naming only; new writes use `data`).
 */
import { HtmlPageCodeSchema, type HtmlPageCode } from '@/lib/contracts/page-object'

/** The normalized page data section (whatever field name carried it). */
export type NormalizedObjectData = Record<string, unknown>

export interface NormalizableObjectData {
  data?: unknown
  productData?: {
    data_categoriesBased?: unknown
  } & Record<string, unknown>
  [key: string]: unknown
}

export function getObjectData(record: NormalizableObjectData): NormalizedObjectData | undefined {
  if (record.data !== undefined && record.data !== null) {
    return record.data as NormalizedObjectData
  }
  const legacy = record.productData?.data_categoriesBased
  if (legacy !== undefined && legacy !== null) return legacy as NormalizedObjectData
  return undefined
}

/**
 * Page content from the normalized data section: `htmlPage.code.{html,css,js}`
 * (Section 8 — `htmlPage` is the FIXED html-tool field name, CSS/JS separate
 * fields). Returns undefined when absent or malformed.
 */
export function getPageCode(record: NormalizableObjectData): HtmlPageCode | undefined {
  const data = getObjectData(record)
  if (!data) return undefined

  const htmlPage = data['htmlPage']
  if (htmlPage === null || typeof htmlPage !== 'object') return undefined

  const code = (htmlPage as Record<string, unknown>)['code']
  const parsed = HtmlPageCodeSchema.safeParse(code)
  return parsed.success ? parsed.data : undefined
}

export const PAGE_STATUS_PUBLISHED = 'published'

/** Section 8 / Q9: optional `status` data field; absent = published. */
export function getPageStatus(data: NormalizedObjectData | undefined): string {
  const status = data?.['status']
  return typeof status === 'string' && status.length > 0 ? status : PAGE_STATUS_PUBLISHED
}

/** Drafts (`status` ≠ published) are visible only in preview (Q9). */
export function isPublishedPage(data: NormalizedObjectData | undefined): boolean {
  return getPageStatus(data) === PAGE_STATUS_PUBLISHED
}

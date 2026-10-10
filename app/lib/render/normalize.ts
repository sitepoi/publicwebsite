/**
 * Data-field normalization (Sections 6 / 8 — decision 2026-08-14).
 *
 * The object data part is read as `data` first, falling back to the legacy
 * `productData.data_categoriesBased` — the ONLY backward compatibility in
 * NEXT-GEN (CMS-side naming only; new writes use `data`).
 */
import {
  HtmlPageCodeSchema,
  PageSectionRefSchema,
  type HtmlPageCode,
  type PageSectionRef,
} from '@/lib/contracts/page-object'

/** C14 hard cap on data.sections entries per page. */
export const MAX_PAGE_SECTIONS = 20

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

function extractPageCode(container: unknown): HtmlPageCode | undefined {
  if (container === null || typeof container !== 'object') return undefined
  const code = (container as Record<string, unknown>)['code']
  const parsed = HtmlPageCodeSchema.safeParse(code)
  return parsed.success ? parsed.data : undefined
}

/**
 * Page content from the normalized data section: `htmlPage.code.{html,css,js}`
 * (Section 8 — `htmlPage` is the FIXED html-tool field name, CSS/JS separate
 * fields). Legacy CMS pages store the same code under
 * `webpageContentWithBuilder.code` (the CMS's AI builder category) — accepted
 * as an alias when `htmlPage` is absent (D-DWH-21, Section 6.11 compat).
 * Returns undefined when absent or malformed.
 */
export function getPageCode(record: NormalizableObjectData): HtmlPageCode | undefined {
  const data = getObjectData(record)
  if (!data) return undefined
  return extractPageCode(data['htmlPage']) ?? extractPageCode(data['webpageContentWithBuilder'])
}

/**
 * The CMS AI-builder section (`webpageContentWithBuilder`) of the normalized
 * data section — the PRIMARY source for page code, SEO and meta on CMS-built
 * pages (D-DWH-23).
 */
export function getBuilderSection(
  record: NormalizableObjectData,
): Record<string, unknown> | undefined {
  const data = getObjectData(record)
  if (!data) return undefined
  const section = data['webpageContentWithBuilder']
  return section !== null && typeof section === 'object' && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : undefined
}

export const PAGE_STATUS_PUBLISHED = 'published'

/**
 * Publish gate (D-WFLOW-28): the object shell `meta.status` is the ONLY
 * publish flag. Disabled ONLY when it is exactly 'disabled'; absent, empty
 * or any other value = published. The retired data-section `status` key is
 * never read.
 */
export function getPageStatus(record: NormalizableObjectData | undefined): string {
  if (record === undefined || record === null) return PAGE_STATUS_PUBLISHED
  const meta = record['meta']
  const status =
    meta !== null && typeof meta === 'object'
      ? (meta as Record<string, unknown>)['status']
      : undefined
  return typeof status === 'string' && status.trim().length > 0
    ? status
    : PAGE_STATUS_PUBLISHED
}

/** Drafts (`meta.status === 'disabled'`) are visible only in preview (D-WFLOW-28). */
export function isPublishedPage(record: NormalizableObjectData | undefined): boolean {
  return getPageStatus(record) !== 'disabled'
}

/**
 * C14 reusable sections: read `data.sections` refs in order, capped at
 * MAX_PAGE_SECTIONS. Malformed entries are skipped; sections found INSIDE
 * section objects are never read here — the resolver only ever reads the
 * PAGE's own sections (flat composition, structural depth guard).
 */
export function getPageSections(record: NormalizableObjectData): PageSectionRef[] {
  const data = getObjectData(record)
  if (!data) return []
  const raw = data['sections']
  if (!Array.isArray(raw)) return []

  return raw.slice(0, MAX_PAGE_SECTIONS).flatMap((entry) => {
    const parsed = PageSectionRefSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

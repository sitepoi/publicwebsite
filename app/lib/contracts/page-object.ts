import { z } from 'zod'
import { SeoSectionSchema, type SeoSection } from './seo'

/**
 * Page object contract (Section 8 — REAL schema, recorded 2026-08-15).
 *
 * Pages are objects in the website folder. Content comes from the data part:
 * `htmlPage.code.{html,css,js}` — `htmlPage` is the FIXED field name of the
 * html-tool inside the CMS form (no legacy aliases). CSS/JS are separate
 * fields; no style/script hoisting from HTML is required (embedded
 * <style>/<script> inside html stays tolerated).
 *
 * Normalization (Section 6 / 8): the platform reads `data` first and falls
 * back to `productData.data_categoriesBased` — see lib/render/normalize.ts.
 *
 * Routing (Q12): URL slug = object-level `slug`; language = `meta.language`;
 * home = object with slug 'home-page' (per language); optional `status` data
 * field for publish/draft (absent = published); NO category field — schema
 * type comes from `seo.schemaItems` / `aiEntityType`.
 */
export const HtmlPageCodeSchema = z.object({
  html: z.string(),
  css: z.string().optional(),
  js: z.string().optional(),
})

export type HtmlPageCode = z.infer<typeof HtmlPageCodeSchema>

export const HtmlPageHistoryEntrySchema = z
  .object({
    version: z.string().optional(),
    time: z.string().optional(),
    label: z.string().optional(),
    html: z.string().optional(),
    css: z.string().optional(),
    js: z.string().optional(),
  })
  .catchall(z.unknown())

export type HtmlPageHistoryEntry = z.infer<typeof HtmlPageHistoryEntrySchema>

export const HtmlPageSchema = z
  .object({
    code: HtmlPageCodeSchema,
    history: z.array(HtmlPageHistoryEntrySchema).optional(),
    version: z.string().optional(),
    activeSessionId: z.string().optional(),
    _instanceId: z.string().optional(),
    _parentRecordId: z.string().optional(),
  })
  .catchall(z.unknown())

export type HtmlPage = z.infer<typeof HtmlPageSchema>

/**
 * C14 reusable sections: a reference to another object whose own
 * htmlPage.code.{html,css,js} is composed into the page IN ORDER, before the
 * page's own code. FLAT only — sections inside sections are never expanded
 * (the depth guard is structural, see lib/render/render-plan.ts).
 */
export const PageSectionRefSchema = z.object({
  cmsObjectType: z.string(),
  objectId: z.string(),
})

export type PageSectionRef = z.infer<typeof PageSectionRefSchema>

/**
 * The object data section (new name `data`, legacy
 * `productData.data_categoriesBased`). Only fields the platform consumes are
 * typed; everything else passes through (catchall).
 */
export const PageDataSchema = z
  .object({
    htmlPage: HtmlPageSchema.optional(),
    status: z.string().optional(),
    requireAuth: z.boolean().optional(),
    sections: z.array(PageSectionRefSchema).optional(),
  })
  .catchall(z.unknown())

export type PageData = z.infer<typeof PageDataSchema>

export const PageObjectSchema = z
  .object({
    schemaVersion: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
    meta: z
      .object({
        language: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    data: PageDataSchema.optional(),
    productData: z
      .object({
        data_categoriesBased: PageDataSchema.optional(),
      })
      .catchall(z.unknown())
      .optional(),
    seo: SeoSectionSchema.optional(),
    blocks: z.array(z.unknown()).optional(),
    source: z
      .object({
        tenantId: z.string().optional(),
        cmsObjectType: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown())

export type PageObject = z.infer<typeof PageObjectSchema>

export type PageObjectSeo = SeoSection

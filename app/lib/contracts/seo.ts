import { z } from 'zod'

/**
 * Fixed object SEO section (Section 8 — recorded 2026-08-15).
 *
 * This is the REAL, fixed schema of the object SEO section. NEXT-GEN reuses it
 * as-is; all fields are optional because the CMS leaves them empty when unused.
 */
export const SeoSchemaItemSchema = z
  .object({
    id: z.string().optional(),
    type: z.string().optional(),
    json: z.string().optional(),
  })
  .catchall(z.unknown())

export type SeoSchemaItem = z.infer<typeof SeoSchemaItemSchema>

export const SeoSectionSchema = z
  .object({
    schemaItems: z.array(SeoSchemaItemSchema).optional(),
    metaTitle: z.string().optional(),
    metaDesc: z.string().optional(),
    metaImage: z.string().optional(),
    canonicalUrl: z.string().optional(),
    metaRobots: z.string().optional(),
    metaAuthor: z.string().optional(),
    metaKeywords: z.string().optional(),
    ogTitle: z.string().optional(),
    ogType: z.string().optional(),
    ogDesc: z.string().optional(),
    ogImage: z.string().optional(),
    ogUrl: z.string().optional(),
    twitterCard: z.string().optional(),
    twitterSite: z.string().optional(),
    twitterTitle: z.string().optional(),
    twitterCreator: z.string().optional(),
    twitterImage: z.string().optional(),
    aiDescription: z.string().optional(),
    aiEntityType: z.string().optional(),
    aiIntent: z.string().optional(),
    aiKeyTopics: z.string().optional(),
    aiAudience: z.string().optional(),
    sitemapPriority: z.string().optional(),
    sitemapChangefreq: z.string().optional(),
  })
  .catchall(z.unknown())

export type SeoSection = z.infer<typeof SeoSectionSchema>

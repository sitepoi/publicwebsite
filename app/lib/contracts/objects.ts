import { z } from 'zod'

/**
 * Generic Uniconhub object record (Section 6).
 *
 * Collection naming stays admin-compatible: `om_objects` / `om_private_objects`
 * (+ table extension), `om_object_types`, `settings` — NEXT-GEN only READS
 * differently, it never rewrites the model.
 *
 * Object schema preserved: `id/_id, contentId, slug, name, cmsObjectType, typeId,
 * data, blocks[], meta.language, permissions, created, lastUpdated`.
 *
 * Parsing is deliberately tolerant (all fields except `id` optional + catchall):
 * objects authored by the Uniconhub admin must parse exactly as-is.
 */
export const ObjectRecordSchema = z
  .object({
    id: z.string(),
    schemaVersion: z.string().optional(),
    _id: z.string().optional(),
    contentId: z.string().optional(),
    slug: z.string().optional(),
    name: z.string().optional(),
    cmsObjectType: z.string().optional(),
    typeId: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    productData: z.record(z.string(), z.unknown()).optional(),
    blocks: z.array(z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    permissions: z.unknown().optional(),
    rules: z.record(z.string(), z.unknown()).optional(),
    seo: z.record(z.string(), z.unknown()).optional(),
    source: z.record(z.string(), z.unknown()).optional(),
    created: z.unknown().optional(),
    lastUpdated: z.unknown().optional(),
  })
  .catchall(z.unknown())

export type ObjectRecord = z.infer<typeof ObjectRecordSchema>

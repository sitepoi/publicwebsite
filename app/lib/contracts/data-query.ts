import { z } from 'zod'
import { ObjectRecordSchema, type ObjectRecord } from './objects'

/**
 * Data access API contract (Section 29) — the generic GET fabric between
 * embedded tools and the CMS/Firestore.
 *
 * Request payload is STRICT: it is a platform-controlled API, exactly the keys
 * listed in Section 29. Reads are generic and cached; writes go through
 * VALIDATED operations (contracts/operations.ts) — never raw client writes.
 */
export const DataFilterOpSchema = z.enum(['==', '!=', '>', '>=', '<', '<=', 'in', 'contains'])

export type DataFilterOp = z.infer<typeof DataFilterOpSchema>

export const DataFilterSchema = z.object({
  field: z.string().min(1),
  op: DataFilterOpSchema,
  value: z.unknown(),
})

export type DataFilter = z.infer<typeof DataFilterSchema>

export const DataRelationSchema = z.object({
  field: z.string().min(1),
  targetType: z.string().min(1),
  targetField: z.string().optional(),
})

export type DataRelation = z.infer<typeof DataRelationSchema>

export const DataQueryRequestSchema = z
  .object({
    cmsObjectType: z.string().min(1),
    folder: z.string().optional(),
    filters: z.array(DataFilterSchema).optional(),
    search: z.string().optional(),
    orderBy: z.string().optional(),
    orderDir: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(200).optional(),
    language: z.string().optional(),
    relations: z.array(DataRelationSchema).optional(),
    facets: z.array(z.string()).optional(),
  })
  .strict()

export type DataQueryRequest = z.infer<typeof DataQueryRequestSchema>

export const DataQueryResultSchema = z.object({
  items: z.array(ObjectRecordSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  facets: z.record(z.string(), z.record(z.string(), z.number().int())),
  relations: z.record(z.string(), z.array(ObjectRecordSchema)),
})

export type DataQueryResult = z.infer<typeof DataQueryResultSchema>

export type { ObjectRecord }

import { z } from 'zod'

/**
 * Form submit payload contract (Section 14) — the server-side shape both the
 * JSON and multipart client paths normalize into. STRICT: clients can never
 * smuggle destinationTable/hooks (server-only, ADR-006).
 */
export const FormSubmitValuesSchema = z.record(z.string(), z.string())

export const FormSubmitPayloadSchema = z
  .object({
    formTypeId: z.string().optional(),
    submittedAt: z.number().int().positive(),
    gw_hp: z.string().default(''),
    values: FormSubmitValuesSchema,
  })
  .strict()

export type FormSubmitPayload = z.infer<typeof FormSubmitPayloadSchema>

/** Server-side form-type config (never client-supplied). */
export interface FormTypeConfig {
  destinationTable?: string
  afterSaveApiHooks: string[]
}

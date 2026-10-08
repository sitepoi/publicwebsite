import { z } from 'zod'

/**
 * Tenant creation request contract (SSOT D-DWH section 8 step 1, T-11).
 *
 * Mirrors the legacy tenant creation inputs (tenantId, adminEmail,
 * adminPassword, appsToActivate) plus the new public website inputs from the
 * SSOT: explicit domain(s), primary host, default language, preview secret,
 * currency and app ids. `gw_hp` is the honeypot field (silent drop).
 *
 * Validation rules match the legacy flow: tenantId = 4-20 lowercase letters
 * and digits; admin password at least 8 characters.
 */
export const TENANT_ID_PATTERN = /^[a-z0-9]{4,20}$/

export const TenantCreationRequestSchema = z
  .object({
    tenantId: z.string().min(1),
    adminEmail: z.string().email(),
    adminPassword: z.string().min(8),
    hostNames: z.array(z.string().min(1).max(253)).min(1).max(20),
    primaryHost: z.string().min(1).max(253).optional(),
    defaultLanguage: z.string().min(2).max(5).optional(),
    previewSecret: z.string().min(1).optional(),
    currency: z.string().length(3).optional(),
    appIds: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    gw_hp: z.string().optional(),
  })
  .superRefine((value, context) => {
    const normalizedTenantId = value.tenantId.trim().toLowerCase()
    if (!TENANT_ID_PATTERN.test(normalizedTenantId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tenantId'],
        message: 'Company ID must be 4-20 lowercase letters and numbers.',
      })
    }
  })

export type TenantCreationRequest = z.infer<typeof TenantCreationRequestSchema>

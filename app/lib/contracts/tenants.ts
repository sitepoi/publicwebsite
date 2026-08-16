import { z } from 'zod'

/**
 * Tenant configuration contract (Section 6B + Section 6).
 *
 * Hostname → tenant resolution is done by lib/resolver/tenant.ts (C2, like the
 * legacy relay/ras config). The per-tenant database backend choice is part of
 * this config: `databaseProvider: 'firestore' | 'supabase'`.
 *
 * Secrets stay env-only (Section 19 / 22): connections reference ENV VAR
 * NAMES, never raw credentials. Per-tenant env convention (Section 22):
 *
 *   <PROJECTID_WITH_UNDERSCORES>_firebase_admin_{project_id,private_key,client_email}
 *   <TENANT>_STRIPE_{SECRET,WEBHOOK_SECRET,PUBLISHABLE}
 */
export const DatabaseProviderSchema = z.enum(['firestore', 'supabase'])

export type DatabaseProvider = z.infer<typeof DatabaseProviderSchema>

export const FirebaseTenantConnectionSchema = z
  .object({
    projectId: z.string().min(1),
    clientEmailEnv: z.string().optional(),
    privateKeyEnv: z.string().optional(),
  })
  .catchall(z.unknown())

export type FirebaseTenantConnection = z.infer<typeof FirebaseTenantConnectionSchema>

export const SupabaseTenantConnectionSchema = z
  .object({
    url: z.string().optional(),
    serviceRoleKeyEnv: z.string().optional(),
  })
  .catchall(z.unknown())

export type SupabaseTenantConnection = z.infer<typeof SupabaseTenantConnectionSchema>

export const TenantConfigSchema = z
  .object({
    schemaVersion: z.string().optional(),
    tenantId: z.string().min(1),
    databaseProvider: DatabaseProviderSchema,
    tableExtension: z.string().optional(),
    parentTenants: z.array(z.string()).optional(),
    firebase: FirebaseTenantConnectionSchema.optional(),
    supabase: SupabaseTenantConnectionSchema.optional(),
    // Q12: the website app id is NOT hardcoded — tenant-configurable default;
    // plan default is website-builder-uniconbaseapps (see app-config.ts).
    defaultAppId: z.string().optional(),
  })
  .catchall(z.unknown())

export type TenantConfig = z.infer<typeof TenantConfigSchema>

import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'

/**
 * SupabaseProvider — designed-in, implemented later (Section 6B).
 *
 * The Postgres tables will mirror the same logical records (objects,
 * object_types, settings); Supabase Realtime replaces Firestore listeners;
 * Supabase Storage replaces Firebase Storage. This adapter will be developed
 * against the SAME DataProvider contract and will share only
 * lib/data/common/ with the Firestore adapter — never Firestore code.
 */
export function createSupabaseProvider(tenant: TenantConfig): DataProvider {
  throw new Error(
    `Supabase provider is designed-in (Section 6B) but not yet implemented — ` +
      `tenant '${tenant.tenantId}' requests databaseProvider 'supabase'`,
  )
}

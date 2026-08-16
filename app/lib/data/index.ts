import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { createFirestoreProvider } from './providers/firestore'
import { createSupabaseProvider } from './providers/supabase'

/**
 * Per-tenant provider factory (Section 6B).
 *
 * A per-tenant backend switch is a tenant-config change
 * (`databaseProvider: 'firestore' | 'supabase'`) — app logic and the other
 * provider's adapter are never touched.
 */
export function getProviderForTenant(tenant: TenantConfig): DataProvider {
  switch (tenant.databaseProvider) {
    case 'firestore':
      return createFirestoreProvider(tenant)
    case 'supabase':
      return createSupabaseProvider(tenant)
    default: {
      const exhaustive: never = tenant.databaseProvider
      throw new Error(`Unsupported database provider: ${String(exhaustive)}`)
    }
  }
}

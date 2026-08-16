import { describe, expect, it } from 'vitest'
import { getProviderForTenant } from '@/lib/data'
import type { TenantConfig } from '@/lib/contracts/tenants'

describe('getProviderForTenant (Section 6B per-tenant backend)', () => {
  it('returns a FirestoreProvider for databaseProvider firestore', () => {
    const tenant: TenantConfig = {
      tenantId: 't1',
      databaseProvider: 'firestore',
      firebase: { projectId: 'website-builder' },
    }
    const provider = getProviderForTenant(tenant)
    expect(provider.name).toBe('firestore')
  })

  it('requires tenant.firebase.projectId for the Firestore provider', () => {
    const tenant: TenantConfig = { tenantId: 't1', databaseProvider: 'firestore' }
    expect(() => getProviderForTenant(tenant)).toThrow(/projectId/)
  })

  it('throws for the Supabase provider until it is implemented (designed-in)', () => {
    const tenant: TenantConfig = { tenantId: 't2', databaseProvider: 'supabase' }
    expect(() => getProviderForTenant(tenant)).toThrow(/not yet implemented/i)
  })
})

import { describe, expect, it } from 'vitest'
import { TenantConfigSchema, type TenantConfig } from '@/lib/contracts/tenants'

describe('TenantConfigSchema (Section 6B)', () => {
  it('parses a Firestore tenant config with databaseProvider', () => {
    const config: TenantConfig = {
      tenantId: 'site-a-tenant',
      databaseProvider: 'firestore',
      tableExtension: 'uniconbaseapps',
      firebase: { projectId: 'website-builder' },
    }
    const parsed = TenantConfigSchema.parse(config)
    expect(parsed.databaseProvider).toBe('firestore')
    expect(parsed.tenantId).toBe('site-a-tenant')
    expect(parsed.tableExtension).toBe('uniconbaseapps')
  })

  it('parses a Supabase tenant config', () => {
    const parsed = TenantConfigSchema.parse({
      tenantId: 'supa-tenant',
      databaseProvider: 'supabase',
      supabase: { url: 'https://demo.supabase.co' },
    })
    expect(parsed.databaseProvider).toBe('supabase')
  })

  it('rejects unknown database providers', () => {
    const result = TenantConfigSchema.safeParse({
      tenantId: 't',
      databaseProvider: 'mysql',
    })
    expect(result.success).toBe(false)
  })

  it('requires a tenantId', () => {
    const result = TenantConfigSchema.safeParse({ databaseProvider: 'firestore' })
    expect(result.success).toBe(false)
  })

  it('parses the tenant-configurable defaultAppId (Q12)', () => {
    const parsed = TenantConfigSchema.parse({
      tenantId: 't',
      databaseProvider: 'firestore',
      defaultAppId: 'restaurant-orders-app',
    })
    expect(parsed.defaultAppId).toBe('restaurant-orders-app')
  })

  it('tolerates extra admin fields (admin-compatible shape)', () => {
    const parsed = TenantConfigSchema.parse({
      tenantId: 't',
      databaseProvider: 'firestore',
      someAdminField: true,
    })
    expect(parsed.tenantId).toBe('t')
  })
})

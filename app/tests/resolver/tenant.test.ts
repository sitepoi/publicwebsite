import { describe, expect, it, vi } from 'vitest'
import {
  createHostResolver,
  createRelayTenantLookup,
  decodeRelayConfig,
  parseTenantConfig,
} from '@/lib/resolver/tenant'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { createFakeProvider } from './fakes'

const tenantA: TenantConfig = {
  tenantId: 'tenant-a',
  databaseProvider: 'firestore',
  firebase: { projectId: 'project-a' },
}

describe('resolveTenant (cached hostname → tenant)', () => {
  it('normalizes the host before lookup (uppercase + port)', async () => {
    const lookup = vi.fn(async (host: string) => (host === 'www.site-a.com' ? tenantA : null))
    const resolver = createHostResolver(createFakeProvider(), {
      lookup,
      fallbackToDefault: false,
    })
    const tenant = await resolver.resolveTenant('WWW.Site-A.com:8080')
    expect(tenant?.tenantId).toBe('tenant-a')
    expect(lookup).toHaveBeenCalledWith('www.site-a.com')
  })

  it('caches results per host (short TTL)', async () => {
    const lookup = vi.fn(async () => tenantA)
    const resolver = createHostResolver(createFakeProvider(), { lookup, fallbackToDefault: false })
    await resolver.resolveTenant('site-a.com')
    await resolver.resolveTenant('site-a.com')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('invalidateTenant(host) forces a fresh lookup', async () => {
    const lookup = vi.fn(async () => tenantA)
    const resolver = createHostResolver(createFakeProvider(), { lookup, fallbackToDefault: false })
    await resolver.resolveTenant('site-a.com')
    resolver.invalidateTenant('site-a.com')
    await resolver.resolveTenant('site-a.com')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('clearTenantCache resets every host', async () => {
    const lookup = vi.fn(async () => tenantA)
    const resolver = createHostResolver(createFakeProvider(), { lookup, fallbackToDefault: false })
    await resolver.resolveTenant('site-a.com')
    resolver.clearTenantCache()
    await resolver.resolveTenant('site-a.com')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('caches negative results too (no lookup stampede)', async () => {
    const lookup = vi.fn(async () => null)
    const resolver = createHostResolver(createFakeProvider(), { lookup, fallbackToDefault: false })
    await resolver.resolveTenant('unknown.example')
    await resolver.resolveTenant('unknown.example')
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default tenant when the registry has no entry', async () => {
    const lookup = vi.fn(async () => null)
    const defaultTenant: TenantConfig = {
      tenantId: 'env-tenant',
      databaseProvider: 'firestore',
      firebase: { projectId: 'env-project' },
    }
    const resolver = createHostResolver(createFakeProvider(), {
      lookup,
      defaultTenant: () => defaultTenant,
    })
    const tenant = await resolver.resolveTenant('unknown.example')
    expect(tenant?.tenantId).toBe('env-tenant')
  })

  it('returns null when fallback is disabled and no entry exists', async () => {
    const resolver = createHostResolver(createFakeProvider(), {
      lookup: async () => null,
      fallbackToDefault: false,
    })
    expect(await resolver.resolveTenant('unknown.example')).toBeNull()
  })

  it('returns null for invalid hosts without touching the registry', async () => {
    const lookup = vi.fn(async () => tenantA)
    const resolver = createHostResolver(createFakeProvider(), { lookup, fallbackToDefault: false })
    expect(await resolver.resolveTenant('')).toBeNull()
    expect(await resolver.resolveTenant('   ')).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('relay registry lookup (settings doc per hostname, Section 6)', () => {
  it('reads a tenantConfig object from the settings doc', async () => {
    const provider = createFakeProvider({
      getSettings: async (ids) =>
        ids[0] === 'site-a.com' ? [{ id: 'site-a.com', tenantConfig: tenantA }] : [],
    })
    const lookup = createRelayTenantLookup(provider)
    const tenant = await lookup('site-a.com')
    expect(tenant?.tenantId).toBe('tenant-a')
  })

  it('decodes the legacy base64 config shape', async () => {
    const encoded = Buffer.from(JSON.stringify(tenantA)).toString('base64')
    const provider = createFakeProvider({
      getSettings: async () => [{ id: 'site-a.com', config: encoded }],
    })
    const lookup = createRelayTenantLookup(provider)
    const tenant = await lookup('site-a.com')
    expect(tenant?.tenantId).toBe('tenant-a')
  })

  it('returns null when no settings doc exists for the host', async () => {
    const provider = createFakeProvider({ getSettings: async () => [] })
    const lookup = createRelayTenantLookup(provider)
    expect(await lookup('site-a.com')).toBeNull()
  })

  it('ignores malformed configs', () => {
    expect(decodeRelayConfig({ id: 'x', config: 'not-base64!!' })).toBeUndefined()
    expect(parseTenantConfig(null, 'h')).toBeNull()
    expect(parseTenantConfig({ databaseProvider: 'mysql' }, 'h')).toBeNull()
  })
})

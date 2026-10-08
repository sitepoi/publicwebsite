import { getEnv } from '@/lib/config/env'
import { getProviderForTenant } from '@/lib/data'
import { createFixtureProvider } from '@/lib/data/providers/fixtures'
import { createSitepoiRegistryLookup } from '@/lib/data/providers/firestore/registry'
import { TenantConfigSchema, type TenantConfig } from '@/lib/contracts/tenants'
import { createHostResolver, createRelayTenantLookup, type TenantLookup } from './tenant'
import { createSiteResolver, loadWebsiteAppDefinitions } from './site'

/**
 * Shared resolver stack wiring (Section 5) — a lazy server-side singleton so
 * requests share the cached host/site resolutions.
 *
 * The default tenant comes from the Section 22 env contract (validated at
 * boot): secrets stay env-only, no hardcoded domains. Multi-tenant registry
 * entries (settings docs per hostname) take precedence — see resolver/tenant.ts.
 *
 * GW_DEV_FIXTURES='1' swaps every provider for the in-memory fixture site
 * (C4 deliverable — dev/demo only, ADR-004).
 */
function isFixtureMode(): boolean {
  return getEnv().GW_DEV_FIXTURES === '1'
}

export function getDefaultTenantFromEnv(): TenantConfig {
  const env = getEnv()
  return TenantConfigSchema.parse({
    tenantId: env.FIREBASE_PROJECT_ID,
    databaseProvider: 'firestore',
    firebase: { projectId: env.FIREBASE_PROJECT_ID },
  })
}

export interface ResolverStack {
  resolveTenant: ReturnType<typeof createHostResolver>['resolveTenant']
  resolveSite: ReturnType<typeof createSiteResolver>['resolveSite']
  getProvider: (tenant: TenantConfig) => ReturnType<typeof getProviderForTenant>
  invalidateTenant: ReturnType<typeof createHostResolver>['invalidateTenant']
  invalidateSite: ReturnType<typeof createSiteResolver>['invalidateSite']
  clearCaches: () => void
  /** True when the host resolves through the REGISTRY (legacy or future-option
   * lookup) WITHOUT the default-tenant fallback - drives the "site not
   * configured" diagnostic page (D-DWH-19). */
  hasRegistryEntry: (host: string) => Promise<boolean>
}

let stack: ResolverStack | null = null

export function getResolverStack(): ResolverStack {
  if (!stack) {
    const defaultTenant = getDefaultTenantFromEnv()
    const fixtureMode = isFixtureMode()
    const defaultProvider = fixtureMode
      ? createFixtureProvider()
      : getProviderForTenant(defaultTenant)

    // Registry (Section 6.2, D-DWH-10): the sitepoi-relay applications store
    // is the PRIMARY source (server-side read); the new-style settings doc
    // per hostname stays behind it as the documented FUTURE OPTION. No entry
    // anywhere → the env default tenant.
    const legacyRegistryLookup: TenantLookup = fixtureMode
      ? async () => null
      : createSitepoiRegistryLookup()
    const settingsRegistryLookup = createRelayTenantLookup(defaultProvider)
    const registryLookup: TenantLookup = async (host) =>
      (await legacyRegistryLookup(host)) ?? (await settingsRegistryLookup(host))
    const hasRegistryEntry = async (host: string) => (await registryLookup(host)) !== null

    const tenantResolver = createHostResolver(defaultProvider, {
      lookup: registryLookup,
      defaultTenant: () => defaultTenant,
    })
    const providerFor = (tenant: TenantConfig) =>
      fixtureMode ? createFixtureProvider() : getProviderForTenant(tenant)
    const siteResolver = createSiteResolver({
      getTenant: (host) => tenantResolver.resolveTenant(host),
      getProvider: providerFor,
      loadAppDefinitions: loadWebsiteAppDefinitions,
    })

    stack = {
      resolveTenant: (host) => tenantResolver.resolveTenant(host),
      resolveSite: (host) => siteResolver.resolveSite(host),
      getProvider: providerFor,
      invalidateTenant: (host) => tenantResolver.invalidateTenant(host),
      invalidateSite: (host) => siteResolver.invalidateSite(host),
      hasRegistryEntry: (host) => hasRegistryEntry(host),
      clearCaches: () => {
        tenantResolver.clearTenantCache()
        siteResolver.clearSiteCache()
      },
    }
  }
  return stack
}

export * from './host'
export * from './tenant'
export * from './site'
export * from './page'
export * from './page-loader'

import { getEnv } from '@/lib/config/env'
import { getProviderForTenant } from '@/lib/data'
import { createFixtureProvider } from '@/lib/data/providers/fixtures'
import { TenantConfigSchema, type TenantConfig } from '@/lib/contracts/tenants'
import { createHostResolver } from './tenant'
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
}

let stack: ResolverStack | null = null

export function getResolverStack(): ResolverStack {
  if (!stack) {
    const defaultTenant = getDefaultTenantFromEnv()
    const fixtureMode = isFixtureMode()
    const defaultProvider = fixtureMode
      ? createFixtureProvider()
      : getProviderForTenant(defaultTenant)

    const tenantResolver = createHostResolver(defaultProvider, {
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

import type { DataProvider, SettingsDoc } from '@/lib/data/provider'
import { TenantConfigSchema, type TenantConfig } from '@/lib/contracts/tenants'
import { normalizeHost } from './host'

/**
 * Tenant resolution (Sections 5 / 6) — hostname → tenant/Firebase project
 * config, cached server module.
 *
 * Like the legacy `/api/relay/ras`: one `settings` doc PER HOSTNAME (doc id =
 * normalized host), whose data carries the tenant config — either as a
 * `tenantConfig` object (new) or a base64 `config` string (relay/ras legacy
 * shape). Admin collection names stay unchanged (Section 6 hard rule).
 *
 * When the host has no registry entry, the resolver falls back to the
 * deployment's DEFAULT tenant (built from the Section 22 env contract —
 * secrets stay env-only, no hardcoded domains). Unknown hosts then fail at
 * SITE resolution with notFound (Section 7.3 rule 4). (ADR-002)
 */

export const TENANT_CACHE_TTL_MS = 60_000

export type TenantLookup = (host: string) => Promise<TenantConfig | null>

export interface HostResolverOptions {
  lookup?: TenantLookup
  defaultTenant?: () => TenantConfig
  fallbackToDefault?: boolean
  ttlMs?: number
}

export interface TenantResolver {
  resolveTenant(host: string): Promise<TenantConfig | null>
  /** Invalidate one host (or the whole cache) — used by the C11 purge work. */
  invalidateTenant(host?: string): void
  clearTenantCache(): void
}

/** Settings doc shape served by the relay registry (Section 6). */
export interface RelaySettingsDoc extends SettingsDoc {
  tenantConfig?: unknown
  config?: string
}

export function decodeRelayConfig(doc: RelaySettingsDoc): unknown {
  const encoded = doc.config
  if (typeof encoded !== 'string' || encoded.length === 0) return undefined
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

export function parseTenantConfig(raw: unknown, host: string): TenantConfig | null {
  if (raw === undefined || raw === null) return null
  const result = TenantConfigSchema.safeParse(raw)
  if (!result.success) {
    console.warn(`[resolver] invalid tenant config for host '${host}' — skipped`)
    return null
  }
  return result.data
}

/** Default registry lookup: settings doc keyed by the normalized hostname. */
export function createRelayTenantLookup(provider: DataProvider): TenantLookup {
  return async (host) => {
    const normalized = normalizeHost(host)
    if (!normalized) return null

    const docs = await provider.getSettings([normalized])
    const doc = docs[0]
    if (!doc) return null

    const raw = (doc.tenantConfig ?? decodeRelayConfig(doc)) as unknown
    return parseTenantConfig(raw, normalized)
  }
}

export function createHostResolver(
  provider: DataProvider,
  options: HostResolverOptions = {},
): TenantResolver {
  const lookup = options.lookup ?? createRelayTenantLookup(provider)
  const ttlMs = options.ttlMs ?? TENANT_CACHE_TTL_MS
  const fallbackToDefault = options.fallbackToDefault ?? true

  const cache = new Map<string, { value: TenantConfig | null; expiresAt: number }>()

  async function resolveTenant(host: string): Promise<TenantConfig | null> {
    const normalized = normalizeHost(host)
    if (!normalized) return null

    const now = Date.now()
    const cached = cache.get(normalized)
    if (cached && cached.expiresAt > now) return cached.value

    let tenant = await lookup(normalized)
    if (!tenant && fallbackToDefault && options.defaultTenant) {
      tenant = options.defaultTenant()
    }
    // Negative results are cached too (short TTL) to avoid lookup stampedes.
    cache.set(normalized, { value: tenant, expiresAt: now + ttlMs })
    return tenant
  }

  function invalidateTenant(host?: string): void {
    if (host === undefined) {
      cache.clear()
      return
    }
    const normalized = normalizeHost(host)
    if (normalized) cache.delete(normalized)
  }

  function clearTenantCache(): void {
    cache.clear()
  }

  return { resolveTenant, invalidateTenant, clearTenantCache }
}

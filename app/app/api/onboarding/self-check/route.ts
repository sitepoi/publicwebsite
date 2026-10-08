import { NextResponse, type NextRequest } from 'next/server'
import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import type { SiteResolution } from '@/lib/resolver/site'
import { resolveFirebaseAdminCredentials } from '@/lib/firestore/admin-app'
import { hostMatches } from '@/lib/resolver/host'

/**
 * GET /api/onboarding/self-check?hostname=… (T-16) - the onboarding
 * self-check: resolves tenant + site for a hostname and reports each of the
 * six layers (6.0) with pass/fail and the exact missing piece - the server
 * answer to "why is this domain 404ing" (F-02..F-06).
 *
 * Guarded by x-revalidate-secret (REVALIDATE_SECRET) or x-relay-secret
 * (RELAY_SECRET). READ-ONLY - never writes anything.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export interface SelfCheckLayer {
  layer: string
  name: string
  status: 'pass' | 'fail' | 'na'
  detail: string
}

export interface SelfCheckDeps {
  env?: Env
  resolveTenant?: (host: string) => Promise<TenantConfig | null>
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  checkCredentials?: (projectId: string) => string | null
}

export async function handleOnboardingSelfCheck(
  request: Request,
  deps: SelfCheckDeps = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  const secret =
    request.headers.get('x-revalidate-secret') ?? request.headers.get('x-relay-secret')
  if (secret !== env.REVALIDATE_SECRET && secret !== env.RELAY_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const hostname =
    url.searchParams.get('hostname') ??
    request.headers.get('x-gw-host') ??
    request.headers.get('host') ??
    ''

  const layers: SelfCheckLayer[] = []
  layers.push({
    layer: 'L1',
    name: 'DNS + hosting platform',
    status: 'na',
    detail:
      'Cannot be checked server-side - verify DNS resolves to the deployment and the domain is added in the hosting platform (TLS + original Host header).',
  })

  // L2 - registry resolution (lazy stack access keeps tests env-free).
  const tenant = await (deps.resolveTenant ?? ((host) => getResolverStack().resolveTenant(host)))(
    hostname,
  )
  if (!tenant) {
    layers.push({
      layer: 'L2',
      name: 'Registry (hostname → tenant)',
      status: 'fail',
      detail: 'No tenant resolved for the host - no registry entry and no default fallback (F-02/F-03).',
    })
    layers.push({ layer: 'L3', name: 'Tenant credentials', status: 'na', detail: 'Skipped - no tenant.' })
    layers.push({
      layer: 'L4',
      name: 'App registration (cms-settings)',
      status: 'fail',
      detail: 'tenant-not-found',
    })
    layers.push({
      layer: 'L5',
      name: 'Site config (default-settings)',
      status: 'fail',
      detail: 'tenant-not-found',
    })
    layers.push({ layer: 'L6', name: 'Publish purge endpoint', status: 'na', detail: 'Skipped - no site.' })
    return NextResponse.json({ ok: false, hostname, layers })
  }

  const fallback = tenant.tenantId === env.FIREBASE_PROJECT_ID
  layers.push({
    layer: 'L2',
    name: 'Registry (hostname → tenant)',
    status: 'pass',
    detail: `Resolved tenant '${tenant.tenantId}'${fallback ? ' (matches the env default tenant - may be a FALLBACK, check the sitepoi-relay applications entry)' : ''}.`,
  })

  // L3 - credentials come from env (never read secrets out, only check presence).
  const projectId = tenant.firebase?.projectId ?? env.FIREBASE_PROJECT_ID
  const credentialError = (
    deps.checkCredentials ??
    ((project: string) => {
      try {
        resolveFirebaseAdminCredentials({ projectId: project })
        return null
      } catch (error) {
        return error instanceof Error ? error.message : 'missing admin credentials'
      }
    })
  )(projectId)
  layers.push(
    credentialError
      ? {
          layer: 'L3',
          name: 'Tenant credentials',
          status: 'fail',
          detail: credentialError,
        }
      : {
          layer: 'L3',
          name: 'Tenant credentials',
          status: 'pass',
          detail: `Admin credentials for project '${projectId}' are configured.`,
        },
  )

  // L4 + L5 - site resolution (app registration + default-settings hostNames).
  const siteResult = await (deps.resolveSite ?? ((host) => getResolverStack().resolveSite(host)))(
    hostname,
  )
  if (!siteResult.ok) {
    layers.push({
      layer: 'L4',
      name: 'App registration (cms-settings)',
      status: 'fail',
      detail: `site resolution failed: ${siteResult.reason} (F-05/F-06).`,
    })
    layers.push({
      layer: 'L5',
      name: 'Site config (default-settings)',
      status: 'fail',
      detail: siteResult.reason,
    })
    layers.push({ layer: 'L6', name: 'Publish purge endpoint', status: 'na', detail: 'Skipped - no site.' })
    return NextResponse.json({ ok: false, hostname, layers })
  }

  const site = siteResult.site
  const provider = (deps.providerFor ?? ((resolvedTenant) => getResolverStack().getProvider(resolvedTenant)))(
    site.tenant,
  )
  layers.push({
    layer: 'L4',
    name: 'App registration (cms-settings)',
    status: 'pass',
    detail: `Website app '${site.appId}' registered (publicAccess ${site.appPublicAccess ?? '(unset)'}).`,
  })

  const defaultsQuery = await provider.queryObjects({
    cmsObjectType: site.appId,
    filters: [{ field: 'slug', op: '==', value: 'default-settings' }],
    pageSize: 200,
  })
  const matchingDefaults = defaultsQuery.items.find((record) => {
    const data = (record.data ?? {}) as Record<string, unknown>
    const names = Array.isArray(data['hostNames']) ? data['hostNames'] : []
    return names.some((name) => typeof name === 'string' && hostMatches(hostname, name))
  })
  layers.push(
    matchingDefaults
      ? {
          layer: 'L5',
          name: 'Site config (default-settings)',
          status: 'pass',
          detail: `Site folder '${site.folderId}' configured with matching hostNames.`,
        }
      : {
          layer: 'L5',
          name: 'Site config (default-settings)',
          status: 'fail',
          detail: 'No default-settings object maps this hostname (hostNames mismatch or missing).',
        },
  )

  const homeQuery = await provider.queryObjects({
    cmsObjectType: site.appId,
    filters: [{ field: 'slug', op: '==', value: 'home-page' }],
    pageSize: 200,
  })
  const hasHome = homeQuery.items.some((record) => record.typeId === site.folderId)
  layers.push({
    layer: 'L5',
    name: 'Home page (home-page stub)',
    status: hasHome ? 'pass' : 'fail',
    detail: hasHome ? 'home-page object present in the site folder.' : 'home-page object missing in the site folder (F-07).',
  })

  layers.push({
    layer: 'L6',
    name: 'Publish purge endpoint',
    status: 'pass',
    detail: 'POST /api/revalidate with x-revalidate-secret - call it after publishing (tags host-<host>, site-<folderId>).',
  })

  const ok = layers.every((layer) => layer.status !== 'fail')
  return NextResponse.json({ ok, hostname, layers })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const response = await handleOnboardingSelfCheck(request)
  return NextResponse.json(await response.json(), { status: response.status })
}

import { NextResponse, type NextRequest } from 'next/server'
import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { TenantCreationRequestSchema } from '@/lib/onboarding/contracts'
import {
  createTenant,
  defaultCmsCall,
  type TenantCreationDeps,
} from '@/lib/onboarding/service'
import { listRelayApplicationHostNames } from '@/lib/data/providers/firestore/registry'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'

/**
 * POST /api/tenant/create (ONBOARD T-11..T-14, D-DWH-11) - the public tenant
 * creation endpoint of THIS platform. Re-implements the legacy flow with the
 * same CMS endpoints (CTGC/CUGC/CNA) and the same Firestore shapes (Section
 * 6.11), plus the new site skeleton (folder + default-settings + home-page
 * stub, D-DWH-14). CREATE-ONLY: existing tenants answer 409 already-exists
 * (D-DWH-15). The response carries the L3 env var names to add, the purge
 * result and the 6.10 verification checklist.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const TENANT_CREATE_RATE_MAX = 3
export const TENANT_CREATE_RATE_WINDOW_MS = 10 * 60 * 1000

export interface TenantCreateDeps {
  env?: Env
  resolveTenant?: (host: string) => Promise<TenantConfig | null>
  providerFor?: (tenant: TenantConfig) => DataProvider
  cmsCall?: TenantCreationDeps['cmsCall']
  registryHostNames?: () => Promise<string[]>
  purge?: TenantCreationDeps['purge']
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  runLiveChecks?: boolean
}

let sharedLimiter: RateLimiter | null = null
function tenantCreateLimiter(): RateLimiter {
  if (!sharedLimiter) {
    sharedLimiter = createMemoryRateLimiter({
      max: TENANT_CREATE_RATE_MAX,
      windowMs: TENANT_CREATE_RATE_WINDOW_MS,
    })
  }
  return sharedLimiter
}

export async function handleTenantCreate(
  request: Request,
  deps: TenantCreateDeps = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  const url = new URL(request.url)
  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    return NextResponse.json({ error: 'blocked' }, { status: 403 })
  }

  const limiter = deps.rateLimiter ?? tenantCreateLimiter()
  const rate = limiter.check(
    `tenant-create:${hashIp(getClientIp(request), env.RELAY_SECRET)}`,
  )
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 },
      { status: 429 },
    )
  }

  const parsed = TenantCreationRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-tenant-request',
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      },
      { status: 400 },
    )
  }
  const input = parsed.data

  // Honeypot - silent drop.
  if (input.gw_hp && input.gw_hp.trim().length > 0) {
    return NextResponse.json({ ok: true })
  }

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  // Lazy stack access: with injected deps (tests) the stack - and its env
  // validation - is never touched.
  const tenant = await (deps.resolveTenant ?? ((hostName) => getResolverStack().resolveTenant(hostName)))(
    host,
  )
  if (!tenant) return NextResponse.json({ error: 'site-not-found' }, { status: 404 })
  const provider = (deps.providerFor ?? ((resolvedTenant) => getResolverStack().getProvider(resolvedTenant)))(
    tenant,
  )
  const projectId = tenant.firebase?.projectId ?? env.FIREBASE_PROJECT_ID

  if (!env.CMS_API_KEY) {
    return NextResponse.json({ error: 'tenant-creation-disabled' }, { status: 503 })
  }

  const origin = url.origin
  const resolveTenantForHost = async (checkHost: string) => {
    const resolved = deps.resolveTenant
      ? await deps.resolveTenant(checkHost)
      : await getResolverStack().resolveTenant(checkHost)
    return resolved ? { tenantId: resolved.tenantId } : null
  }
  const result = await createTenant(input, {
    provider,
    tableExtension: tenant.tableExtension ?? '',
    cmsApiKey: env.CMS_API_KEY,
    projectId,
    developerEmail: env.DEVELOPER_EMAIL,
    cmsCall: deps.cmsCall ?? defaultCmsCall(env.CMS_ADMIN_DOMAIN),
    resolveTenantForHost,
    registryHostNames: deps.registryHostNames ?? (() => listRelayApplicationHostNames()),
    purge:
      deps.purge ??
      (async (hostNames, folderId) => {
        try {
          const response = await fetch(`${origin}/api/revalidate`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-revalidate-secret': env.REVALIDATE_SECRET,
            },
            body: JSON.stringify({
              tags: [...hostNames.map((hostName) => `host-${hostName}`), `site-${folderId}`],
            }),
          })
          const body = await response.json().catch(() => null)
          return {
            ok: response.ok,
            detail: `HTTP ${response.status}${body ? ` ${JSON.stringify(body)}` : ''}`,
          }
        } catch (error) {
          return {
            ok: false,
            detail: error instanceof Error ? error.message : 'purge failed',
          }
        }
      }),
    runLiveChecks: deps.runLiveChecks ?? env.NODE_ENV === 'production',
  })

  if (!result.ok) {
    if (result.error === 'already-exists') {
      return NextResponse.json(
        { error: 'already-exists', existing: result.existing },
        { status: 409 },
      )
    }
    if (result.error === 'cms-unavailable') {
      return NextResponse.json({ error: 'cms-unavailable' }, { status: 503 })
    }
    if (result.error === 'cms-error') {
      return NextResponse.json({ error: 'cms-error', detail: result.detail }, { status: 502 })
    }
    return NextResponse.json({ error: 'write-failed', detail: result.detail }, { status: 500 })
  }

  return NextResponse.json({ success: true, ...result })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = await handleTenantCreate(request)
  return NextResponse.json(await response.json(), { status: response.status })
}

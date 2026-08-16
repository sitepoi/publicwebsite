import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { AccountResourceSchema, ACCOUNT_RESOURCES } from '@/lib/contracts/auth'
import { getAuthService, loadUserRoles, type AuthService, type SessionUser } from '@/lib/auth'
import { SESSION_COOKIE } from '@/app/api/auth/session/route'
import type { SiteResolution } from '@/lib/resolver/site'
import type { Env } from '@/lib/config/env'

/**
 * GET /api/account/[resource] (Sections 17/32) — the user's own account data.
 *
 * resources: profile | orders | tickets | bookings. Collection reads are
 * ALWAYS scoped server-side by `customerId === uid` (ownerField=customerId,
 * Section 32) — the client can never widen the scope. Hard rule: user-scoped
 * data only.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const ACCOUNT_QUERY_LIMIT = 100

export interface AccountDeps {
  env?: Env
  authService?: AuthService
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
}

export async function handleAccount(
  request: Request,
  resource: string,
  deps: AccountDeps = {},
): Promise<Response> {
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const authService = deps.authService ?? (await getAuthService())

  const parsed = AccountResourceSchema.safeParse(resource)
  if (!parsed.success) return json({ error: 'resource-not-found' }, 404)
  const accountResource = parsed.data

  const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!cookie) return json({ error: 'auth-required' }, 401)
  const authUser = await authService.userFromSessionCookie(cookie)
  if (!authUser) return json({ error: 'auth-required' }, 401)

  const roles = await loadUserRoles(provider, authUser.uid)
  const user: SessionUser = { ...authUser, email: authUser.email ?? '', roles }

  if (accountResource === 'profile') {
    const doc = await provider.getRecord({ collection: 'users', id: authUser.uid })
    return json({ ok: true, profile: { user, ...(doc ?? {}) } })
  }

  // Collection read, ALWAYS scoped to the caller (ownerField=customerId).
  const collection = `${accountResource}${site.tenant.tableExtension ?? ''}`
  const items = await provider.queryRecords({
    collection,
    filters: [{ field: 'customerId', op: '==', value: authUser.uid }],
    limit: ACCOUNT_QUERY_LIMIT,
  })

  return json({ ok: true, resource: accountResource, items })
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ resource: string }> },
): Promise<Response> {
  const { resource } = await context.params
  return handleAccount(request, resource)
}

export const resources = ACCOUNT_RESOURCES

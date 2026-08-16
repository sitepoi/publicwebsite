import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { AuthSessionCallSchema, UserDocSchema } from '@/lib/contracts/auth'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import {
  getAuthService,
  loadUserRoles,
  USERS_COLLECTION,
  type AuthService,
  type SessionUser,
} from '@/lib/auth'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * /api/auth/session (Section 17) — Firebase session cookies, HttpOnly,
 * Secure (production), SameSite=Lax. POST actions: login / register /
 * logout / forgot / reset / verify. GET returns the session user (me).
 *
 * HARD RULES (C9): passwords exist ONLY in the in-flight request — never
 * logged, never persisted, never echoed back. Roles come from the users
 * collection (Uniconhub admin schema).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const SESSION_COOKIE = 'gw-session'
export const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000 // 5 days (Firebase max: 14)
export const AUTH_RATE_MAX = 10
export const AUTH_RATE_WINDOW_MS = 60_000

export interface AuthSessionDeps {
  env?: Env
  authService?: AuthService
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  now?: () => Date
}

export async function handleAuthSession(
  request: Request,
  deps: AuthSessionDeps = {},
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
    return json({ error: 'blocked' }, 403)
  }

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const authService = deps.authService ?? (await getAuthService())

  // GET — me (session persistence check).
  if (request.method === 'GET') {
    return json({ user: await sessionUser(request, authService, provider) })
  }

  const limiter = deps.rateLimiter ?? sharedLimiter()
  const rate = limiter.check(`auth:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const parsed = AuthSessionCallSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-auth-call' }, 400)
  const call = parsed.data

  // Honeypot — silent.
  if (call.gw_hp && call.gw_hp.trim().length > 0) return json({ ok: true })

  try {
    switch (call.action) {
      case 'login': {
        const { idToken } = await authService.login(call.email, call.password)
        const session = await authService.createSessionFromIdToken(idToken, SESSION_TTL_MS)
        await ensureUserDoc(provider, session.user.uid, call.email, undefined, deps.now)
        const sessionInfo = await sessionUserFor(provider, session.user)
        const response = json({ ok: true, user: sessionInfo })
        response.headers.set('Set-Cookie', buildSessionCookie(session.cookie, env))
        return response
      }
      case 'register': {
        const { idToken } = await authService.register(call.email, call.password)
        const session = await authService.createSessionFromIdToken(idToken, SESSION_TTL_MS)
        await ensureUserDoc(provider, session.user.uid, call.email, call.name, deps.now)
        const sessionInfo = await sessionUserFor(provider, session.user)
        const response = json({ ok: true, user: sessionInfo })
        response.headers.set('Set-Cookie', buildSessionCookie(session.cookie, env))
        return response
      }
      case 'logout': {
        const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
        if (cookie) await authService.revokeSessionCookie(cookie)
        const response = json({ ok: true })
        response.headers.set('Set-Cookie', clearSessionCookie(env))
        return response
      }
      case 'forgot':
        await authService.forgotPassword(call.email)
        return json({ ok: true })
      case 'reset':
        await authService.resetPassword(call.oobCode, call.password)
        return json({ ok: true })
      case 'verify':
        await authService.verifyEmail(call.oobCode)
        return json({ ok: true })
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'auth-failed'
    return json({ error: sanitizeAuthError(code) }, statusOfAuthError(code))
  }
}

// ------------------------------------------------------------------ helpers

async function sessionUser(
  request: Request,
  authService: AuthService,
  provider: DataProvider,
): Promise<SessionUser | null> {
  const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (!cookie) return null
  const user = await authService.userFromSessionCookie(cookie)
  if (!user) return null
  return sessionUserFor(provider, user)
}

async function sessionUserFor(
  provider: DataProvider,
  user: { uid: string; email: string | null; emailVerified: boolean },
): Promise<SessionUser> {
  const roles = await loadUserRoles(provider, user.uid)
  return { ...user, email: user.email ?? '', roles }
}

async function ensureUserDoc(
  provider: DataProvider,
  uid: string,
  email: string,
  name: string | undefined,
  now: (() => Date) | undefined,
): Promise<void> {
  const existing = await provider.getRecord({ collection: USERS_COLLECTION, id: uid })
  if (existing) return
  const parsed = UserDocSchema.safeParse({
    uid,
    email,
    ...(name !== undefined ? { name } : {}),
    roles: ['customer'],
    createdAt: (now ?? (() => new Date()))().toISOString(),
  })
  await provider.createRecord({
    collection: USERS_COLLECTION,
    id: uid,
    data: parsed.success ? parsed.data : { uid, email, roles: ['customer'] },
  })
}

function sanitizeAuthError(code: string): string {
  switch (code) {
    case 'EMAIL_EXISTS':
      return 'email-exists'
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_PASSWORD':
    case 'EMAIL_NOT_FOUND':
      return 'invalid-credentials'
    case 'EXPIRED_OOB_CODE':
    case 'INVALID_OOB_CODE':
      return 'invalid-code'
    case 'WEAK_PASSWORD':
      return 'weak-password'
    case 'auth-not-configured':
      return 'auth-not-configured'
    default:
      return 'auth-failed'
  }
}

function statusOfAuthError(code: string): number {
  switch (code) {
    case 'EMAIL_EXISTS':
      return 409
    case 'INVALID_LOGIN_CREDENTIALS':
    case 'INVALID_PASSWORD':
    case 'EMAIL_NOT_FOUND':
      return 401
    case 'auth-not-configured':
      return 503
    default:
      return 400
  }
}

function buildSessionCookie(value: string, env: Env): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}${secure}`
}

function clearSessionCookie(env: Env): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: AUTH_RATE_MAX,
      windowMs: AUTH_RATE_WINDOW_MS,
    })
  }
  return limiterSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleAuthSession(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleAuthSession(request)
}

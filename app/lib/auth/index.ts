import { getEnv } from '@/lib/config/env'
import type { AuthService } from './types'

/**
 * Auth service selection (Section 6B auth abstraction): fixture mode swaps
 * the Firebase adapter for the in-memory one — same pattern as the data
 * provider (lib/resolver/index.ts, ADR-004).
 *
 * LAZY: the Firebase adapter is imported dynamically so tests and fixture
 * mode never load firebase-admin/auth (jwks-rsa/jose ESM chain — vitest).
 */
let cached: AuthService | null = null

export async function getAuthService(): Promise<AuthService> {
  if (!cached) {
    if (getEnv().GW_DEV_FIXTURES === '1') {
      const { createFixtureAuthService } = await import('./fixture')
      cached = createFixtureAuthService()
    } else {
      const { createFirebaseAuthService } = await import('./firebase')
      cached = createFirebaseAuthService(getEnv())
    }
  }
  return cached
}

export type { AuthService, AuthUserInfo, SessionUser } from './types'

/** HttpOnly session cookie (Section 17). Shared by the auth/account/flows. */
export const SESSION_COOKIE = 'gw-session'

/** Page gating (Section 17): data field requireAuth (true / 'yes' / 1). */
export function pageRequiresAuth(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  const value = (data as Record<string, unknown>)['requireAuth']
  return value === true || value === 'yes' || value === '1' || value === 1
}

/** users-collection doc id for a uid (Uniconhub admin schema). */
export const USERS_COLLECTION = 'users'

/** Roles from the users collection — default ['customer'] when absent. */
export async function loadUserRoles(
  provider: {
    getRecord(input: { collection: string; id: string }): Promise<Record<string, unknown> | null>
  },
  uid: string,
): Promise<string[]> {
  const doc = await provider.getRecord({ collection: USERS_COLLECTION, id: uid })
  const raw = doc?.['roles']
  const roles = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : []
  return roles.length > 0 ? roles : ['customer']
}

/** Session cookie → operation actor (roles from the users collection). */
export async function resolveSessionActor(
  request: Request,
  authService: AuthService,
  provider: {
    getRecord(input: { collection: string; id: string }): Promise<Record<string, unknown> | null>
  },
): Promise<{ id?: string; roles: string[] }> {
  const cookie = readCookieHeader(request.headers.get('cookie'), SESSION_COOKIE)
  if (!cookie) return { roles: [] }
  const user = await authService.userFromSessionCookie(cookie)
  if (!user) return { roles: [] }
  const roles = await loadUserRoles(provider, user.uid)
  return { id: user.uid, roles }
}

function readCookieHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

import axios from 'axios'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Env } from '@/lib/config/env'
import type { AuthService, AuthSession, AuthUserInfo } from './types'

/**
 * FirebaseAuthService (Section 17) — the current AuthService adapter.
 *
 * REST-ONLY (D-DWH-27): session handling never loads firebase-admin/auth
 * (the jwks-rsa → jose ESM chain crashes under require() in serverless
 * bundles). Session cookies are HMAC-signed payloads holding the idToken
 * (+ optional refresh token); verification goes through the Identity
 * Toolkit REST API (`accounts:lookup`), refresh through the secure-token
 * endpoint. Login/register/password-reset/verification already used REST.
 * The web API key is env-only: FIREBASE_API_KEY (Section 22).
 *
 * Adapter code only — app code never touches firebase-admin directly.
 */

const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1'
const SECURE_TOKEN_URL = 'https://securetoken.googleapis.com/v1/token'
const SESSION_COOKIE_VERSION = 'v1'

/** Known provider error codes — sanitized, password-free messages only. */
const KNOWN_ERRORS = new Set([
  'EMAIL_EXISTS',
  'EMAIL_NOT_FOUND',
  'INVALID_LOGIN_CREDENTIALS',
  'INVALID_PASSWORD',
  'WEAK_PASSWORD',
  'EXPIRED_OOB_CODE',
  'INVALID_OOB_CODE',
  'TOO_MANY_ATTEMPTS_TRY_LATER',
  'INVALID_ID_TOKEN',
  'MISSING_PASSWORD',
])

function extractCode(error: unknown): string {
  const data = axios.isAxiosError(error) ? (error.response?.data as unknown) : null
  if (data !== null && typeof data === 'object') {
    const message = (data as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string' && KNOWN_ERRORS.has(message)) return message
  }
  return 'auth-failed'
}

export class FirebaseAuthService implements AuthService {
  readonly name = 'firebase'

  constructor(
    private readonly env: Env,
    /** Firebase Auth tenant (D-DWH-12): when set, session cookies and
     * Identity Toolkit calls are scoped to this tenant. */
    private readonly authTenant?: string,
  ) {}

  private sessionSecret(): string {
    return this.env.SESSION_SECRET ?? this.env.RELAY_SECRET
  }

  private async rest<T>(action: string, body: Record<string, unknown>): Promise<T> {
    if (!this.env.FIREBASE_API_KEY) {
      throw new Error('auth-not-configured')
    }
    const url = `${IDENTITY_TOOLKIT_URL}/accounts:${action}?key=${this.env.FIREBASE_API_KEY}`
    const payload = this.authTenant ? { ...body, tenantId: this.authTenant } : body
    try {
      const response = await axios.post<T>(url, payload)
      return response.data
    } catch (error) {
      throw new Error(extractCode(error))
    }
  }

  private toUserInfo(data: {
    localId?: string
    email?: string
    emailVerified?: boolean
  }): AuthUserInfo {
    return {
      uid: data.localId ?? '',
      email: data.email ?? null,
      emailVerified: data.emailVerified === true,
    }
  }

  /** Validate an idToken via accounts:lookup → user info (null = invalid). */
  private async userFromIdToken(idToken: string): Promise<AuthUserInfo | null> {
    try {
      const data = await this.rest<{
        users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>
      }>('lookup', { idToken })
      const account = data.users?.[0]
      return account ? this.toUserInfo(account) : null
    } catch {
      return null
    }
  }

  /** Exchange a refresh token for a fresh idToken (secure-token endpoint). */
  private async refreshIdToken(refreshToken: string): Promise<string | null> {
    if (!this.env.FIREBASE_API_KEY) return null
    const url = `${SECURE_TOKEN_URL}?key=${this.env.FIREBASE_API_KEY}`
    const body: Record<string, unknown> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }
    if (this.authTenant) body.tenantId = this.authTenant
    try {
      const response = await axios.post<{ id_token?: string }>(url, body)
      return response.data.id_token ?? null
    } catch {
      return null
    }
  }

  async createSessionFromIdToken(
    idToken: string,
    expiresInMs: number,
    refreshToken?: string,
  ): Promise<AuthSession> {
    const user = await this.userFromIdToken(idToken)
    if (!user) throw new Error('INVALID_ID_TOKEN')
    const payload: Record<string, unknown> = {
      idToken,
      expiresAt: Date.now() + expiresInMs,
    }
    if (refreshToken) payload.refreshToken = refreshToken
    return { cookie: encodeSessionCookie(payload, this.sessionSecret()), user }
  }

  async userFromSessionCookie(cookie: string): Promise<AuthUserInfo | null> {
    const payload = decodeSessionCookie(cookie, this.sessionSecret())
    if (!payload) return null
    const expiresAt = typeof payload.expiresAt === 'number' ? payload.expiresAt : 0
    if (expiresAt <= Date.now()) return null
    const idToken = typeof payload.idToken === 'string' ? payload.idToken : ''
    if (!idToken) return null
    const user = await this.userFromIdToken(idToken)
    if (user) return user
    const refreshToken = typeof payload.refreshToken === 'string' ? payload.refreshToken : ''
    if (!refreshToken) return null
    const refreshed = await this.refreshIdToken(refreshToken)
    if (!refreshed) return null
    return this.userFromIdToken(refreshed)
  }

  async revokeSessionCookie(cookie: string): Promise<void> {
    // Identity Toolkit REST has no refresh-token revocation endpoint — the
    // client clears the cookie regardless (same semantics as before).
    void cookie
  }

  async register(
    email: string,
    password: string,
  ): Promise<{ user: AuthUserInfo; idToken: string; refreshToken?: string }> {
    const data = await this.rest<{
      idToken?: string
      refreshToken?: string
      localId?: string
      email?: string
      emailVerified?: boolean
    }>('signUp', { email, password, returnSecureToken: true })
    if (!data.idToken) throw new Error('auth-failed')
    return {
      user: this.toUserInfo(data),
      idToken: data.idToken,
      ...(data.refreshToken ? { refreshToken: data.refreshToken } : {}),
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ user: AuthUserInfo; idToken: string; refreshToken?: string }> {
    const data = await this.rest<{
      idToken?: string
      refreshToken?: string
      localId?: string
      email?: string
      emailVerified?: boolean
      registered?: boolean
    }>('signInWithPassword', { email, password, returnSecureToken: true })
    if (!data.idToken) throw new Error('auth-failed')
    return {
      user: this.toUserInfo(data),
      idToken: data.idToken,
      ...(data.refreshToken ? { refreshToken: data.refreshToken } : {}),
    }
  }

  async forgotPassword(email: string): Promise<void> {
    await this.rest('sendOobCode', { requestType: 'PASSWORD_RESET', email })
  }

  async resetPassword(oobCode: string, newPassword: string): Promise<void> {
    await this.rest('resetPassword', { oobCode, newPassword })
  }

  async verifyEmail(oobCode: string): Promise<void> {
    // The client SDK's applyActionCode calls the SAME endpoint.
    await this.rest('update', { oobCode })
  }
}

function signPayload(signed: string, secret: string): string {
  return createHmac('sha256', secret).update(signed).digest('base64url')
}

/**
 * Session cookie format (D-DWH-27): `v1.<base64url-json>.<hmac>`. The payload
 * holds { idToken, expiresAt, refreshToken? } — never password material.
 */
export function encodeSessionCookie(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signed = `${SESSION_COOKIE_VERSION}.${body}`
  return `${signed}.${signPayload(signed, secret)}`
}

/** Unpack + verify a session cookie; null = tampered/malformed. */
export function decodeSessionCookie(
  cookie: string,
  secret: string,
): Record<string, unknown> | null {
  const parts = cookie.split('.')
  if (parts.length !== 3 || parts[0] !== SESSION_COOKIE_VERSION) return null
  const signed = `${parts[0]}.${parts[1] ?? ''}`
  // Constant-time compare over the base64url signature STRINGS (both sides
  // are the same alphabet, compared as UTF-8 bytes of equal length).
  const expected = Buffer.from(signPayload(signed, secret), 'utf8')
  const provided = Buffer.from(parts[2] ?? '', 'utf8')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null
  try {
    const decoded = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as unknown
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function createFirebaseAuthService(env: Env, authTenant?: string): AuthService {
  return new FirebaseAuthService(env, authTenant)
}

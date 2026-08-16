import axios from 'axios'
import { getAuth } from 'firebase-admin/auth'
import type { Env } from '@/lib/config/env'
import { getFirebaseAdminApp } from '@/lib/firestore/admin-app'
import type { AuthService, AuthSession, AuthUserInfo } from './types'

/**
 * FirebaseAuthService (Section 17) — the current AuthService adapter.
 *
 * Session cookies via firebase-admin (`createSessionCookie` /
 * `verifySessionCookie`, Section 6B auth abstraction). Server-side
 * register/login/password-reset/verification go through the Firebase
 * Identity Toolkit REST API (admin SDK cannot sign users in). The web API
 * key is env-only: FIREBASE_API_KEY (Section 22).
 *
 * Adapter code only — app code never touches firebase-admin directly.
 */

const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1'

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

  constructor(private readonly env: Env) {}

  private auth() {
    return getAuth(getFirebaseAdminApp({ projectId: this.env.FIREBASE_PROJECT_ID }))
  }

  private async rest<T>(action: string, body: Record<string, unknown>): Promise<T> {
    if (!this.env.FIREBASE_API_KEY) {
      throw new Error('auth-not-configured')
    }
    const url = `${IDENTITY_TOOLKIT_URL}/accounts:${action}?key=${this.env.FIREBASE_API_KEY}`
    try {
      const response = await axios.post<T>(url, body)
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

  async createSessionFromIdToken(idToken: string, expiresInMs: number): Promise<AuthSession> {
    const cookie = await this.auth().createSessionCookie(idToken, { expiresIn: expiresInMs })
    const decoded = await this.auth().verifySessionCookie(cookie, false)
    return {
      cookie,
      user: {
        uid: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: decoded.email_verified === true,
      },
    }
  }

  async userFromSessionCookie(cookie: string): Promise<AuthUserInfo | null> {
    try {
      const decoded = await this.auth().verifySessionCookie(cookie, true)
      return {
        uid: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: decoded.email_verified === true,
      }
    } catch {
      return null
    }
  }

  async revokeSessionCookie(cookie: string): Promise<void> {
    try {
      const decoded = await this.auth().verifySessionCookie(cookie, false)
      await this.auth().revokeRefreshTokens(decoded.uid)
    } catch {
      /* best-effort — the client clears the cookie regardless */
    }
  }

  async register(
    email: string,
    password: string,
  ): Promise<{ user: AuthUserInfo; idToken: string }> {
    const data = await this.rest<{
      idToken?: string
      localId?: string
      email?: string
      emailVerified?: boolean
    }>('signUp', { email, password, returnSecureToken: true })
    if (!data.idToken) throw new Error('auth-failed')
    return { user: this.toUserInfo(data), idToken: data.idToken }
  }

  async login(email: string, password: string): Promise<{ user: AuthUserInfo; idToken: string }> {
    const data = await this.rest<{
      idToken?: string
      localId?: string
      email?: string
      emailVerified?: boolean
      registered?: boolean
    }>('signInWithPassword', { email, password, returnSecureToken: true })
    if (!data.idToken) throw new Error('auth-failed')
    return { user: this.toUserInfo(data), idToken: data.idToken }
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

export function createFirebaseAuthService(env: Env): AuthService {
  return new FirebaseAuthService(env)
}

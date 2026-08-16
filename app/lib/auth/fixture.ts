import { createHash, randomUUID } from 'node:crypto'
import type { AuthService, AuthSession, AuthUserInfo } from './types'

/**
 * FixtureAuthService — dev/e2e ONLY (GW_DEV_FIXTURES=1, ADR-004 pattern).
 * In-memory users; passwords are NEVER stored — only their SHA-256 digests
 * (C9 hard rule: no password material in storage, even dev fixtures).
 */
interface FixtureUser {
  uid: string
  email: string
  digest: string
  emailVerified: boolean
  verifyCode: string
}

function digest(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

/** Deterministic uid so fixture seed data can reference it. */
export function fixtureUidFor(email: string): string {
  return `fx-${createHash('sha256').update(email).digest('hex').slice(0, 12)}`
}

export class FixtureAuthService implements AuthService {
  readonly name = 'fixture'

  /** Dev/test hooks: the most recent oob codes (production never sees these). */
  lastResetCode: string | null = null
  lastVerifyCode: string | null = null

  private readonly users = new Map<string, FixtureUser>()
  private readonly sessions = new Map<string, string>()
  private readonly resetCodes = new Map<string, string>()

  private toUserInfo(user: FixtureUser): AuthUserInfo {
    return { uid: user.uid, email: user.email, emailVerified: user.emailVerified }
  }

  async createSessionFromIdToken(idToken: string): Promise<AuthSession> {
    const uid = idToken.startsWith('fx-id-') ? idToken.slice('fx-id-'.length) : ''
    const user = [...this.users.values()].find((candidate) => candidate.uid === uid)
    if (!user) throw new Error('INVALID_ID_TOKEN')
    const cookie = randomUUID()
    this.sessions.set(cookie, uid)
    return { cookie, user: this.toUserInfo(user) }
  }

  async userFromSessionCookie(cookie: string): Promise<AuthUserInfo | null> {
    const uid = this.sessions.get(cookie)
    if (!uid) return null
    const user = [...this.users.values()].find((candidate) => candidate.uid === uid)
    return user ? this.toUserInfo(user) : null
  }

  async revokeSessionCookie(cookie: string): Promise<void> {
    this.sessions.delete(cookie)
  }

  async register(
    email: string,
    password: string,
  ): Promise<{ user: AuthUserInfo; idToken: string }> {
    if (this.users.has(email)) throw new Error('EMAIL_EXISTS')
    const user: FixtureUser = {
      uid: fixtureUidFor(email),
      email,
      digest: digest(password),
      emailVerified: false,
      verifyCode: `verify-${randomUUID()}`,
    }
    this.users.set(email, user)
    this.lastVerifyCode = user.verifyCode
    return { user: this.toUserInfo(user), idToken: `fx-id-${user.uid}` }
  }

  async login(email: string, password: string): Promise<{ user: AuthUserInfo; idToken: string }> {
    const user = this.users.get(email)
    if (!user || user.digest !== digest(password)) throw new Error('INVALID_LOGIN_CREDENTIALS')
    return { user: this.toUserInfo(user), idToken: `fx-id-${user.uid}` }
  }

  async forgotPassword(email: string): Promise<void> {
    if (!this.users.has(email)) return // no account enumeration
    const code = `reset-${email}-${randomUUID().slice(0, 6)}`
    this.resetCodes.set(code, email)
    this.lastResetCode = code
  }

  async resetPassword(oobCode: string, newPassword: string): Promise<void> {
    const email = this.resetCodes.get(oobCode)
    const user = email ? this.users.get(email) : undefined
    if (!user) throw new Error('EXPIRED_OOB_CODE')
    user.digest = digest(newPassword)
    this.resetCodes.delete(oobCode)
  }

  async verifyEmail(oobCode: string): Promise<void> {
    const user = [...this.users.values()].find((candidate) => candidate.verifyCode === oobCode)
    if (!user) throw new Error('INVALID_OOB_CODE')
    user.emailVerified = true
  }
}

const FIXTURE_AUTH_KEY = Symbol.for('gw.fixture.auth.service')

/**
 * Singleton via globalThis: Turbopack dev can emit MULTIPLE module instances
 * (route handlers vs RSC pages) — a module-level variable would not be shared
 * and the session would be lost between endpoints.
 */
export function createFixtureAuthService(): AuthService {
  const store = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = store[FIXTURE_AUTH_KEY] as AuthService | undefined
  if (existing) return existing
  const service = new FixtureAuthService()
  store[FIXTURE_AUTH_KEY] = service
  return service
}

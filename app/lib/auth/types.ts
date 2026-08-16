/**
 * Auth service abstraction (Section 6B / Section 17) — the ONE auth contract
 * for app code. Firebase Auth is the current adapter (lib/auth/firebase.ts);
 * Supabase Auth can replace it later without touching app code.
 *
 * HARD RULES (C9): passwords exist ONLY in the in-flight request; nothing in
 * this interface receives or returns password material after the call —
 * adapters never persist or log it.
 */

export interface AuthUserInfo {
  uid: string
  email: string | null
  emailVerified: boolean
}

/** A user with roles loaded from the `users` collection (Section 17). */
export interface SessionUser extends AuthUserInfo {
  roles: string[]
}

export interface AuthSession {
  /** HttpOnly session-cookie value. */
  cookie: string
  user: AuthUserInfo
}

export interface AuthService {
  readonly name: string

  /** Exchange a Firebase client-SDK idToken for a server session cookie. */
  createSessionFromIdToken(idToken: string, expiresInMs: number): Promise<AuthSession>

  /** Resolve a session cookie to its user (null = anonymous/expired). */
  userFromSessionCookie(cookie: string): Promise<AuthUserInfo | null>

  /** Server-side revocation (refresh tokens) — cookie is cleared client-side. */
  revokeSessionCookie(cookie: string): Promise<void>

  /** Server-side register (identitytoolkit REST) → user + idToken. */
  register(email: string, password: string): Promise<{ user: AuthUserInfo; idToken: string }>

  /** Server-side login → user + idToken. */
  login(email: string, password: string): Promise<{ user: AuthUserInfo; idToken: string }>

  /** Password-reset email (oob code is delivered by the provider). */
  forgotPassword(email: string): Promise<void>

  /** Consume the reset oob code and set the new password. */
  resetPassword(oobCode: string, newPassword: string): Promise<void>

  /** Consume the email-verification oob code. */
  verifyEmail(oobCode: string): Promise<void>
}

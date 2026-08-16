import { z } from 'zod'

/**
 * Auth/session endpoint contract (Section 17) — session-cookie auth.
 * NO password material is persisted or logged anywhere; passwords exist
 * only in the in-flight request body (hard rule).
 *
 * POST /api/auth/session dispatches on a strict `action` field:
 *   login | register | logout | forgot | reset | verify
 * GET  /api/auth/session returns { user } | { user: null } (me).
 */
export const AUTH_EMAIL = z.string().trim().min(3).max(254)
export const AUTH_PASSWORD = z.string().min(6).max(128)

export const AuthLoginCallSchema = z
  .object({
    action: z.literal('login'),
    email: AUTH_EMAIL,
    password: AUTH_PASSWORD,
    gw_hp: z.string().optional(),
  })
  .strict()

export const AuthRegisterCallSchema = z
  .object({
    action: z.literal('register'),
    email: AUTH_EMAIL,
    password: AUTH_PASSWORD,
    name: z.string().max(200).optional(),
    gw_hp: z.string().optional(),
  })
  .strict()

export const AuthLogoutCallSchema = z
  .object({
    action: z.literal('logout'),
    gw_hp: z.string().optional(),
  })
  .strict()

export const AuthForgotCallSchema = z
  .object({
    action: z.literal('forgot'),
    email: AUTH_EMAIL,
    gw_hp: z.string().optional(),
  })
  .strict()

export const AuthResetCallSchema = z
  .object({
    action: z.literal('reset'),
    oobCode: z.string().min(1).max(4096),
    password: AUTH_PASSWORD,
    gw_hp: z.string().optional(),
  })
  .strict()

export const AuthVerifyCallSchema = z
  .object({
    action: z.literal('verify'),
    oobCode: z.string().min(1).max(4096),
    gw_hp: z.string().optional(),
  })
  .strict()

export const AuthSessionCallSchema = z.discriminatedUnion('action', [
  AuthLoginCallSchema,
  AuthRegisterCallSchema,
  AuthLogoutCallSchema,
  AuthForgotCallSchema,
  AuthResetCallSchema,
  AuthVerifyCallSchema,
])

export type AuthSessionCall = z.infer<typeof AuthSessionCallSchema>

/** Account resource names (Section 32) — the ONLY resources this route serves. */
export const ACCOUNT_RESOURCES = ['profile', 'orders', 'tickets', 'bookings'] as const

export const AccountResourceSchema = z.enum(ACCOUNT_RESOURCES)

export type AccountResource = z.infer<typeof AccountResourceSchema>

/** Users-collection doc (Uniconhub admin schema) — roles live here. */
export const UserDocSchema = z
  .object({
    uid: z.string().min(1),
    email: z.string().optional(),
    name: z.string().optional(),
    roles: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
  })
  .catchall(z.unknown())

export type UserDoc = z.infer<typeof UserDocSchema>

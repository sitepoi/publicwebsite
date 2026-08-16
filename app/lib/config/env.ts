import { z } from 'zod'

/**
 * Environment contract (Section 22) — validated with Zod, fail fast at boot.
 *
 * `instrumentation.ts` runs `validateEnv(process.env)` when the server boots;
 * an invalid or missing variable aborts startup with a readable report.
 *
 * Required here = the platform cannot serve without them (firebase-admin
 * bootstrapping, relay, revalidation, form rate limits).
 *
 * Feature-gated secrets are OPTIONAL: their features are per-tenant/per-folder
 * config (reCAPTCHA per folder — Section 14; SES email via operation hooks —
 * Section 15; IndexNow ping on publish — Section 16; Sentry optional —
 * Section 20). When absent the feature is disabled. (ADR-001)
 *
 * Per-tenant env convention (Section 22), consumed by
 * lib/firestore/admin-app.ts:
 *
 *   <PROJECTID_WITH_UNDERSCORES>_firebase_admin_{project_id,private_key,client_email}
 *   <TENANT>_STRIPE_{SECRET,WEBHOOK_SECRET,PUBLISHABLE}
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_APP_NAME: z.string().min(1),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().min(1),
  RELAY_SECRET: z.string().min(1),
  FORMS_RATE_LIMIT_MAX: z.coerce.number().int().positive(),
  FORMS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive(),
  RECAPTCHA_SITE_KEY: z.string().optional(),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
  SES_ACCESS_KEY_ID: z.string().optional(),
  SES_SECRET_ACCESS_KEY: z.string().optional(),
  SES_REGION: z.string().optional(),
  SES_FROM_ADDRESS: z.string().optional(),
  // Global fallbacks for the `<TENANT>_STRIPE_*` env convention (Section 15);
  // per-tenant keys are read dynamically (lib/pay/index.ts).
  STRIPE_SECRET: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Firebase web API key — server-side Identity Toolkit REST calls for auth
  // (register/login/password-reset/verify — Section 17 / C9). Optional:
  // without it the auth endpoints answer 503 auth-not-configured.
  FIREBASE_API_KEY: z.string().optional(),
  REVALIDATE_SECRET: z.string().min(1),
  INDEXNOW_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  // Dev-only: '1' serves the in-memory fixture site instead of Firestore
  // (C4 deliverable, lib/data/providers/fixtures — never in production).
  GW_DEV_FIXTURES: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export function validateEnv(raw: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(
      `Invalid environment configuration (Section 22). Fix your env vars:\n${details}`,
    )
  }
  return result.data
}

let cached: Env | null = null

/** Validated env, cached per process. Throws (fail fast) when invalid. */
export function getEnv(): Env {
  if (!cached) cached = validateEnv(process.env)
  return cached
}

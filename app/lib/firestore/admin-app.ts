import { cert, initializeApp, type App } from 'firebase-admin/app'

/**
 * Tenant → firebase-admin app factory (Sections 6 / 6B / 22).
 *
 * IMPORTANT (Section 6B hard rule): this module is imported ONLY by the
 * Firestore provider adapter (lib/data/providers/firestore/). App code never
 * touches the Firebase SDK directly — everything goes through the DataProvider
 * interface.
 *
 * Credentials are ENV-ONLY. Per-tenant env convention (Section 22):
 *
 *   <PROJECTID_WITH_UNDERSCORES>_firebase_admin_{project_id,private_key,client_email}
 *
 * The prefix PRESERVES CASE (Section 6.3, D-DWH-16 C-06): Firebase project ids
 * are lowercase and the deployment env follows them exactly - never uppercase.
 *
 * Example for project `website-builder`:
 *   website_builder_firebase_admin_project_id
 *   website_builder_firebase_admin_private_key
 *   website_builder_firebase_admin_client_email
 */
export interface FirebaseAdminConfig {
  projectId: string
  clientEmailEnv?: string
  privateKeyEnv?: string
}

export interface FirebaseAdminEnvNames {
  projectIdEnv: string
  privateKeyEnv: string
  clientEmailEnv: string
}

export function firebaseAdminEnvNames(projectId: string): FirebaseAdminEnvNames {
  // Preserve case (Section 6.3 / D-DWH-16): the deployment env uses the
  // project id's own casing. Non-alphanumerics become underscores.
  const prefix = projectId.replace(/[^A-Za-z0-9]+/g, '_')
  return {
    projectIdEnv: `${prefix}_firebase_admin_project_id`,
    privateKeyEnv: `${prefix}_firebase_admin_private_key`,
    clientEmailEnv: `${prefix}_firebase_admin_client_email`,
  }
}

function readEnv(name: string | undefined): string | undefined {
  if (!name) return undefined
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

/**
 * Repair common deployment-env corruptions of PEM private keys before they
 * reach firebase-admin's cert(): deployment dashboards often store the key
 * as one line with literal `\n` escapes (or wrapped in quotes), which makes
 * OpenSSL fail with "DECODER routines::unsupported" (ERR_OSSL_UNSUPPORTED).
 */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim()
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim()
  }
  // Single-line PEM with literal \n escapes → real newlines.
  if (!key.includes('\n') && key.includes('\\n')) {
    key = key.replace(/\\n/g, '\n')
  }
  // Windows line endings → LF, and drop a trailing newline (optional for PEM).
  return key.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
}

export interface ResolvedFirebaseAdminCredentials {
  projectId: string
  clientEmail: string
  privateKey: string
}

export function resolveFirebaseAdminCredentials(
  config: FirebaseAdminConfig,
): ResolvedFirebaseAdminCredentials {
  const names = firebaseAdminEnvNames(config.projectId)
  const clientEmail =
    readEnv(config.clientEmailEnv) ??
    readEnv(names.clientEmailEnv) ??
    readEnv('FIREBASE_ADMIN_CLIENT_EMAIL')
  const privateKey =
    readEnv(config.privateKeyEnv) ??
    readEnv(names.privateKeyEnv) ??
    readEnv('FIREBASE_ADMIN_PRIVATE_KEY')
  const projectId = readEnv(names.projectIdEnv) ?? config.projectId

  if (!clientEmail) {
    throw new Error(
      `Missing Firebase admin client email for project '${config.projectId}' — ` +
        `set env var ${names.clientEmailEnv} or FIREBASE_ADMIN_CLIENT_EMAIL (Section 22)`,
    )
  }
  if (!privateKey) {
    throw new Error(
      `Missing Firebase admin private key for project '${config.projectId}' — ` +
        `set env var ${names.privateKeyEnv} or FIREBASE_ADMIN_PRIVATE_KEY (Section 22)`,
    )
  }
  const normalizedPrivateKey = normalizePrivateKey(privateKey)
  if (normalizedPrivateKey !== privateKey) {
    console.warn(
      `[firebase-admin] private key env var for project '${config.projectId}' ` +
        `was repaired (literal \\n escapes, quotes, or CRLF found) — please store it ` +
        `with real newlines in the deployment env to remove this warning`,
    )
  }
  return { projectId, clientEmail, privateKey: normalizedPrivateKey }
}

const apps = new Map<string, App>()

/** Cached, lazy firebase-admin app per tenant project. */
export function getFirebaseAdminApp(config: FirebaseAdminConfig): App {
  const existing = apps.get(config.projectId)
  if (existing) return existing

  const credentials = resolveFirebaseAdminCredentials(config)
  const app = initializeApp(
    {
      credential: cert(credentials),
      projectId: credentials.projectId,
    },
    config.projectId,
  )
  apps.set(config.projectId, app)
  return app
}

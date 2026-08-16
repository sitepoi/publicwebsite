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
 * Example for project `website-builder`:
 *   WEBSITE_BUILDER_firebase_admin_project_id
 *   WEBSITE_BUILDER_firebase_admin_private_key
 *   WEBSITE_BUILDER_firebase_admin_client_email
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
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
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
  return { projectId, clientEmail, privateKey }
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

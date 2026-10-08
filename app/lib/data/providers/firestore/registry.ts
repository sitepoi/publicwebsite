import { getFirestore } from 'firebase-admin/firestore'
import { getFirebaseAdminApp } from '@/lib/firestore/admin-app'
import { decodeLegacyRelayBase64, parseTenantConfig, type TenantLookup } from '@/lib/resolver/tenant'
import { hostMatches, normalizeHost } from '@/lib/resolver/host'

/**
 * Legacy hostname → tenant registry (Section 6.2, D-DWH-10): the
 * `sitepoi-relay` project's `applications` collection - one doc per
 * application with `hostNames[]` + `fbSettings.base64`. Read SERVER-SIDE
 * with firebase-admin credentials for the registry project (env convention
 * `<PROJECTID_WITH_UNDERSCORES>_firebase_admin_*`, case preserved - 6.3).
 *
 * Adapter-only: this module lives inside the Firestore provider folder and is
 * wired in by lib/resolver/index.ts; app code never imports firebase-admin
 * directly (Section 6B hard rule).
 */
export const RELAY_REGISTRY_PROJECT_ID = 'sitepoi-relay'
export const RELAY_APPLICATIONS_COLLECTION = 'applications'

/**
 * Project id of the registry read: the legacy env name
 * SITEPOI_RELAY_PROJECT_ID wins (the user's existing convention), the
 * constant is the fallback. The relay is ONE database - it only maps
 * hostname → tenant database config, never per-tenant.
 */
export function relayRegistryProjectId(): string {
  const fromEnv = process.env.SITEPOI_RELAY_PROJECT_ID
  return fromEnv && fromEnv.length > 0 ? fromEnv : RELAY_REGISTRY_PROJECT_ID
}

interface RelayApplicationDoc {
  hostNames?: unknown
  fbSettings?: unknown
}

export function createSitepoiRegistryLookup(): TenantLookup {
  return async (host) => {
    const normalized = normalizeHost(host)
    if (!normalized) return null

    const db = getFirestore(getFirebaseAdminApp({ projectId: relayRegistryProjectId() }))
    const snap = await db.collection(RELAY_APPLICATIONS_COLLECTION).get()
    for (const doc of snap.docs) {
      const data = doc.data() as RelayApplicationDoc
      const hostNames = Array.isArray(data.hostNames)
        ? data.hostNames.filter((entry): entry is string => typeof entry === 'string')
        : []
      if (!hostNames.some((pattern) => hostMatches(normalized, pattern))) continue

      const fbSettings = (data.fbSettings ?? {}) as Record<string, unknown>
      const encoded = typeof fbSettings.base64 === 'string' ? fbSettings.base64 : ''
      if (encoded.length === 0) continue

      const raw = decodeLegacyRelayBase64(encoded)
      if (raw === undefined) {
        console.warn(
          `[resolver] legacy relay config for host '${normalized}' is invalid or missing authTenant — skipped`,
        )
        continue
      }
      const tenant = parseTenantConfig(raw, normalized)
      if (tenant) return tenant
    }
    return null
  }
}

/**
 * All hostNames currently registered in the sitepoi-relay applications store
 * (used by the onboarding verification gate V-01). Read-only.
 */
export async function listRelayApplicationHostNames(): Promise<string[]> {
  const db = getFirestore(getFirebaseAdminApp({ projectId: relayRegistryProjectId() }))
  const snap = await db.collection(RELAY_APPLICATIONS_COLLECTION).get()
  return snap.docs.flatMap((doc) => {
    const hostNames = (doc.data() as RelayApplicationDoc).hostNames
    return Array.isArray(hostNames)
      ? hostNames.filter((entry): entry is string => typeof entry === 'string')
      : []
  })
}

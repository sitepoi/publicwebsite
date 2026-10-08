import axios from 'axios'
import type { DataProvider } from '@/lib/data/provider'
import { firebaseAdminEnvNames } from '@/lib/firestore/admin-app'
import { normalizeHost } from '@/lib/resolver/host'
import type { TenantCreationRequest } from './contracts'
import { verifyTenantOnboarding, type OnboardingCheck } from './verify'

/**
 * Tenant creation service (SSOT D-DWH-11 / section 8, T-12/T-13) - a
 * re-implementation of the legacy flow with the same shapes and endpoints:
 *
 *   1. create-only pre-checks (D-DWH-15) - never overwrite existing docs
 *   2. CMS system endpoints: CTGC (tenant) → CUGC (admin user) → CNA (relay
 *      applications entry, non-fatal)
 *   3. Firestore writes: website-settings + admin user + cms-settings
 *      (objectTypes with capabilities) - same doc-id / _id / tenantId shapes
 *      as the legacy flow (Section 6.11)
 *   4. NEW site skeleton (D-DWH-14): website folder + default-settings
 *      (hostNames from input) + home-page stub
 *   5. cache purge + the 6.10 verification checklist (T-14)
 */

export const DEFAULT_CMS_BASE_URL = 'https://cms.uniconhub.com'
export const DEFAULT_APP_ID = 'website-builder-uniconbaseapps'

const WEBSITE_SETTINGS_DOC_PREFIX = 'website-settings'
const CMS_SETTINGS_DOC_PREFIX = 'cms-settings'
const USERS_COLLECTION = 'users'
const OBJECT_TYPES_COLLECTION = 'om_object_types'
const OBJECTS_COLLECTION = 'om_objects'
const DEFAULT_SETTINGS_SLUG = 'default-settings'
const HOME_PAGE_SLUG = 'home-page'

export interface TenantCreationDeps {
  provider: DataProvider
  tableExtension?: string
  cmsApiKey?: string
  projectId?: string
  developerEmail?: string
  /** Test seam for the CMS system endpoints (paths like /api/system/.../ctgc/...). */
  cmsCall?: (path: string) => Promise<unknown>
  resolveTenantForHost?: (host: string) => Promise<{ tenantId?: string } | null>
  registryHostNames?: () => Promise<string[]>
  purge?: (hostNames: string[], folderId: string) => Promise<{ ok: boolean; detail: string }>
  runLiveChecks?: boolean
  now?: () => Date
}

export type TenantCreationResult =
  | {
      ok: true
      tenantId: string
      folderId: string
      appId: string
      authTenantId: string
      adminUid: string
      hostNames: string[]
      envVarNames: string[]
      verification: OnboardingCheck[]
      purge: { ok: boolean; detail: string }
    }
  | {
      ok: false
      error: 'already-exists' | 'cms-unavailable' | 'cms-error' | 'write-failed'
      existing?: string[]
      detail?: string
    }

/** Encode the CMS system API key for URL-path usage (same as the legacy flow). */
export function encodeCmsApiKey(apiKey: string): string {
  const rawApiKey = apiKey.replace(/%7B/g, '{').replace(/%7D/g, '}')
  return rawApiKey.replace(/\{/g, '%7B').replace(/\}/g, '%7D')
}

/** Real CMS endpoint caller (GET with 30 s timeout) - routes wire this in. */
export function defaultCmsCall(cmsBaseUrl: string): (path: string) => Promise<unknown> {
  return async (path: string): Promise<unknown> => {
    const response = await axios.get(`${cmsBaseUrl}${path}`, { timeout: 30000 })
    return response.data
  }
}

export async function createTenant(
  input: TenantCreationRequest,
  deps: TenantCreationDeps,
): Promise<TenantCreationResult> {
  const now = deps.now ?? (() => new Date())
  const provider = deps.provider
  const tableExtension = deps.tableExtension ?? ''
  const projectId = deps.projectId ?? ''

  const tenantId = input.tenantId.trim().toLowerCase()
  const hostNames = input.hostNames
    .map((host) => normalizeHost(host))
    .filter((host): host is string => host !== null)
  const primaryHost = (input.primaryHost ? normalizeHost(input.primaryHost) : null) ?? hostNames[0]
  const appIds = input.appIds && input.appIds.length > 0 ? input.appIds : [DEFAULT_APP_ID]
  const appId = appIds[0]
  const folderId = `${tenantId}-site`

  const settingsCollection = `settings${tableExtension}`
  const usersCollection = `${USERS_COLLECTION}${tableExtension}`

  // ── 1. Create-only pre-checks (D-DWH-15) ────────────────────────────────
  const existing: string[] = []
  const existingDocCandidates: Array<{ collection: string; id: string; label: string }> = [
    {
      collection: settingsCollection,
      id: `${WEBSITE_SETTINGS_DOC_PREFIX}-${tenantId}`,
      label: 'website-settings',
    },
    {
      collection: settingsCollection,
      id: `${CMS_SETTINGS_DOC_PREFIX}-${tenantId}`,
      label: 'cms-settings',
    },
    { collection: usersCollection, id: `${input.adminEmail}-${tenantId}`, label: 'admin user' },
  ]
  for (const candidate of existingDocCandidates) {
    const doc = await provider.getRecord({ collection: candidate.collection, id: candidate.id })
    if (doc) existing.push(candidate.label)
  }

  const defaultsQuery = await provider.queryObjects({
    cmsObjectType: appId,
    filters: [{ field: 'slug', op: '==', value: DEFAULT_SETTINGS_SLUG }],
    pageSize: 200,
  })
  const existingSiteSettings = defaultsQuery.items.find((record) => {
    const data = (record.data ?? {}) as Record<string, unknown>
    const names = Array.isArray(data['hostNames']) ? data['hostNames'] : []
    return hostNames.some((host) =>
      names.some((name) => typeof name === 'string' && name === host),
    )
  })
  if (existingSiteSettings) existing.push('default-settings')

  if (existing.length > 0) {
    return { ok: false, error: 'already-exists', existing }
  }

  // ── 2. CMS system endpoints (D-DWH-11) ──────────────────────────────────
  if (!deps.cmsCall) {
    return {
      ok: false,
      error: 'cms-unavailable',
      detail: 'CMS system API key is not configured (CMS_API_KEY env).',
    }
  }
  const encodedApiKey = encodeCmsApiKey(deps.cmsApiKey ?? '')

  let authTenantId: string
  try {
    const ctgcResponse = await deps.cmsCall(
      `/api/system/${encodedApiKey}/ctgc/${tenantId}/${projectId}`,
    )
    authTenantId = (ctgcResponse as { contents?: { tenantId?: unknown } })?.contents?.tenantId as string
    if (typeof authTenantId !== 'string' || authTenantId.length === 0) {
      return { ok: false, error: 'cms-error', detail: 'Unexpected response from platform service (CTGC).' }
    }
  } catch {
    return {
      ok: false,
      error: 'cms-error',
      detail: 'The platform creation service is temporarily unavailable. Please try again later.',
    }
  }

  const encodedPassword = Buffer.from(input.adminPassword).toString('base64')
  let adminUid: string
  try {
    const cugcResponse = await deps.cmsCall(
      `/api/system/${encodedApiKey}/cugc/${authTenantId}/${projectId}/${encodeURIComponent(input.adminEmail)}/${encodedPassword}`,
    )
    adminUid = (cugcResponse as { contents?: { uid?: unknown } })?.contents?.uid as string
    if (typeof adminUid !== 'string' || adminUid.length === 0) {
      return { ok: false, error: 'cms-error', detail: 'Unexpected response while creating admin account (CUGC).' }
    }
  } catch {
    return { ok: false, error: 'cms-error', detail: 'Failed to create admin account. Please try again later.' }
  }

  // CNA - relay applications entry - non-fatal (same as the legacy flow).
  try {
    await deps.cmsCall(`/api/relay/${encodedApiKey}/cna/${authTenantId}/${projectId}`)
  } catch {
    /* non-fatal: the registry entry is written CMS-side on success only */
  }

  // ── 3. Firestore writes (Section 6.11 shapes, create-only) ──────────────
  const timestamp = now().toISOString()
  try {
    const websiteSettingsDocId = `${WEBSITE_SETTINGS_DOC_PREFIX}-${tenantId}`
    await provider.createRecord({
      collection: settingsCollection,
      id: websiteSettingsDocId,
      data: {
        _id: 'website-settings',
        cmsParams: {
          cacheStatus: 'disabled',
          onlineStorageFolder: tenantId.toUpperCase(),
          subdomain: tenantId,
        },
        dbSettings: { gCloudServerLocation: 'us-central1', projectName: projectId },
        defaults: { language: input.defaultLanguage ?? 'en' },
        docId: websiteSettingsDocId,
        emails: { contact: '' },
        images: {
          favIconSet: { favicon: '' },
          fullLogo: '',
          fullLogoSize: { height: 100, width: 400 },
          onlyLogo: '',
        },
        links: {
          facebook: '',
          instagram: '',
          linkedin: '',
          twitter: '',
          youtube: '',
          website: '',
        },
        tenantId,
        texts: { companyName: tenantId },
      },
    })

    const adminUserDocId = `${input.adminEmail}-${tenantId}`
    await provider.createRecord({
      collection: usersCollection,
      id: adminUserDocId,
      data: {
        docId: adminUserDocId,
        email: input.adminEmail,
        roles: ['admin'],
        tenantId,
        created: timestamp,
        updated: timestamp,
      },
    })

    if (deps.developerEmail) {
      const developerDocId = `${deps.developerEmail}-${tenantId}`
      await provider.createRecord({
        collection: usersCollection,
        id: developerDocId,
        data: {
          docId: developerDocId,
          email: deps.developerEmail,
          roles: ['admin', 'developer'],
          tenantId,
          created: timestamp,
          updated: timestamp,
        },
      })
    }

    const cmsSettingsDocId = `${CMS_SETTINGS_DOC_PREFIX}-${tenantId}`
    await provider.createRecord({
      collection: settingsCollection,
      id: cmsSettingsDocId,
      data: {
        _id: 'cms-settings',
        docId: cmsSettingsDocId,
        tenantId,
        objectTypes: appIds.map((registeredAppId) => ({
          schemaVersion: '1',
          id: registeredAppId,
          capabilities: ['website'],
          useFromRemote: 'yes',
          disabled: false,
        })),
      },
    })

    // NEW site skeleton (D-DWH-14 / section 8 step 5): folder, settings, home.
    await provider.createRecord({
      collection: `${OBJECT_TYPES_COLLECTION}${tableExtension}`,
      id: folderId,
      data: {
        slug: tenantId,
        mainObjectType: appId,
        name: `${tenantId} website`,
        tenantId,
      },
    })

    await provider.createRecord({
      collection: `${OBJECTS_COLLECTION}${tableExtension}`,
      data: {
        name: 'Site settings',
        slug: DEFAULT_SETTINGS_SLUG,
        typeId: folderId,
        cmsObjectType: appId,
        tenantId,
        meta: {},
        data: {
          hostNames,
          primaryHost,
          defaultLanguage: input.defaultLanguage ?? 'en',
          ...(input.previewSecret ? { previewSecret: input.previewSecret } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
        },
      },
    })

    await provider.createRecord({
      collection: `${OBJECTS_COLLECTION}${tableExtension}`,
      data: {
        name: 'Home',
        slug: HOME_PAGE_SLUG,
        typeId: folderId,
        cmsObjectType: appId,
        tenantId,
        meta: { language: input.defaultLanguage ?? 'en' },
        data: {
          htmlPage: {
            code: {
              html: `<main><h1>${tenantId}</h1><p>Website created - edit this page in the CMS.</p></main>`,
              css: '',
              js: '',
            },
          },
        },
      },
    })
  } catch (error) {
    return {
      ok: false,
      error: 'write-failed',
      detail: error instanceof Error ? error.message : 'Failed to save tenant configuration.',
    }
  }

  // ── 4. Purge + verification (T-14) ──────────────────────────────────────
  const purgeResult = deps.purge
    ? await deps.purge(hostNames, folderId)
    : { ok: false, detail: 'purge not configured' }

  const verification = await verifyTenantOnboarding({
    hostNames,
    tenantId,
    appId,
    provider,
    resolveTenantForHost: deps.resolveTenantForHost,
    registryHostNames: deps.registryHostNames,
    runLiveChecks: deps.runLiveChecks ?? false,
  })

  const envVarNames = [
    firebaseAdminEnvNames(projectId).projectIdEnv,
    firebaseAdminEnvNames(projectId).privateKeyEnv,
    firebaseAdminEnvNames(projectId).clientEmailEnv,
  ]

  return {
    ok: true,
    tenantId,
    folderId,
    appId,
    authTenantId,
    adminUid,
    hostNames,
    envVarNames,
    verification,
    purge: purgeResult,
  }
}

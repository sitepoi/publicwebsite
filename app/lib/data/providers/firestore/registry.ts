import { decodeLegacyRelayBase64, parseTenantConfig, type TenantLookup } from '@/lib/resolver/tenant'
import { hostMatches, normalizeHost } from '@/lib/resolver/host'

/**
 * Legacy hostname → tenant registry (Section 6.2, D-DWH-10, D-DWH-20): the
 * `sitepoi-relay` project's `applications` collection - one doc per
 * application with `hostNames[]` + `fbSettings.base64`.
 *
 * Read SERVER-SIDE with the legacy CLIENT config (SITEPOI_RELAY_*) over the
 * Firestore REST API - the same unauthenticated read the legacy
 * generalwebsite performed with the Firebase client SDK. NO admin
 * credentials are required or exist for this project; Firestore security
 * rules gate the read exactly as they did in legacy (D-DWH-20).
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

/** Legacy client API key (Firebase web API key) for the registry project. */
function relayRegistryApiKey(): string | undefined {
  const fromEnv = process.env.SITEPOI_RELAY_APIKEY
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined
}

export interface RelayApplicationDoc {
  /** Full REST resource name of the document (diagnostics). */
  name?: string
  hostNames?: unknown
  fbSettings?: unknown
}

type FirestoreFieldValue = Record<string, unknown>

/**
 * Decode a Firestore REST value: values come wrapped in a type-tagged object
 * ({stringValue}, {integerValue}, {arrayValue}, {mapValue}, ...). Recurses
 * into arrays and maps.
 */
export function decodeFirestoreFieldValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const entry = value as FirestoreFieldValue
  if ('stringValue' in entry) return entry.stringValue
  if ('booleanValue' in entry) return entry.booleanValue
  if ('integerValue' in entry) return Number(entry.integerValue)
  if ('doubleValue' in entry) return entry.doubleValue
  if ('nullValue' in entry) return null
  if ('timestampValue' in entry) return entry.timestampValue
  if ('arrayValue' in entry) {
    const values = (entry.arrayValue as { values?: unknown[] } | undefined)?.values ?? []
    return values.map(decodeFirestoreFieldValue)
  }
  if ('mapValue' in entry) {
    const fields =
      (entry.mapValue as { fields?: Record<string, unknown> } | undefined)?.fields ?? {}
    return decodeFirestoreFields(fields)
  }
  return value
}

/** Decode a Firestore REST document's fields map into a plain record. */
export function decodeFirestoreFields(fields: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [name, fieldValue] of Object.entries(fields)) {
    decoded[name] = decodeFirestoreFieldValue(fieldValue)
  }
  return decoded
}

/**
 * List all `applications` docs via the Firestore REST API with the legacy
 * client apiKey. Mirrors the legacy generalwebsite read
 * (pages/api/relay/[...param].js), which used the Firebase client SDK -
 * both are unauthenticated reads evaluated by the project's security rules.
 */
export async function fetchRelayApplications(
  fetcher: typeof fetch | undefined = undefined,
): Promise<RelayApplicationDoc[]> {
  const projectId = relayRegistryProjectId()
  const apiKey = relayRegistryApiKey()
  if (!apiKey) {
    throw new Error(
      `Missing SITEPOI_RELAY_APIKEY — the hostname registry read needs the legacy ` +
        `client api key for project '${projectId}' (D-DWH-20, Section 6.3)`,
    )
  }
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/` +
    `${RELAY_APPLICATIONS_COLLECTION}?key=${encodeURIComponent(apiKey)}&pageSize=300`
  const response = await (fetcher ?? fetch)(url, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(
      `Relay registry read failed (${response.status}) for project '${projectId}' — ` +
        `check SITEPOI_RELAY_APIKEY and the Firestore security rules of the ` +
        `applications collection (D-DWH-20)`,
    )
  }
  const body = (await response.json()) as {
    documents?: Array<{ name?: string; fields?: Record<string, unknown> }>
  }
  return (body.documents ?? []).map((document): RelayApplicationDoc => {
    const data = document.fields ? decodeFirestoreFields(document.fields) : {}
    return {
      name: document.name,
      hostNames: data.hostNames,
      fbSettings: data.fbSettings,
    }
  })
}

interface RelayApplicationsCacheEntry {
  at: number
  docs: RelayApplicationDoc[]
}

const RELAY_CACHE_TTL_MS = 60_000
let relayApplicationsCache: RelayApplicationsCacheEntry | null = null

/** Cached (60s TTL) read of the registry applications store. */
export async function listRelayApplications(): Promise<RelayApplicationDoc[]> {
  if (relayApplicationsCache && Date.now() - relayApplicationsCache.at < RELAY_CACHE_TTL_MS) {
    return relayApplicationsCache.docs
  }
  const docs = await fetchRelayApplications()
  relayApplicationsCache = { at: Date.now(), docs }
  return docs
}

/** Reset the registry cache (tests, publish purge). */
export function clearRelayApplicationsCache(): void {
  relayApplicationsCache = null
}

export function createSitepoiRegistryLookup(): TenantLookup {
  return async (host) => {
    const normalized = normalizeHost(host)
    if (!normalized) return null

    let docs: RelayApplicationDoc[]
    try {
      docs = await listRelayApplications()
    } catch (error) {
      console.error(
        `[resolver] relay registry read failed for host '${normalized}' — treated as ` +
          `no registry entry:`,
        error,
      )
      return null
    }

    const exactMatches: RelayApplicationDoc[] = []
    const wildcardMatches: RelayApplicationDoc[] = []
    for (const doc of docs) {
      const hostNames = Array.isArray(doc.hostNames)
        ? doc.hostNames.filter((entry): entry is string => typeof entry === 'string')
        : []
      if (hostNames.some((pattern) => pattern === normalized)) {
        exactMatches.push(doc)
      } else if (hostNames.some((pattern) => hostMatches(normalized, pattern))) {
        wildcardMatches.push(doc)
      }
    }
    if (exactMatches.length + wildcardMatches.length > 1) {
      console.warn(
        `[resolver] host '${normalized}' matches ${exactMatches.length + wildcardMatches.length} ` +
          `registry docs (${exactMatches.length} exact) — exact matches win: ` +
          [...exactMatches, ...wildcardMatches]
            .map((doc) => doc.name ?? '(unnamed doc)')
            .join(', '),
      )
    }

    // An exact hostNames entry wins over *.wildcard entries (Section 6.2);
    // invalid/missing configs fall through to the next match.
    for (const doc of [...exactMatches, ...wildcardMatches]) {
      const fbSettings = (doc.fbSettings ?? {}) as Record<string, unknown>
      const encoded = typeof fbSettings.base64 === 'string' ? fbSettings.base64 : ''
      if (encoded.length === 0) continue

      const raw = decodeLegacyRelayBase64(encoded)
      if (raw === undefined) {
        console.warn(
          `[resolver] legacy relay config for host '${normalized}' (doc ` +
            `${doc.name ?? '(unnamed)'}) is invalid or missing authTenant — skipped`,
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
  const docs = await listRelayApplications()
  return docs.flatMap((doc) => {
    const hostNames = doc.hostNames
    return Array.isArray(hostNames)
      ? hostNames.filter((entry): entry is string => typeof entry === 'string')
      : []
  })
}

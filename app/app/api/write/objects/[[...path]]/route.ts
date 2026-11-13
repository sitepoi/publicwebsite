import { NextResponse, type NextRequest } from 'next/server'
import { getLogger, newRequestId } from '@/lib/log/logger'
import { resolveCmsServiceConfig } from '@/lib/server/cmsServiceConfig'
import {
  getFirstPartyCredentialResolver,
  type FirstPartyCredentialResolver,
} from '@/lib/server/cmsFirstPartyCredentials'
import {
  callCmsService,
  CMS_RATE_LIMIT_HEADERS,
  readCmsErrorInfo,
} from '@/lib/server/cmsServiceFetch'
import {
  CAS_CONFLICT_MESSAGE,
  CMS_RELAY_DEFAULT_RATE_LIMIT_BACKOFF_MS,
  mapCmsFailure,
  normalizePublicWritePayload,
  summarizeCmsBodyShape,
} from '@/lib/server/cmsRelay'

/**
 * POST/PATCH/PUT /api/write/objects/<type>[/<id>] — same-origin WRITE relay
 * for widget write-back (SSOT section 8.9, D-WFLOW-41, task T-43).
 *
 * Widgets NEVER touch Firestore and NEVER hold API keys: this route injects
 * the site's tenant-scoped RESTRICTED write key server-side (scope
 * `objects:write`, per-key `allowedObjectTypes`, rate limits + quotas) and
 * forwards to the CMS v2 object endpoints with the header
 * `x-unicon-write-source: public-website`. The CMS applies the source-based
 * protection for that header: payload sanitization, the `_writeSource`
 * ownership marker and delete refusal. The key IS the gate — a CMS 403/429
 * response passes through unchanged so the widget can surface it.
 *
 * Key model (D-WFLOW-43, T-46): the key is resolved per request from the
 * site's `websiteConfig.writeGrants` (keys referenced BY NAME; the secret
 * is fetched from the CMS key-lookup endpoint with the platform credential
 * GW_CMS_KEY_LOOKUP_API_KEY, cached 60 s). Sites without writeGrants fall
 * back to the legacy global GW_CMS_WRITE_API_KEY. Same-tenant for now:
 * the lookup sends the site's own tenant as x-source-tenant; cross-tenant
 * targetTenant routing waits on the CMS endpoint (T-47).
 *
 * - POST  /api/write/objects/<type>            create (Idempotency-Key forwarded)
 * - PATCH /api/write/objects/<type>/<id>       update (body.version → CAS)
 * - DELETE                                     403 PUBLIC_WRITE_DELETE_NOT_ALLOWED
 */

export const dynamic = 'force-dynamic'

const DEFAULT_CMS_WRITE_API_URL = 'https://cms.uniconhub.com/api/v2'
const FETCH_TIMEOUT_MS = 15_000
const KEY_LOOKUP_CACHE_TTL_MS = 60_000

/** D-WFLOW-43 outbound grant: a key THIS site may use, referenced BY NAME
 * (the secret stays in the CMS). `targetTenant` omitted = the site's own
 * tenant (same-tenant cross-app writes). `objectTypes` = covered types.
 * `cmsBaseUrl` = the target tenant's CMS v2 host (the v2 API is
 * tenant-scoped by HOST - Q-43); omitted = the site cmsApiBaseUrl. */
export interface WriteGrant {
  targetTenant?: string
  keyName: string
  objectTypes: string[]
  cmsBaseUrl?: string
}

export interface WidgetWriteSite {
  ok: boolean
  folderId: string
  tenant: string
  cmsApiBaseUrl: string
  writeGrants: WriteGrant[]
}

export interface WidgetWriteDeps {
  baseUrl?: string
  /** Test/dep override: skip the whole key-resolution step. */
  apiKey?: string
  fetchFn?: typeof fetch
  resolveSite?: (host: string) => Promise<WidgetWriteSite>
  sessionEmail?: (cookieHeader: string | null, host: string) => Promise<string | null>
  /** In-memory key-secret cache (60 s TTL). Inject a fresh Map in tests. */
  keyLookupCache?: Map<string, { secret: string; expiresAt: number }>
  /** Force first-party service auth (runtime-fetch) on/off. Default: on when
   * the global CMS_SERVICE_* configuration is complete. */
  serviceAuth?: boolean
  env?: Record<string, string | undefined>
  credentialResolver?: FirstPartyCredentialResolver
}

export interface WidgetWriteRequest {
  method: string
  nextUrl: { pathname: string }
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One structured line per write-relay outcome (silent under vitest). */
function logWriteRelay(
  level: 'info' | 'warn',
  event: string,
  context: Record<string, unknown>,
): void {
  if (process.env.NODE_ENV === 'test') return
  const logger = getLogger()
  if (level === 'warn') logger.warn(context, event)
  else logger.info(context, event)
}

/** Payload SHAPE only (keys/bytes), never values. */
function summarizeWritePayload(
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  let dataBytes = 0
  try {
    dataBytes = JSON.stringify(data).length
  } catch {
    dataBytes = -1
  }
  return {
    objectKeyCount: Object.keys(data).length,
    objectKeys: Object.keys(data).slice(0, 30),
    dataBytes,
    hasFolder: typeof payload['folder'] === 'object' && payload['folder'] !== null,
    hasVersion: typeof payload['version'] === 'number',
  }
}

/** Scalar/short-shape summary of CMS error details (server log only). */
function summarizeCmsErrorDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined
  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    if (typeof value === 'string') summary[key] = value.slice(0, 200)
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value
    else if (Array.isArray(value)) summary[key] = `array(${value.length})`
    else if (value !== null && typeof value === 'object')
      summary[key] = `object(${Object.keys(value).length})`
  }
  return summary
}

/** The browser contract carries its own status - keep HTTP aligned with it. */
function writeContractStatus(bodyText: string, upstreamStatus: number): number {
  try {
    const parsed = JSON.parse(bodyText) as { ok?: unknown; status?: unknown }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.ok === false &&
      typeof parsed.status === 'number'
    ) {
      return parsed.status
    }
  } catch {
    /* non-JSON passthrough */
  }
  return upstreamStatus
}

/**
 * CMS v2 speaks `{ success: true, object }` / `{ success: false, error: {
 * code } }`. The public widget contract stays `{ ok: true, object }` /
 * `{ ok: false, status, error }` — this relay is the translation boundary
 * (confirmed CMS guidance). Legacy non-envelope bodies pass through unchanged.
 */
export function toWidgetWriteContractBody(cmsBody: string, status: number): string {
  try {
    const parsed = JSON.parse(cmsBody) as unknown
    if (isRecord(parsed)) {
      if (parsed['success'] === true) {
        return JSON.stringify({ ok: true, object: parsed['object'] ?? null })
      }
      if (parsed['success'] === false) {
        const mapped = mapCmsFailure(status, cmsBody)
        const info = readCmsErrorInfo(cmsBody)
        const body: Record<string, unknown> = {
          ok: false,
          status: mapped.status,
          error: mapped.error,
        }
        if (mapped.status === 429) {
          // Confirmed contract: a monthly quota failure is NOT retryable in a
          // minute; minute rate limit is.
          const isMonthlyQuota = info.code === 'MONTHLY_QUOTA_EXCEEDED'
          body['reason'] = isMonthlyQuota ? 'monthly_quota' : 'minute_rate'
          body['retryAfterMs'] = isMonthlyQuota ? null : CMS_RELAY_DEFAULT_RATE_LIMIT_BACKOFF_MS
        }
        if (mapped.error === 'CAS_CONFLICT') {
          const serverVersion = info.details?.['serverVersion']
          if (typeof serverVersion === 'number' || typeof serverVersion === 'string') {
            body['serverVersion'] = serverVersion
          }
          body['message'] = CAS_CONFLICT_MESSAGE
        }
        return JSON.stringify(body)
      }
    }
  } catch {
    /* non-JSON body: pass through */
  }
  return cmsBody
}

/** Best-effort site resolution for the identity marker + grant matrix
 * (never fatal; failures degrade to the legacy env-key fallback). */
async function defaultResolveSite(host: string): Promise<WidgetWriteSite> {
  try {
    const { getResolverStack } = await import('@/lib/resolver')
    const result = await getResolverStack().resolveSite(host)
    return {
      ok: result.ok,
      folderId: result.ok ? result.site.folderId : '',
      tenant: result.ok ? result.site.tenant.tenantId : '',
      cmsApiBaseUrl: result.ok ? (result.site.settings?.cmsApiBaseUrl ?? '') : '',
      writeGrants: result.ok ? (result.site.settings?.writeGrants ?? []) : [],
    }
  } catch {
    return { ok: false, folderId: '', tenant: '', cmsApiBaseUrl: '', writeGrants: [] }
  }
}

/** Visitor email from the gw-session cookie resolved against the site's
 * tenant (never fatal; null when absent/unverifiable). */
async function defaultSessionEmail(
  cookieHeader: string | null,
  host: string,
): Promise<string | null> {
  if (!cookieHeader) return null
  try {
    const { SESSION_COOKIE, getTenantAuthService } = await import('@/lib/auth')
    const { getResolverStack } = await import('@/lib/resolver')
    const entry = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    if (!entry) return null
    const session = entry.slice(SESSION_COOKIE.length + 1)
    const siteResult = await getResolverStack().resolveSite(host)
    if (!siteResult.ok) return null
    const authService = await getTenantAuthService(siteResult.site.tenant)
    const user = await authService.userFromSessionCookie(session)
    return user?.email ?? null
  } catch {
    return null
  }
}

const defaultKeyLookupCache = new Map<string, { secret: string; expiresAt: number }>()

type KeyLookupResult = { ok: true; secret: string } | { ok: false; error: string }

/** D-WFLOW-43 secret lookup: GET {baseUrl}/keys/{keyName} with the platform
 * credential (read-only keys scope) + the source tenant. The CMS enforces
 * the target-owned grant list. 60 s in-memory cache per tenant:keyName. */
async function lookupKeySecret(
  baseUrl: string,
  keyName: string,
  sourceTenant: string,
  lookupApiKey: string,
  cache: Map<string, { secret: string; expiresAt: number }>,
  fetchFn: typeof fetch,
): Promise<KeyLookupResult> {
  const cacheKey = `${sourceTenant}:${keyName}`
  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, secret: cached.secret }
  }

  let response: Response
  try {
    response = await fetchFn(`${baseUrl}/keys/${encodeURIComponent(keyName)}`, {
      headers: { 'x-api-key': lookupApiKey, 'x-source-tenant': sourceTenant },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    return { ok: false, error: 'KEY_LOOKUP_UNREACHABLE' }
  }
  if (!response.ok) {
    let detail = ''
    try {
      const parsed = (await response.json()) as { error?: string }
      detail = parsed?.error ?? ''
    } catch {
      /* non-JSON error body */
    }
    return {
      ok: false,
      error: response.status === 404 ? 'KEY_NOT_FOUND' : detail || 'KEY_LOOKUP_FAILED',
    }
  }
  try {
    const body = (await response.json()) as { key?: { secret?: string } }
    if (body?.key?.secret) {
      cache.set(cacheKey, {
        secret: body.key.secret,
        expiresAt: Date.now() + KEY_LOOKUP_CACHE_TTL_MS,
      })
      return { ok: true, secret: body.key.secret }
    }
    return { ok: false, error: 'KEY_LOOKUP_BAD_RESPONSE' }
  } catch {
    return { ok: false, error: 'KEY_LOOKUP_BAD_RESPONSE' }
  }
}

export async function handleWidgetWrite(
  request: WidgetWriteRequest,
  deps: WidgetWriteDeps = {},
): Promise<NextResponse> {
  const startedAt = Date.now()
  const requestId = request.headers.get('x-request-id') ?? newRequestId()
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const logOutcome = (status: number, details: Record<string, unknown> = {}): void => {
    logWriteRelay(status >= 400 ? 'warn' : 'info', 'write-relay', {
      requestId,
      method: request.method,
      host,
      status,
      durationMs: Date.now() - startedAt,
      ...details,
    })
  }

  if (request.method === 'DELETE') {
    logOutcome(403, { error: 'PUBLIC_WRITE_DELETE_NOT_ALLOWED' })
    return NextResponse.json({ error: 'PUBLIC_WRITE_DELETE_NOT_ALLOWED' }, { status: 403 })
  }
  if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'PUT') {
    logOutcome(405, { error: 'method-not-allowed' })
    return new NextResponse('Method Not Allowed', { status: 405 })
  }

  const fetchFn = deps.fetchFn ?? fetch

  const segments = request.nextUrl.pathname
    .replace(/^\/api\/write\/objects\/?/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  const type = segments[0]
  const id = segments[1]
  if (!type || segments.length > 2) {
    logOutcome(404, { error: 'invalid-object-path' })
    return NextResponse.json({ error: 'invalid object path' }, { status: 404 })
  }

  const site = await (deps.resolveSite ?? defaultResolveSite)(host)
  const matchingGrant = site.writeGrants.find((grant) => grant.objectTypes.includes(type))

  // CMS base URL (tenant targeting, Q-43): the CMS v2 API is tenant-scoped
  // by HOST, so the lookup AND the write must go to the tenant's own CMS
  // host. Resolution order: per-grant cmsBaseUrl > site cmsApiBaseUrl >
  // env/global > platform default.
  const baseUrl = (
    matchingGrant?.cmsBaseUrl ??
    (site.cmsApiBaseUrl ||
      deps.baseUrl ||
      process.env.GW_CMS_WRITE_API_URL ||
      DEFAULT_CMS_WRITE_API_URL)
  ).replace(/\/+$/, '')

  // First-party service auth (runtime-fetch) takes precedence whenever the
  // global CMS_SERVICE_* configuration is complete: the tenant is resolved
  // from the trusted host, credentials come from the Secret API and a fresh
  // service JWT is minted per attempt. The restricted-key models below remain
  // the fallback contract for deployments without the CMS_SERVICE_* block.
  const serviceConfigResult =
    deps.serviceAuth === false
      ? ({ ok: false, missing: [] } as const)
      : resolveCmsServiceConfig(deps.env ?? process.env)
  const useServiceAuth = deps.apiKey === undefined && serviceConfigResult.ok

  // Key resolution (D-WFLOW-43, T-46): a writeGrant matching this object
  // type wins (the secret is fetched from the CMS key-lookup endpoint with
  // the platform credential); otherwise the legacy global env key applies.
  let apiKey: string | undefined
  if (!useServiceAuth) {
    if (deps.apiKey !== undefined) {
      apiKey = deps.apiKey
    } else {
      if (matchingGrant) {
        const lookupApiKey = process.env.GW_CMS_KEY_LOOKUP_API_KEY
        if (!lookupApiKey) {
          logOutcome(503, {
            authMode: 'grant',
            error: 'KEY_LOOKUP_NOT_CONFIGURED',
            tenantId: site.tenant,
            siteId: site.folderId,
            objectType: type,
          })
          return NextResponse.json(
            {
              error: 'KEY_LOOKUP_NOT_CONFIGURED',
              hint: 'Set GW_CMS_KEY_LOOKUP_API_KEY (the platform credential with the keys:read scope) in the deployment environment and redeploy.',
            },
            { status: 503 },
          )
        }
        const lookup = await lookupKeySecret(
          baseUrl,
          matchingGrant.keyName,
          site.tenant,
          lookupApiKey,
          deps.keyLookupCache ?? defaultKeyLookupCache,
          fetchFn,
        )
        if (!lookup.ok) {
          const errorBody: { error: string; hint?: string } = { error: lookup.error }
          if (lookup.error === 'SECRET_NOT_STORED') {
            errorBody.hint =
              'Rotate this key once in the CMS (Manage → Settings → API Management) so its secret can be stored for the relay.'
          }
          logOutcome(502, {
            authMode: 'grant',
            error: lookup.error,
            tenantId: site.tenant,
            siteId: site.folderId,
            objectType: type,
            keyName: matchingGrant.keyName,
          })
          return NextResponse.json(errorBody, { status: 502 })
        }
        apiKey = lookup.secret
      } else {
        apiKey = process.env.GW_CMS_WRITE_API_KEY
        if (!apiKey && site.writeGrants.length > 0) {
          logOutcome(403, {
            authMode: 'legacy',
            error: 'GRANT_NOT_ALLOWED',
            tenantId: site.tenant,
            siteId: site.folderId,
            objectType: type,
            grantCount: site.writeGrants.length,
          })
          return NextResponse.json(
            {
              error: 'GRANT_NOT_ALLOWED',
              hint: `no writeGrant covers object type '${type}' on this site`,
            },
            { status: 403 },
          )
        }
      }
      if (!apiKey) {
        logOutcome(503, {
          authMode: 'legacy',
          error: 'WRITE_RELAY_NOT_CONFIGURED',
          tenantId: site.tenant,
          siteId: site.folderId,
          objectType: type,
        })
        return NextResponse.json(
          {
            error: 'WRITE_RELAY_NOT_CONFIGURED',
            hint: 'Set GW_CMS_WRITE_API_KEY, or add a writeGrant for this object type in websiteConfig.writeGrants plus GW_CMS_KEY_LOOKUP_API_KEY, then redeploy.',
          },
          { status: 503 },
        )
      }
    }
  }

  const payload = await request.json().catch(() => null)
  if (!isRecord(payload)) {
    logOutcome(400, { error: 'invalid-json', tenantId: site.tenant, siteId: site.folderId, objectType: type })
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 })
  }
  const data = isRecord(payload['data']) ? payload['data'] : payload
  const payloadSummary = summarizeWritePayload(payload, data)

  // Visitor identity (SSOT section 8.9): the verified session email when
  // available, else a per-site anonymous marker. Always injected server-side
  // (never taken from the client payload).
  const email = await (deps.sessionEmail ?? defaultSessionEmail)(
    request.headers.get('cookie'),
    host,
  )
  const requestEmail = email ?? `anon-${site.ok && site.folderId ? site.folderId : 'visitor'}`
  const body: Record<string, unknown> = { ...payload, data, requestEmail }
  const idempotencyKeyHeader = request.headers.get('Idempotency-Key')
  const callContext = {
    requestId,
    tenantId: site.tenant,
    siteId: site.folderId,
    siteResolved: site.ok,
    objectType: type,
    objectId: id,
    hasIdempotencyKey: Boolean(idempotencyKeyHeader),
    requestEmailKind: email ? 'session' : 'anon',
    grantCount: site.writeGrants.length,
    writeGrantMatched: Boolean(matchingGrant),
    ...payloadSummary,
  }

  // First-party service auth path (runtime-fetch): no x-api-key at all — the
  // tenant's service JWT is minted server-side; the retry-on-rotation logic
  // lives in lib/server/cmsServiceFetch.ts.
  if (useServiceAuth && serviceConfigResult.ok) {
    const authMode = 'service'
    logWriteRelay('info', 'write-relay-call', { ...callContext, authMode })
    const result = await callCmsService({
      method: request.method as 'POST' | 'PATCH' | 'PUT',
      cmsPath: `/objects/${encodeURIComponent(type)}${id ? `/${encodeURIComponent(id)}` : ''}`,
      body: JSON.stringify(
        normalizePublicWritePayload(
          payload,
          request.method === 'POST' ? 'POST' : request.method === 'PUT' ? 'PUT' : 'PATCH',
          requestEmail,
        ),
      ),
      identity: { tenantId: site.tenant, siteId: site.folderId, deploymentId: site.folderId },
      config: serviceConfigResult.config,
      resolver: deps.credentialResolver ?? getFirstPartyCredentialResolver(),
      fetchFn,
      idempotencyKey: idempotencyKeyHeader ?? undefined,
      writeSource: true,
    })
    if (!result.ok) {
      logOutcome(result.status, {
        ...callContext,
        authMode,
        error: result.error,
        cmsStatus: result.status,
        cmsHost: result.cmsHost,
        networkMessage: result.networkMessage,
        kid: result.kid,
        cacheHit: result.cacheHit,
      })
      return NextResponse.json(
        { ok: false, status: result.status, error: result.error },
        { status: result.status },
      )
    }
    const contractBody = toWidgetWriteContractBody(result.body, result.status)
    const contractStatus = writeContractStatus(contractBody, result.status)
    const cmsError = result.status >= 400 ? readCmsErrorInfo(result.body) : {}
    logOutcome(contractStatus, {
      ...callContext,
      authMode,
      cmsStatus: result.status,
      cmsHost: result.cmsHost,
      cmsErrorCode: cmsError.code,
      cmsErrorReason: cmsError.reason,
      cmsErrorMessage:
        typeof cmsError.message === 'string' ? cmsError.message.slice(0, 300) : undefined,
      cmsErrorDetails: summarizeCmsErrorDetails(cmsError.details),
      responseShape:
        result.status >= 400 ? summarizeCmsBodyShape(result.body) : undefined,
      kid: result.kid,
      cacheHit: result.cacheHit,
    })
    return new NextResponse(contractBody, {
      status: contractStatus,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(result.rateLimitHeaders ?? {}),
      },
    })
  }

  if (!apiKey) {
    // Unreachable when service auth is off (checked above) — narrows the type.
    return NextResponse.json({ error: 'WRITE_RELAY_NOT_CONFIGURED' }, { status: 503 })
  }

  const target = id
    ? `${baseUrl}/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
    : `${baseUrl}/objects/${encodeURIComponent(type)}`
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'x-unicon-write-source': 'public-website',
    'Content-Type': 'application/json',
  }
  const idempotencyKey = idempotencyKeyHeader
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const legacyAuthMode = matchingGrant ? 'grant' : 'legacy'
  logWriteRelay('info', 'write-relay-call', { ...callContext, authMode: legacyAuthMode })
  try {
    const response = await fetchFn(target, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    })
    const responseBody = await response.text()
    const passthrough = new Headers()
    for (const name of CMS_RATE_LIMIT_HEADERS) {
      const value = response.headers.get(name)
      if (value) passthrough.set(name, value)
    }
    passthrough.set('Content-Type', response.headers.get('Content-Type') ?? 'application/json')
    const contractBody = toWidgetWriteContractBody(responseBody, response.status)
    const contractStatus = writeContractStatus(contractBody, response.status)
    const cmsError = response.status >= 400 ? readCmsErrorInfo(responseBody) : {}
    logOutcome(contractStatus, {
      ...callContext,
      authMode: legacyAuthMode,
      cmsStatus: response.status,
      cmsErrorCode: cmsError.code,
      cmsErrorReason: cmsError.reason,
      cmsErrorMessage:
        typeof cmsError.message === 'string' ? cmsError.message.slice(0, 300) : undefined,
      cmsErrorDetails: summarizeCmsErrorDetails(cmsError.details),
      responseShape:
        response.status >= 400 ? summarizeCmsBodyShape(responseBody) : undefined,
    })
    return new NextResponse(contractBody, {
      status: contractStatus,
      headers: passthrough,
    })
  } catch (error) {
    logOutcome(502, {
      ...callContext,
      authMode: legacyAuthMode,
      error: 'cms-write-relay-unreachable',
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'cms write relay unreachable' }, { status: 502 })
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleWidgetWrite(request)
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  return handleWidgetWrite(request)
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return handleWidgetWrite(request)
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json({ error: 'PUBLIC_WRITE_DELETE_NOT_ALLOWED' }, { status: 403 })
}

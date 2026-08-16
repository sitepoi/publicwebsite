import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import { getProviderForTenant } from '@/lib/data'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp, isSameOrigin } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * POST /api/forms/upload (Section 14) — multipart files → provider storage
 * (Firebase Storage now, Supabase Storage later). Folder comes from the SITE
 * config — never from the client. Size + type allowlists.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export const ALLOWED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'application/zip',
])

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.svg',
  '.pdf',
  '.txt',
  '.zip',
])

export interface FormUploadDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  now?: () => number
  maxBytes?: number
}

export async function handleFormUpload(
  request: Request,
  deps: FormUploadDeps = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  const now = deps.now ?? Date.now
  const maxBytes = deps.maxBytes ?? MAX_UPLOAD_BYTES
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  if (!isSameOrigin(request)) return json({ error: 'invalid-origin' }, 403)

  const url = new URL(request.url)
  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    return json({ error: 'blocked' }, 403)
  }

  const limiter = deps.rateLimiter ?? sharedLimiter(env)
  const rate = limiter.check(`upload:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('multipart/form-data')) {
    return json({ error: 'multipart-required' }, 400)
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return json({ error: 'invalid-multipart' }, 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return json({ error: 'file-required' }, 400)

  if (file.size > maxBytes) return json({ error: 'too-large' }, 413)

  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  if (!ALLOWED_UPLOAD_TYPES.has(file.type) || !ALLOWED_EXTENSIONS.has(extension)) {
    return json({ error: 'type-not-allowed' }, 400)
  }

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site

  const provider = (deps.providerFor ?? getProviderForTenant)(site.tenant)
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  const path = `sites/${site.folderId}/uploads/${now()}-${safeName}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const stored = await provider.uploadFile({ path, buffer, contentType: file.type })
  return json({ ok: true, url: stored.url, path: stored.path })
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(env: Env): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: env.FORMS_RATE_LIMIT_MAX,
      windowMs: env.FORMS_RATE_LIMIT_WINDOW_MS,
    })
  }
  return limiterSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(request: Request): Promise<Response> {
  return handleFormUpload(request)
}

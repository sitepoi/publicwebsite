import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack, type SiteConfig } from '@/lib/resolver'
import { getProviderForTenant } from '@/lib/data'
import type { DataProvider } from '@/lib/data/provider'
import {
  FormSubmitPayloadSchema,
  type FormSubmitPayload,
  type FormTypeConfig,
} from '@/lib/contracts/forms'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp, isSameOrigin } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import { applyUserDestination, buildSaveFormRecord, loadFormTypeConfig } from '@/lib/render/forms'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * POST /api/forms/submit (Section 14) — JSON + multipart. Guards IN ORDER:
 *  1. same-origin      2. traffic rules      3. per-IP rate limit (hashed IP)
 *  4. size cap         5. honeypot           6. min fill time
 *  7. reCAPTCHA v3 (optional, per-folder)    8. Zod payload validation
 * Then: server-side form-type config → destinationTable + afterSaveApiHooks
 * (axios GET, NEVER trusted from the client) → saveForm-compatible record →
 * provider.createRecord(`${destinationTable}${tableExtension}`).
 *
 * Hard rules: writes only via this endpoint for forms · hashed IP only ·
 * a failing hook NEVER fails the submission.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MIN_FILL_TIME_MS = 2_000
export const MAX_JSON_BYTES = 256 * 1024
export const MAX_FORM_BYTES = 10 * 1024 * 1024
export const DEFAULT_DESTINATION_TABLE = 'forms'

export interface FormSubmitDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  loadFormType?: (
    provider: DataProvider,
    site: SiteConfig,
    formTypeId: string,
  ) => Promise<FormTypeConfig | null>
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  now?: () => number
  runHook?: (url: string) => Promise<void>
  verifyCaptcha?: (token: string) => Promise<boolean>
}

export async function handleFormSubmit(
  request: Request,
  deps: FormSubmitDeps = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  const now = deps.now ?? Date.now
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  // 1. Same-origin.
  if (!isSameOrigin(request)) {
    return json({ error: 'invalid-origin' }, 403)
  }

  // 2. Traffic rules.
  const url = new URL(request.url)
  const verdict = evaluateTraffic(
    {
      userAgent: request.headers.get('user-agent'),
      text: `${url.pathname}${url.search}`,
    },
    trafficRules,
  )
  if (verdict.blocked) return json({ error: 'blocked' }, 403)

  // 3. Per-IP rate limit (hashed IP only — hard rule).
  const limiter = deps.rateLimiter ?? sharedLimiter(env)
  const key = hashIp(getClientIp(request), env.RELAY_SECRET)
  const rate = limiter.check(key)
  if (!rate.allowed) {
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)
  }

  // 4. Size cap.
  const declared = Number(request.headers.get('content-length') ?? 0)
  const isMultipart = (request.headers.get('content-type') ?? '').includes('multipart/form-data')
  const sizeCap = isMultipart ? MAX_FORM_BYTES : MAX_JSON_BYTES
  if (declared > sizeCap) return json({ error: 'too-large' }, 413)

  // Parse + normalize JSON/multipart into the SAME payload shape.
  let payload: FormSubmitPayload
  try {
    const raw = await parsePayload(request)
    if (JSON.stringify(raw).length > sizeCap) return json({ error: 'too-large' }, 413)
    const parsed = FormSubmitPayloadSchema.safeParse(raw)
    if (!parsed.success) return json({ error: 'invalid-payload' }, 400)
    payload = parsed.data
  } catch {
    return json({ error: 'invalid-payload' }, 400)
  }

  // 5. Honeypot — silently ignored.
  if (payload.gw_hp.trim().length > 0) {
    return json({ ok: true })
  }

  // 6. Min fill time.
  if (now() - payload.submittedAt < MIN_FILL_TIME_MS) {
    return json({ error: 'too-fast' }, 400)
  }

  // 7. Site resolution (host → tenant/folder config).
  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site

  // reCAPTCHA v3 — optional, enabled per-folder via webSettings.recaptcha.
  const recaptchaConfig = site.settings.webSettings as unknown as {
    recaptcha?: { enabled?: boolean | string }
  }
  const captchaEnabled =
    recaptchaConfig?.recaptcha?.enabled === true || recaptchaConfig?.recaptcha?.enabled === 'yes'
  if (captchaEnabled && env.RECAPTCHA_SECRET_KEY) {
    const token = payload.values['g-recaptcha-response'] ?? ''
    if (!token) return json({ error: 'captcha-required' }, 400)
    const verify = deps.verifyCaptcha ?? ((value: string) => verifyCaptchaWithGoogle(value, env))
    if (!(await verify(token))) return json({ error: 'captcha-failed' }, 400)
  }

  // 8. Server-side form-type config — NEVER client hooks/tables.
  const provider = (deps.providerFor ?? getProviderForTenant)(site.tenant)
  const config = payload.formTypeId
    ? await (deps.loadFormType ?? loadFormTypeConfig)(provider, site, payload.formTypeId)
    : null

  const destinationTable =
    config?.destinationTable ?? payload.formTypeId ?? DEFAULT_DESTINATION_TABLE
  const collection = `${destinationTable}${site.tenant.tableExtension ?? ''}`
  const docId = randomUUID()

  const record = applyUserDestination(
    buildSaveFormRecord({
      docId,
      formTypeId: payload.formTypeId,
      values: payload.values,
      now: new Date(now()),
    }),
    destinationTable,
  )

  await provider.createRecord({ collection, id: docId, data: record })

  // afterSaveApiHooks — axios GET, same hook URL contract; NEVER fail the
  // submission because a hook failed (hard rule).
  const runHook = deps.runHook ?? axiosGetHook
  const hooks = config?.afterSaveApiHooks ?? []
  if (hooks.length > 0) {
    await Promise.all(hooks.map((hookUrl: string) => runHook(hookUrl).catch(() => undefined)))
  }

  return json({ ok: true, id: docId })
}

async function parsePayload(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData()
    const values: Record<string, string> = {}
    let submittedAt: number | null = null
    let gw_hp = ''
    let formTypeId: string | undefined

    for (const [name, value] of formData.entries()) {
      if (name === 'submittedAt') submittedAt = Number(value)
      else if (name === 'gw_hp') gw_hp = String(value)
      else if (name === 'formTypeId') formTypeId = String(value)
      else if (typeof value === 'string') values[name] = value
      else {
        // File fields: record the file name as the value (uploads use the
        // dedicated /api/forms/upload endpoint, then pass the returned URL).
        values[name] = (value as File).name
      }
    }
    return { formTypeId, submittedAt, gw_hp, values }
  }

  const text = await request.text()
  return JSON.parse(text) as unknown
}

async function verifyCaptchaWithGoogle(token: string, env: Env): Promise<boolean> {
  if (!env.RECAPTCHA_SECRET_KEY) return true
  try {
    const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.RECAPTCHA_SECRET_KEY, response: token }),
    })
    const result = (await response.json()) as { success?: boolean }
    return result.success === true
  } catch {
    return false
  }
}

async function axiosGetHook(url: string): Promise<void> {
  await axios.get(url, { timeout: 5_000 })
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
  return handleFormSubmit(request)
}

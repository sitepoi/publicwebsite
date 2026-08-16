import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { EmailSendSchema } from '@/lib/contracts/services'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import { fillTemplate, getMailService, renderTemplate, type MailService } from '@/lib/email'
import { readField } from '@/lib/data/common'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * POST /api/email/send (Section 15) — AWS SES + nodemailer, env creds only.
 * Template SELECTION is server-side (templateId → app object); user data is
 * HTML-escaped before merging. Raw client html is never accepted.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const EMAIL_RATE_MAX = 20
export const EMAIL_RATE_WINDOW_MS = 60_000

export interface EmailDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  mailService?: MailService
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
}

export async function handleEmailSend(request: Request, deps: EmailDeps = {}): Promise<Response> {
  const env = deps.env ?? getEnv()
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  const url = new URL(request.url)
  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    return json({ error: 'blocked' }, 403)
  }

  const limiter = deps.rateLimiter ?? sharedLimiter()
  const rate = limiter.check(`email:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const parsed = EmailSendSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-email-call' }, 400)
  const call = parsed.data

  // Honeypot — silent.
  if (call.gw_hp && call.gw_hp.trim().length > 0) return json({ ok: true })

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )

  // Template = an object in the website app with data.templateId (Section 15).
  const result = await provider.queryObjects({
    cmsObjectType: site.appId,
    filters: [{ field: 'data.templateId', op: '==', value: call.templateId }],
    pageSize: 5,
  })
  const templateRecord = result.items.find(
    (record) => readField(record, 'data.templateId') === call.templateId,
  )
  if (!templateRecord) return json({ error: 'template-not-found' }, 404)

  const htmlCandidate =
    readField(templateRecord, 'data.html') ?? readField(templateRecord, 'data.htmlPage.code.html')
  const html = typeof htmlCandidate === 'string' ? htmlCandidate : ''
  if (html.length === 0) return json({ error: 'template-empty' }, 400)

  const mailService = deps.mailService ?? getMailService()
  if (!mailService) return json({ error: 'email-not-configured' }, 503)

  const fromAddress = env.SES_FROM_ADDRESS
  if (!fromAddress) return json({ error: 'email-not-configured' }, 503)

  const subjectBase =
    call.subject ??
    (typeof readField(templateRecord, 'data.subject') === 'string'
      ? String(readField(templateRecord, 'data.subject'))
      : 'Notification')

  await mailService.send({
    from: fromAddress,
    to: call.to,
    subject: fillTemplate(subjectBase, call.data ?? {}),
    html: renderTemplate(html, call.data ?? {}),
  })

  return json({ ok: true })
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: EMAIL_RATE_MAX,
      windowMs: EMAIL_RATE_WINDOW_MS,
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
  return handleEmailSend(request)
}

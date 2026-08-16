import { describe, expect, it, vi } from 'vitest'
import {
  handleFormSubmit,
  MIN_FILL_TIME_MS,
  type FormSubmitDeps,
} from '@/app/api/forms/submit/route'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { SiteResolution } from '@/lib/resolver/site'
import type { SiteConfig } from '@/lib/resolver/site'
import {
  createRecordingProvider,
  makeFormTypeObject,
  makeJsonRequest,
  makeTestSite,
  testEnv,
} from './forms-fakes'

const FIXED_NOW = 1_700_000_000_000

type SubmitTestDeps = FormSubmitDeps & {
  site: SiteConfig
  recorded: ReturnType<typeof createRecordingProvider>
}

function deps(site: SiteConfig = makeTestSite()): SubmitTestDeps {
  const recorded = createRecordingProvider()
  return {
    env: testEnv,
    site,
    recorded,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => recorded.provider,
    runHook: vi.fn(async () => undefined),
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
    now: () => FIXED_NOW,
  }
}

describe('POST /api/forms/submit (Section 14)', () => {
  it('writes a saveForm-compatible record to ${destinationTable}${tableExtension}', async () => {
    const d = deps()
    const response = await handleFormSubmit(
      makeJsonRequest({
        formTypeId: 'contact',
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: '',
        values: { name: 'Ada', email: 'ada@example.com', message: 'hi' },
      }),
      d,
    )
    expect(response.status).toBe(200)

    expect(d.recorded.writes).toHaveLength(1)
    const write = d.recorded.writes[0]!.input
    expect(write.collection).toBe('contactext') // destinationTable + tableExtension
    expect(write.id).toBeDefined()
    expect(write.data).toMatchObject({
      id: write.id,
      docId: write.id,
      name: 'Ada',
      formType: 'contact',
      formKeyValues: { name: 'Ada', email: 'ada@example.com', message: 'hi' },
      serverTimeStamp: new Date(FIXED_NOW).toISOString(),
      date_str: new Date(FIXED_NOW).toISOString().slice(0, 10),
    })
  })

  it('applies the server-side form-type config: destinationTable + afterSaveApiHooks', async () => {
    const d = deps()
    d.recorded = createRecordingProvider([
      makeFormTypeObject('contact', {
        destinationTable: 'custom-forms',
        afterSaveApiHooks: ['https://hooks.example/run'],
      }),
    ])
    d.providerFor = () => d.recorded.provider

    const response = await handleFormSubmit(
      makeJsonRequest({
        formTypeId: 'contact',
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: '',
        values: { name: 'Ada' },
      }),
      d,
    )
    expect(response.status).toBe(200)
    expect(d.recorded.writes[0]?.input.collection).toBe('custom-formsext')
    expect(d.runHook).toHaveBeenCalledWith('https://hooks.example/run')
  })

  it('NEVER fails the submission because a hook failed', async () => {
    const d = deps()
    d.recorded = createRecordingProvider([
      makeFormTypeObject('contact', { afterSaveApiHooks: ['https://hooks.example/broken'] }),
    ])
    d.providerFor = () => d.recorded.provider
    d.runHook = vi.fn(async () => {
      throw new Error('hook down')
    })

    const response = await handleFormSubmit(
      makeJsonRequest({
        formTypeId: 'contact',
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: '',
        values: { name: 'Ada' },
      }),
      d,
    )
    expect(response.status).toBe(200)
    expect(d.recorded.writes).toHaveLength(1)
  })

  it('users destination special case adds roles [customer]', async () => {
    const d = deps()
    d.recorded = createRecordingProvider([
      makeFormTypeObject('registration', { destinationTable: 'users' }),
    ])
    d.providerFor = () => d.recorded.provider

    await handleFormSubmit(
      makeJsonRequest({
        formTypeId: 'registration',
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: '',
        values: { name: 'Ada', email: 'ada@example.com' },
      }),
      d,
    )
    expect(d.recorded.writes[0]?.input.collection).toBe('usersext')
    expect(d.recorded.writes[0]?.input.data).toMatchObject({ roles: ['customer'] })
  })

  it('silently ignores honeypot submissions (no write, no hooks)', async () => {
    const d = deps()
    const response = await handleFormSubmit(
      makeJsonRequest({
        formTypeId: 'contact',
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: 'bot-filled',
        values: { name: 'Bot' },
      }),
      d,
    )
    expect(response.status).toBe(200)
    expect(d.recorded.writes).toHaveLength(0)
    expect(d.runHook).not.toHaveBeenCalled()
  })

  it('rejects too-fast submissions (min fill time)', async () => {
    const d = deps()
    const response = await handleFormSubmit(
      makeJsonRequest({
        formTypeId: 'contact',
        submittedAt: FIXED_NOW - 100,
        gw_hp: '',
        values: { name: 'Speedy' },
      }),
      d,
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('too-fast')
    expect(d.recorded.writes).toHaveLength(0)
    expect(MIN_FILL_TIME_MS).toBe(2_000)
  })

  it('rate-limits per IP after the max is exceeded', async () => {
    const d = deps()
    d.rateLimiter = createMemoryRateLimiter({ max: 1, windowMs: 60_000 })
    const payload = {
      formTypeId: 'contact',
      submittedAt: FIXED_NOW - 10_000,
      gw_hp: '',
      values: { name: 'Ada' },
    }

    const first = await handleFormSubmit(makeJsonRequest(payload), d)
    expect(first.status).toBe(200)
    const second = await handleFormSubmit(makeJsonRequest(payload), d)
    expect(second.status).toBe(429)
  })

  it('rate-limit keys use HASHED IPs only (hard rule)', async () => {
    const d = deps()
    const check = vi.fn<(key: string) => { allowed: boolean }>(() => ({ allowed: true }))
    d.rateLimiter = { check, reset: () => undefined }

    await handleFormSubmit(
      makeJsonRequest(
        { submittedAt: FIXED_NOW - 10_000, gw_hp: '', values: { a: '1' } },
        {
          'x-forwarded-for': '203.0.113.7',
        },
      ),
      d,
    )
    expect(check).toHaveBeenCalledOnce()
    const key = check.mock.calls[0]?.[0]
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain('203.0.113.7')
  })

  it('rejects cross-origin requests', async () => {
    const d = deps()
    const response = await handleFormSubmit(
      makeJsonRequest(
        { submittedAt: FIXED_NOW - 10_000, gw_hp: '', values: {} },
        { origin: 'https://evil.example' },
      ),
      d,
    )
    expect(response.status).toBe(403)
  })

  it('applies traffic rules (blocked user agents)', async () => {
    const d = deps()
    d.trafficRules = { blockedUserAgents: ['badbot'], deniedWords: [] }
    const response = await handleFormSubmit(
      makeJsonRequest(
        { submittedAt: FIXED_NOW - 10_000, gw_hp: '', values: {} },
        { 'user-agent': 'BadBot/1.0' },
      ),
      d,
    )
    expect(response.status).toBe(403)
  })

  it('rejects invalid payloads (Zod)', async () => {
    const d = deps()
    const response = await handleFormSubmit(makeJsonRequest({ values: 'nope' }), d)
    expect(response.status).toBe(400)
  })

  it('rejects oversized bodies', async () => {
    const d = deps()
    const big = {
      submittedAt: FIXED_NOW - 10_000,
      gw_hp: '',
      values: { big: 'x'.repeat(300 * 1024) },
    }
    const response = await handleFormSubmit(makeJsonRequest(big), d)
    expect(response.status).toBe(413)
  })

  it('normalizes multipart FormData into the same payload contract', async () => {
    const d = deps()
    const formData = new FormData()
    formData.append('formTypeId', 'contact')
    formData.append('submittedAt', String(FIXED_NOW - 10_000))
    formData.append('gw_hp', '')
    formData.append('name', 'Ada')
    formData.append('avatar', new File(['x'], 'a.png', { type: 'image/png' }))

    const response = await handleFormSubmit(
      new Request('https://site-a.test/api/forms/submit', {
        method: 'POST',
        headers: { 'x-gw-host': 'site-a.test', origin: 'https://site-a.test' },
        body: formData,
      }),
      d,
    )
    expect(response.status).toBe(200)
    const data = d.recorded.writes[0]!.input.data
    expect(data.formType).toBe('contact')
    expect(data.formKeyValues).toMatchObject({ name: 'Ada', avatar: 'a.png' })
  })

  it('verifies reCAPTCHA v3 when enabled per-folder', async () => {
    const site = makeTestSite()
    ;(site.settings as Record<string, unknown>).webSettings = { recaptcha: { enabled: 'yes' } }
    const d = deps(site)
    d.env = { ...testEnv, RECAPTCHA_SECRET_KEY: 'secret' }
    d.verifyCaptcha = vi.fn(async (token: string) => token === 'good-token')

    const rejected = await handleFormSubmit(
      makeJsonRequest({
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: '',
        values: { 'g-recaptcha-response': 'bad-token' },
      }),
      d,
    )
    expect(rejected.status).toBe(400)

    const accepted = await handleFormSubmit(
      makeJsonRequest({
        submittedAt: FIXED_NOW - 10_000,
        gw_hp: '',
        values: { 'g-recaptcha-response': 'good-token' },
      }),
      d,
    )
    expect(accepted.status).toBe(200)
  })
})

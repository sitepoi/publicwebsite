import { describe, expect, it } from 'vitest'
import { handleEmailSend } from '@/app/api/email/send/route'
import { renderTemplate, type MailInput, type MailService } from '@/lib/email'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteResolution } from '@/lib/resolver/site'
import { createStoreProvider, dataEnv, makeDataSite } from './data-fakes'

const site = makeDataSite()

const welcomeTemplate: ObjectRecord = {
  id: 'tpl-welcome',
  slug: 'tpl-welcome',
  cmsObjectType: site.appId,
  typeId: site.folderId,
  data: {
    templateId: 'welcome',
    subject: 'Hi {{name}}',
    html: '<h1>Hello {{name}}</h1><p>Order {{orderId}}</p>',
  },
}

function createFakeMail(): { service: MailService; sent: MailInput[] } {
  const sent: MailInput[] = []
  return {
    sent,
    service: { name: 'fake', send: async (input) => void sent.push(input) },
  }
}

function emailDeps(
  store: ReturnType<typeof createStoreProvider>,
  mail: ReturnType<typeof createFakeMail>,
) {
  return {
    env: { ...dataEnv, SES_FROM_ADDRESS: 'no-reply@site-a.test' },
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site }),
    providerFor: () => store.provider,
    mailService: mail.service,
    rateLimiter: createMemoryRateLimiter({ max: 1000, windowMs: 60_000 }),
  }
}

function makeRequest(body: unknown): Request {
  return new Request('https://site-a.test/api/email/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/email/send (Section 15)', () => {
  it('selects the template server-side, merges ESCAPED data and sends via SES', async () => {
    const store = createStoreProvider({ objects: [welcomeTemplate] })
    const mail = createFakeMail()

    const response = await handleEmailSend(
      makeRequest({
        to: 'a@b.co',
        templateId: 'welcome',
        data: { name: '<script>X</script>', orderId: 'o1' },
      }),
      emailDeps(store, mail),
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true)

    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]).toMatchObject({
      from: 'no-reply@site-a.test',
      to: 'a@b.co',
      subject: 'Hi <script>X</script>', // subject is NOT html-escaped? see renderTemplate usage
    })
    const html = String(mail.sent[0]?.['html'])
    expect(html).toContain('&lt;script&gt;X&lt;/script&gt;')
    expect(html).toContain('Order o1')
    expect(html).not.toContain('<script>X</script>')
  })

  it('404s unknown templates and rejects raw html (strict schema)', async () => {
    const store = createStoreProvider({ objects: [welcomeTemplate] })
    const mail = createFakeMail()
    const deps = emailDeps(store, mail)

    const missing = await handleEmailSend(makeRequest({ to: 'a@b.co', templateId: 'nope' }), deps)
    expect(missing.status).toBe(404)

    const rawHtml = await handleEmailSend(
      makeRequest({ to: 'a@b.co', templateId: 'welcome', html: '<b>x</b>' }),
      deps,
    )
    expect(rawHtml.status).toBe(400)
    expect(mail.sent).toHaveLength(0)
  })

  it('silently ignores honeypot calls', async () => {
    const store = createStoreProvider({ objects: [welcomeTemplate] })
    const mail = createFakeMail()
    const response = await handleEmailSend(
      makeRequest({ to: 'a@b.co', templateId: 'welcome', gw_hp: 'bot' }),
      emailDeps(store, mail),
    )
    expect(response.status).toBe(200)
    expect(mail.sent).toHaveLength(0)
  })
})

describe('renderTemplate (template merging)', () => {
  it('escapes every placeholder and leaves non-placeholders intact', () => {
    expect(renderTemplate('Hi {{name}} — <b>{{extra}}</b>', { name: '<A>', extra: 'x&y' })).toBe(
      'Hi &lt;A&gt; — <b>x&amp;y</b>',
    )
  })
})

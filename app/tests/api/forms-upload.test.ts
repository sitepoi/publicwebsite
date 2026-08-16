import { describe, expect, it } from 'vitest'
import { handleFormUpload, type FormUploadDeps } from '@/app/api/forms/upload/route'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
import type { SiteResolution } from '@/lib/resolver/site'
import { createRecordingProvider, makeTestSite, makeUploadRequest, testEnv } from './forms-fakes'

type UploadTestDeps = FormUploadDeps & {
  recorded: ReturnType<typeof createRecordingProvider>
}

function deps(): UploadTestDeps {
  const recorded = createRecordingProvider()
  return {
    env: testEnv,
    recorded,
    resolveSite: async (): Promise<SiteResolution> => ({ ok: true, site: makeTestSite() }),
    providerFor: () => recorded.provider,
    rateLimiter: createMemoryRateLimiter({ max: 10, windowMs: 60_000 }),
    now: () => 1_700_000_000_000,
  }
}

describe('POST /api/forms/upload (Section 14)', () => {
  it('stores allowed files under the site folder and returns the URL', async () => {
    const d = deps()
    const file = new File([new Uint8Array(64)], 'photo.png', { type: 'image/png' })
    const response = await handleFormUpload(makeUploadRequest(file), d)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { ok: boolean; url: string; path: string }
    expect(body.ok).toBe(true)
    expect(body.path).toMatch(/^sites\/folder-a\/uploads\/\d+-photo\.png$/)
    expect(body.url).toBe(`https://storage.example/${body.path}`)
    expect(d.recorded.uploads).toHaveLength(1)
    expect(d.recorded.uploads[0]?.contentType).toBe('image/png')
    expect(d.recorded.uploads[0]?.buffer.length).toBe(64)
  })

  it('rejects disallowed file types', async () => {
    const d = deps()
    const file = new File([new Uint8Array(8)], 'run.exe', { type: 'application/x-msdownload' })
    const response = await handleFormUpload(makeUploadRequest(file), d)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('type-not-allowed')
  })

  it('rejects files over the size cap', async () => {
    const d = deps()
    d.maxBytes = 16
    const file = new File([new Uint8Array(64)], 'photo.png', { type: 'image/png' })
    const response = await handleFormUpload(makeUploadRequest(file), d)
    expect(response.status).toBe(413)
  })

  it('requires a file field', async () => {
    const d = deps()
    const formData = new FormData()
    formData.append('other', 'x')
    const response = await handleFormUpload(
      new Request('https://site-a.test/api/forms/upload', {
        method: 'POST',
        headers: { 'x-gw-host': 'site-a.test', origin: 'https://site-a.test' },
        body: formData,
      }),
      d,
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('file-required')
  })

  it('requires multipart content', async () => {
    const d = deps()
    const response = await handleFormUpload(
      new Request('https://site-a.test/api/forms/upload', {
        method: 'POST',
        headers: {
          'x-gw-host': 'site-a.test',
          origin: 'https://site-a.test',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      d,
    )
    expect(response.status).toBe(400)
  })

  it('rejects cross-origin uploads', async () => {
    const d = deps()
    const file = new File([new Uint8Array(8)], 'photo.png', { type: 'image/png' })
    const response = await handleFormUpload(
      makeUploadRequest(file, { origin: 'https://evil.example' }),
      d,
    )
    expect(response.status).toBe(403)
  })
})

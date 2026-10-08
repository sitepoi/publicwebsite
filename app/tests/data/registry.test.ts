import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearRelayApplicationsCache,
  createSitepoiRegistryLookup,
  decodeFirestoreFieldValue,
  decodeFirestoreFields,
  fetchRelayApplications,
} from '@/lib/data/providers/firestore/registry'

function fakeFirestoreDocument(fields: Record<string, unknown>): { fields: Record<string, unknown> } {
  return { fields }
}

function okJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  clearRelayApplicationsCache()
  delete process.env.SITEPOI_RELAY_APIKEY
  delete process.env.SITEPOI_RELAY_PROJECT_ID
})

describe('decodeFirestoreFieldValue (Firestore REST value decoding)', () => {
  it('decodes scalar values', () => {
    expect(decodeFirestoreFieldValue({ stringValue: 'abc' })).toBe('abc')
    expect(decodeFirestoreFieldValue({ integerValue: '42' })).toBe(42)
    expect(decodeFirestoreFieldValue({ doubleValue: 1.5 })).toBe(1.5)
    expect(decodeFirestoreFieldValue({ booleanValue: true })).toBe(true)
    expect(decodeFirestoreFieldValue({ nullValue: null })).toBe(null)
    expect(decodeFirestoreFieldValue({ timestampValue: '2026-10-08T00:00:00Z' })).toBe(
      '2026-10-08T00:00:00Z',
    )
  })

  it('decodes arrays recursively', () => {
    expect(
      decodeFirestoreFieldValue({
        arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '1' }] },
      }),
    ).toEqual(['a', 1])
  })

  it('decodes maps recursively', () => {
    expect(
      decodeFirestoreFieldValue({
        mapValue: {
          fields: {
            nested: { mapValue: { fields: { value: { stringValue: 'deep' } } } },
          },
        },
      }),
    ).toEqual({ nested: { value: 'deep' } })
  })

  it('passes plain values through', () => {
    expect(decodeFirestoreFieldValue('plain')).toBe('plain')
    expect(decodeFirestoreFieldValue(null)).toBe(null)
    expect(decodeFirestoreFieldValue([1, 2])).toEqual([1, 2])
  })

  it('decodeFirestoreFields builds a plain record', () => {
    expect(
      decodeFirestoreFields({
        hostNames: {
          arrayValue: { values: [{ stringValue: 'acme.com' }, { stringValue: 'www.acme.com' }] },
        },
        count: { integerValue: '7' },
      }),
    ).toEqual({ hostNames: ['acme.com', 'www.acme.com'], count: 7 })
  })
})

describe('fetchRelayApplications (legacy client-key read, D-DWH-20)', () => {
  it('requests the applications collection with the legacy client key', async () => {
    process.env.SITEPOI_RELAY_APIKEY = 'legacy-api-key'
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/projects/sitepoi-relay/')
      expect(String(input)).toContain('/documents/applications')
      expect(String(input)).toContain('key=legacy-api-key')
      return okJsonResponse({
        documents: [
          {
            name: 'projects/sitepoi-relay/databases/(default)/documents/applications/app-1',
            ...fakeFirestoreDocument({
              hostNames: {
                arrayValue: { values: [{ stringValue: 'acme.com' }] },
              },
              fbSettings: {
                mapValue: { fields: { base64: { stringValue: 'e30=' } } },
              },
            }),
          },
        ],
      })
    }) as unknown as typeof fetch
    const docs = await fetchRelayApplications(fakeFetch)
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect(docs).toEqual([
      {
        name: 'projects/sitepoi-relay/databases/(default)/documents/applications/app-1',
        hostNames: ['acme.com'],
        fbSettings: { base64: 'e30=' },
      },
    ])
  })

  it('respects SITEPOI_RELAY_PROJECT_ID', async () => {
    process.env.SITEPOI_RELAY_APIKEY = 'legacy-api-key'
    process.env.SITEPOI_RELAY_PROJECT_ID = 'custom-relay'
    let requestedUrl = ''
    const fakeFetch = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return okJsonResponse({ documents: [] })
    })
    await fetchRelayApplications(fakeFetch as unknown as typeof fetch)
    expect(requestedUrl).toContain('/projects/custom-relay/')
  })

  it('throws a readable error when the client key is missing', async () => {
    await expect(fetchRelayApplications()).rejects.toThrow(/SITEPOI_RELAY_APIKEY/)
  })

  it('throws a readable error on a non-ok response', async () => {
    process.env.SITEPOI_RELAY_APIKEY = 'legacy-api-key'
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(fetchRelayApplications(fakeFetch)).rejects.toThrow(/403/)
  })
})

describe('createSitepoiRegistryLookup (end to end over REST)', () => {
  it('resolves a registered host from the applications docs', async () => {
    process.env.SITEPOI_RELAY_APIKEY = 'legacy-api-key'
    const base64 = Buffer.from(
      JSON.stringify({ projectId: 'websites-a0e13', authTenant: 'test1' }),
    ).toString('base64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJsonResponse({
          documents: [
            fakeFirestoreDocument({
              hostNames: {
                arrayValue: { values: [{ stringValue: 'test1.sitepoi.com' }] },
              },
              fbSettings: {
                mapValue: { fields: { base64: { stringValue: base64 } } },
              },
            }),
          ],
        }),
      ),
    )
    try {
      const lookup = createSitepoiRegistryLookup()
      const tenant = await lookup('test1.sitepoi.com')
      expect(tenant).not.toBeNull()
      expect(tenant?.firebase?.projectId).toBe('websites-a0e13')
      expect(tenant?.authTenant).toBe('test1')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns null for hosts not in the registry', async () => {
    process.env.SITEPOI_RELAY_APIKEY = 'legacy-api-key'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJsonResponse({
          documents: [
            fakeFirestoreDocument({
              hostNames: {
                arrayValue: { values: [{ stringValue: 'other.com' }] },
              },
              fbSettings: { mapValue: { fields: { base64: { stringValue: 'e30=' } } } },
            }),
          ],
        }),
      ),
    )
    try {
      const lookup = createSitepoiRegistryLookup()
      expect(await lookup('test1.sitepoi.com')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('prefers an exact hostNames match over a *.wildcard match', async () => {
    process.env.SITEPOI_RELAY_APIKEY = 'legacy-api-key'
    const wildcardBase64 = Buffer.from(
      JSON.stringify({ projectId: 'websites-a0e13', authTenant: 'wildcard-tenant' }),
    ).toString('base64')
    const exactBase64 = Buffer.from(
      JSON.stringify({ projectId: 'websites-a0e13', authTenant: 'exact-tenant' }),
    ).toString('base64')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okJsonResponse({
          documents: [
            {
              name: 'projects/sitepoi-relay/databases/(default)/documents/applications/wildcard-app',
              ...fakeFirestoreDocument({
                hostNames: {
                  arrayValue: { values: [{ stringValue: '*.sitepoi.com' }] },
                },
                fbSettings: {
                  mapValue: { fields: { base64: { stringValue: wildcardBase64 } } },
                },
              }),
            },
            {
              name: 'projects/sitepoi-relay/databases/(default)/documents/applications/exact-app',
              ...fakeFirestoreDocument({
                hostNames: {
                  arrayValue: { values: [{ stringValue: 'test1.sitepoi.com' }] },
                },
                fbSettings: {
                  mapValue: { fields: { base64: { stringValue: exactBase64 } } },
                },
              }),
            },
          ],
        }),
      ),
    )
    try {
      const lookup = createSitepoiRegistryLookup()
      const tenant = await lookup('test1.sitepoi.com')
      expect(tenant?.authTenant).toBe('exact-tenant')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

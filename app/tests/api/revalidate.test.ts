import { describe, expect, it, vi } from 'vitest'
import { handleRevalidate } from '@/app/api/revalidate/route'
import { purgeTags } from '@/lib/cache/purge'
import { siteTag, pageTag, typeTag, hostTag, isPurgeableTag } from '@/lib/cache/tags'
import { dataEnv } from './data-fakes'

describe('POST /api/revalidate (Section 18)', () => {
  it('purges tags with the shared secret and rejects without it', async () => {
    const purged: string[][] = []
    const deps = {
      env: dataEnv,
      purge: async (tags: string[]) => {
        purged.push(tags)
        return tags
      },
    }

    const ok = await handleRevalidate(
      new Request('https://site-a.test/api/revalidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gw-host': 'site-a.test',
          'x-revalidate-secret': dataEnv.REVALIDATE_SECRET,
        },
        body: JSON.stringify({ tags: [pageTag('p1'), siteTag('site-a')] }),
      }),
      deps,
    )
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { purged: string[] }).purged).toEqual(['page-p1', 'site-site-a'])

    const unauthorized = await handleRevalidate(
      new Request('https://site-a.test/api/revalidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-revalidate-secret': 'wrong' },
        body: JSON.stringify({ tags: [pageTag('p1')] }),
      }),
      deps,
    )
    expect(unauthorized.status).toBe(401)

    const invalid = await handleRevalidate(
      new Request('https://site-a.test/api/revalidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': dataEnv.REVALIDATE_SECRET,
        },
        body: JSON.stringify({ tags: [] }),
      }),
      deps,
    )
    expect(invalid.status).toBe(400)
  })

  it('pings IndexNow for indexNowUrls when INDEXNOW_API_KEY is set (best effort)', async () => {
    const pings: Array<{ url: string; key: string }> = []
    const deps = {
      env: { ...dataEnv, INDEXNOW_API_KEY: 'k1' },
      purge: async (tags: string[]) => tags,
      indexNow: async (input: { url: string; key: string }) => {
        pings.push(input)
        return true
      },
    }

    const response = await handleRevalidate(
      new Request('https://site-a.test/api/revalidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': dataEnv.REVALIDATE_SECRET,
        },
        body: JSON.stringify({
          tags: [pageTag('p1')],
          indexNowUrls: ['https://site-a.test/about', 'https://site-a.test/menu-items/menu-1'],
        }),
      }),
      deps,
    )
    expect(response.status).toBe(200)
    expect(pings).toHaveLength(2)
    expect(pings[0]).toEqual({ url: 'https://site-a.test/about', key: 'k1' })
  })

  it('does not ping without indexNowUrls or a key', async () => {
    const pings: Array<{ url: string; key: string }> = []
    const deps = {
      env: dataEnv,
      purge: async (tags: string[]) => tags,
      indexNow: async (input: { url: string; key: string }) => {
        pings.push(input)
        return true
      },
    }
    const response = await handleRevalidate(
      new Request('https://site-a.test/api/revalidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': dataEnv.REVALIDATE_SECRET,
        },
        body: JSON.stringify({ tags: [pageTag('p1')] }),
      }),
      deps,
    )
    expect(response.status).toBe(200)
    expect(pings).toHaveLength(0)
  })
})

describe('purgeTags (tag vocabulary + resolver invalidation)', () => {
  it('revalidates each tag and clears resolver caches for site tags', async () => {
    const revalidated: string[] = []
    const cleared = vi.fn()
    const result = await purgeTags([siteTag('f1'), pageTag('p1'), 'bogus'], {
      revalidateTagImpl: (tag) => void revalidated.push(tag),
      clearResolverCaches: cleared,
    })
    expect(result).toEqual(['site-f1', 'page-p1'])
    expect(cleared).toHaveBeenCalledOnce()
  })

  it('does not clear caches for non-site tags', async () => {
    const cleared = vi.fn()
    await purgeTags([typeTag('app1'), hostTag('example.com')], {
      revalidateTagImpl: () => undefined,
      clearResolverCaches: cleared,
    })
    expect(cleared).not.toHaveBeenCalled()
  })

  it('validates the tag vocabulary', () => {
    expect(isPurgeableTag('site-a')).toBe(true)
    expect(isPurgeableTag('page-x')).toBe(true)
    expect(isPurgeableTag('type-y')).toBe(true)
    expect(isPurgeableTag('host-z')).toBe(true)
    expect(isPurgeableTag('random')).toBe(false)
    expect(isPurgeableTag(42)).toBe(false)
  })
})

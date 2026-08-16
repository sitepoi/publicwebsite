import { describe, expect, it } from 'vitest'
import {
  findSiblings,
  parsePath,
  resolveLanguage,
  resolvePage,
  selectPageObject,
  type PageObjectLoader,
} from '@/lib/resolver/page'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { SiteConfig } from '@/lib/resolver/site'

const site: SiteConfig = {
  host: 'www.site-a.com',
  tenant: { tenantId: 't', databaseProvider: 'firestore' },
  appId: 'website-builder-uniconbaseapps',
  folderId: 'folder-a',
  settings: { hostNames: ['www.site-a.com'], primaryHost: 'www.site-a.com', defaultLanguage: 'en' },
}

function record(overrides: Record<string, unknown>): ObjectRecord {
  return { id: 'page-x', cmsObjectType: site.appId, typeId: site.folderId, ...overrides }
}

function loaderWith(
  objects: ObjectRecord[],
  details: Record<string, ObjectRecord | null> = {},
): PageObjectLoader {
  return {
    queryInFolder: async ({ slug, folderId, cmsObjectType }) =>
      objects.filter(
        (candidate) =>
          candidate.cmsObjectType === cmsObjectType &&
          candidate.typeId === folderId &&
          (slug === undefined || candidate.slug === slug),
      ),
    getById: async ({ cmsObjectType, id }) =>
      objects.find(
        (candidate) => candidate.id === id && candidate.cmsObjectType === cmsObjectType,
      ) ??
      details[id] ??
      null,
    querySiblings: async (contentId) =>
      objects.filter((candidate) => candidate.contentId === contentId),
  }
}

describe('parsePath (Section 9 route kinds)', () => {
  it("'/' and '' are home", () => {
    expect(parsePath('/')).toEqual({ kind: 'home' })
    expect(parsePath('')).toEqual({ kind: 'home' })
  })

  it('single segment is a slug (trailing slash trimmed)', () => {
    expect(parsePath('/about')).toEqual({ kind: 'slug', slug: 'about' })
    expect(parsePath('/about/')).toEqual({ kind: 'slug', slug: 'about' })
  })

  it('two segments are cmsObjectType/id', () => {
    expect(parsePath('/products/p1')).toEqual({
      kind: 'object',
      cmsObjectType: 'products',
      id: 'p1',
    })
  })

  it('three segments under /t are template pages', () => {
    expect(parsePath('/t/recipe/c1')).toEqual({
      kind: 'template',
      template: 'recipe',
      contentId: 'c1',
    })
    expect(parsePath('/t/recipe')).toEqual({ kind: 'not-found' })
  })

  it('/app/... is a capability route (registered in M10)', () => {
    expect(parsePath('/app/order/42')).toEqual({ kind: 'app', rest: ['order', '42'] })
  })

  it('decodes percent-encoded segments', () => {
    expect(parsePath('/caf%C3%A9')).toEqual({ kind: 'slug', slug: 'café' })
  })

  it('unknown shapes are not-found', () => {
    expect(parsePath('/a/b/c')).toEqual({ kind: 'not-found' })
  })
})

describe('resolveLanguage (Section 9 step 4 — no locale path prefixes)', () => {
  it('returns settings.defaultLanguage', () => {
    expect(resolveLanguage(site.settings)).toBe('en')
    expect(resolveLanguage({ hostNames: ['x.com'], defaultLanguage: 'tr' })).toBe('tr')
    expect(resolveLanguage({ hostNames: ['x.com'] })).toBe('en')
  })
})

describe('selectPageObject (slug + language + draft rules)', () => {
  const candidates = [
    record({ id: 'en-about', slug: 'about', meta: { language: 'en' } }),
    record({ id: 'de-about', slug: 'about', meta: { language: 'de' } }),
    record({ id: 'legacy-about', slug: 'about' }), // no meta.language → default language
    record({
      id: 'draft-about',
      slug: 'about',
      meta: { language: 'en' },
      data: { status: 'draft' },
    }),
  ]

  it('matches slug + language', () => {
    expect(
      selectPageObject(candidates, { slug: 'about', language: 'en', defaultLanguage: 'en' })?.id,
    ).toBe('en-about')
    expect(
      selectPageObject(candidates, { slug: 'about', language: 'de', defaultLanguage: 'en' })?.id,
    ).toBe('de-about')
  })

  it('records without meta.language count as the default language', () => {
    const result = selectPageObject([record({ id: 'legacy', slug: 'about' })], {
      slug: 'about',
      language: 'en',
      defaultLanguage: 'en',
    })
    expect(result?.id).toBe('legacy')
  })

  it('drafts are hidden without preview and shown with preview (Q9)', () => {
    const draftOnly = [candidates[3]!]
    expect(
      selectPageObject(draftOnly, { slug: 'about', language: 'en', defaultLanguage: 'en' }),
    ).toBeNull()
    expect(
      selectPageObject(draftOnly, {
        slug: 'about',
        language: 'en',
        defaultLanguage: 'en',
        preview: true,
      })?.id,
    ).toBe('draft-about')
  })

  it('absent status = published (visible)', () => {
    expect(
      selectPageObject([candidates[0]!], { slug: 'about', language: 'en', defaultLanguage: 'en' }),
    ).not.toBeNull()
  })
})

describe('findSiblings (contentId → other languages)', () => {
  const page = record({
    id: 'en',
    slug: 'about',
    contentId: 'about-content',
    meta: { language: 'en' },
  })
  const objects = [
    page,
    record({ id: 'de', slug: 'uber-uns', contentId: 'about-content', meta: { language: 'de' } }),
    record({ id: 'tr', slug: 'hakkimizda', contentId: 'about-content', meta: { language: 'tr' } }),
    record({ id: 'en-dup', slug: 'about-2', contentId: 'about-content', meta: { language: 'en' } }),
    record({ id: 'other', slug: 'other', contentId: 'other-content', meta: { language: 'de' } }),
    record({ id: 'no-content', slug: 'x', meta: { language: 'de' } }),
  ]

  it('returns other languages with the same contentId, sorted', () => {
    expect(findSiblings(objects, page).map((candidate) => candidate.id)).toEqual(['de', 'tr'])
  })

  it('returns [] without contentId', () => {
    expect(findSiblings(objects, objects[5]!)).toEqual([])
  })
})

describe('resolvePage (acceptance: home/slug/type/template/404 + hreflang)', () => {
  const objects = [
    record({ id: 'home-en', slug: 'home-page', contentId: 'home', meta: { language: 'en' } }),
    record({ id: 'home-de', slug: 'home-page', contentId: 'home', meta: { language: 'de' } }),
    record({ id: 'about-en', slug: 'about', contentId: 'about-content', meta: { language: 'en' } }),
    record({
      id: 'about-de',
      slug: 'uber-uns',
      contentId: 'about-content',
      meta: { language: 'de' },
    }),
    record({ id: 'recipe', slug: 'recipe', meta: { language: 'en' } }),
    record({ id: 'drafty', slug: 'drafty', meta: { language: 'en' }, data: { status: 'draft' } }),
  ]
  const details = {
    p1: record({
      id: 'p1',
      cmsObjectType: 'products',
      slug: 'pizza',
      meta: { language: 'en' },
      data: { htmlPage: { code: { html: '<h1>pizza</h1>' } } },
    }),
  }
  const loader = loaderWith(objects, details)

  it("home: '/' resolves slug 'home-page' with language + siblings", async () => {
    const result = await resolvePage({ site, loader, path: '/' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.kind).toBe('home')
    expect(result.resolved.page.id).toBe('home-en')
    expect(result.resolved.siblings.map((candidate) => candidate.id)).toEqual(['home-de'])
  })

  it('home: language preference picks the matching object', async () => {
    const result = await resolvePage({ site, loader, path: '/', language: 'de' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.page.id).toBe('home-de')
    expect(result.resolved.siblings.map((candidate) => candidate.id)).toEqual(['home-en'])
  })

  it("slug: '/about' resolves by folder + object slug + meta.language", async () => {
    const result = await resolvePage({ site, loader, path: '/about' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.kind).toBe('slug')
    expect(result.resolved.page.id).toBe('about-en')
    expect(result.resolved.siblings.map((candidate) => candidate.id)).toEqual(['about-de'])
  })

  it("object-detail: '/products/p1' resolves the detail page kind", async () => {
    const result = await resolvePage({ site, loader, path: '/products/p1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.kind).toBe('object')
    expect(result.resolved.page.id).toBe('p1')
  })

  it("template: '/t/recipe/c1' resolves the template kind with contentId", async () => {
    const result = await resolvePage({ site, loader, path: '/t/recipe/c1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.resolved.kind).toBe('template')
    expect(result.resolved.page.id).toBe('recipe')
    expect(result.resolved.route).toEqual({ kind: 'template', template: 'recipe', contentId: 'c1' })
  })

  it('drafts are not-found without preview, resolved with preview', async () => {
    expect(await resolvePage({ site, loader, path: '/drafty' })).toEqual({
      ok: false,
      reason: 'not-found',
    })
    const previewed = await resolvePage({ site, loader, path: '/drafty', preview: true })
    expect(previewed.ok).toBe(true)
    if (!previewed.ok) return
    expect(previewed.resolved.page.id).toBe('drafty')
  })

  it('unknown paths are not-found', async () => {
    expect(await resolvePage({ site, loader, path: '/does-not-exist' })).toEqual({
      ok: false,
      reason: 'not-found',
    })
    expect(await resolvePage({ site, loader, path: '/a/b/c' })).toEqual({
      ok: false,
      reason: 'not-found',
    })
    expect(await resolvePage({ site, loader, path: '/t/recipe' })).toEqual({
      ok: false,
      reason: 'not-found',
    })
  })
})

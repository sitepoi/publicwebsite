import { describe, expect, it, vi } from 'vitest'
import {
  APP_STORE_LIBRARY_TYPE,
  buildIslandSsrLayer,
  collectIslandNames,
  createAppStoreCatalogResolver,
  extractCatalogEntries,
  parseCatalogRecord,
  resolveWidgetIslands,
  type WidgetCatalogRecord,
} from '@/lib/render/widget-islands'
import { createFixtureWidgetCatalogResolver } from '@/lib/data/providers/fixtures'

const counter: WidgetCatalogRecord = {
  gwAppName: 'store-counter',
  configSchema: { type: 'object', properties: { limit: { type: 'number', default: 2 } } },
  ssrHtml: '<div class="gw-ssr" data-testid="ssr-markup"><span>SSR count</span></div>',
  code: { html: '<span>client</span>', css: '.ssr { color: red }', js: 'register()' },
}

const staticOnly: WidgetCatalogRecord = {
  gwAppName: 'store-static',
  ssrEnabled: false,
  code: { js: 'registerStatic()' },
}

const noSsr: WidgetCatalogRecord = {
  gwAppName: 'store-no-ssr',
  code: { js: 'registerNoSsr()' },
}

const records = (): Map<string, WidgetCatalogRecord> =>
  new Map([
    ['store-counter', counter],
    ['store-static', staticOnly],
    ['store-no-ssr', noSsr],
  ])

describe('parseCatalogRecord', () => {
  it('reads field values from productData.data_categoriesBased (v2 envelope)', () => {
    const parsed = parseCatalogRecord({
      id: 'w1',
      _id: 'w1',
      cmsObjectType: APP_STORE_LIBRARY_TYPE,
      name: 'Store Counter',
      productData: {
        data_categoriesBased: {
          gwAppName: 'store-counter',
          title: 'Store Counter',
          ssrHtml: '<span>ssr</span>',
          code: { html: '<b>x</b>', css: '.a{}', js: 'void 0' },
        },
      },
    })
    expect(parsed?.gwAppName).toBe('store-counter')
    expect(parsed?.title).toBe('Store Counter')
    expect(parsed?.ssrHtml).toBe('<span>ssr</span>')
    expect(parsed?.code).toEqual({ html: '<b>x</b>', css: '.a{}', js: 'void 0' })
  })

  it('accepts a JSON-string code block and coerces ssrEnabled string "false"', () => {
    const parsed = parseCatalogRecord({
      gwAppName: 'store-static',
      ssrEnabled: 'false',
      code: '{"html":"<b>x</b>","css":".a{}","js":"void 0"}',
    })
    expect(parsed?.ssrEnabled).toBe(false)
    expect(parsed?.code).toEqual({ html: '<b>x</b>', css: '.a{}', js: 'void 0' })
  })

  it('prefers data_categoriesBased over top-level fields on collision', () => {
    const parsed = parseCatalogRecord({
      gwAppName: 'wrong-name',
      productData: { data_categoriesBased: { gwAppName: 'right-name' } },
    })
    expect(parsed?.gwAppName).toBe('right-name')
  })

  it('returns null for records without a gwAppName', () => {
    expect(parseCatalogRecord({ title: 'x' })).toBeNull()
    expect(parseCatalogRecord('nope')).toBeNull()
    expect(parseCatalogRecord(null)).toBeNull()
  })
})

describe('extractCatalogEntries', () => {
  it('accepts the canonical shape, bare arrays and tolerant keys', () => {
    expect(extractCatalogEntries({ data: [1, 2], nextCursor: 'c1' })).toEqual({
      records: [1, 2],
      nextCursor: 'c1',
    })
    expect(extractCatalogEntries({ objects: [3] })).toEqual({ records: [3], nextCursor: undefined })
    expect(extractCatalogEntries({ records: [4] })).toEqual({ records: [4], nextCursor: undefined })
    expect(extractCatalogEntries([5])).toEqual({ records: [5], nextCursor: undefined })
    expect(extractCatalogEntries({ data: 'nope' })).toEqual({
      records: [],
      nextCursor: undefined,
    })
  })
})

describe('buildIslandSsrLayer', () => {
  it('returns an empty layer for html without islands', () => {
    expect(buildIslandSsrLayer('<p>no islands</p>', records())).toEqual({
      serverHtml: '',
      names: [],
      unknownNames: [],
    })
  })

  it('injects ssrHtml after authored content and marks data-gw-ssr="1"', () => {
    const html =
      `<div data-gw-app="store-counter" data-gw-config='{"limit":3}'>` +
      `<p class="authored">before</p></div>`
    const result = buildIslandSsrLayer(html, records())

    expect(result.names).toEqual(['store-counter'])
    expect(result.unknownNames).toEqual([])
    expect(result.serverHtml).toContain('data-gw-app="store-counter"')
    expect(result.serverHtml).toContain('data-gw-ssr="1"')
    expect(result.serverHtml).toContain('data-testid="ssr-markup"')
    // ssrHtml appended AFTER the existing authored content.
    expect(result.serverHtml.indexOf('<p class="authored">before</p>')).toBeLessThan(
      result.serverHtml.indexOf('data-testid="ssr-markup"'),
    )
  })

  it('is deterministic across repeated renders', () => {
    const html = `<div data-gw-app="store-counter" data-gw-config='{"limit":3}'></div>`
    const first = buildIslandSsrLayer(html, records()).serverHtml
    const second = buildIslandSsrLayer(html, records()).serverHtml
    expect(first).toBe(second)
  })

  it('strips scripts from the emitted islands (nothing executes early)', () => {
    const html =
      `<div data-gw-app="store-counter"><script>window.boom = 1</script></div>`
    const result = buildIslandSsrLayer(html, records())
    expect(result.serverHtml).not.toContain('<script')
    expect(result.serverHtml).not.toContain('window.boom')
  })

  it('marks data-gw-ssr="none" when the record has no ssrHtml', () => {
    const result = buildIslandSsrLayer(
      '<div data-gw-app="store-no-ssr"></div>',
      records(),
    )
    expect(result.serverHtml).toContain('data-gw-app="store-no-ssr"')
    expect(result.serverHtml).toContain('data-gw-ssr="none"')
    expect(result.serverHtml).not.toContain('data-gw-ssr="1"')
  })

  it('marks data-gw-ssr="client" for ssrEnabled:false records (no server markup)', () => {
    const result = buildIslandSsrLayer('<div data-gw-app="store-static"></div>', records())
    expect(result.serverHtml).toContain('data-gw-app="store-static"')
    expect(result.serverHtml).toContain('data-gw-ssr="client"')
    expect(result.serverHtml).not.toContain('ssr-markup')
  })

  it('emits unknown names as empty islands with data-gw-ssr="none" and reports them', () => {
    const result = buildIslandSsrLayer(
      '<div data-gw-app="unknown-tool" data-gw-config=\'{}\'></div>',
      records(),
    )
    expect(result.unknownNames).toEqual(['unknown-tool'])
    expect(result.serverHtml).toContain('data-gw-app="unknown-tool"')
    expect(result.serverHtml).toContain('data-gw-ssr="none"')
    expect(result.serverHtml).not.toContain('data-gw-ssr="1"')
  })

  it('ignores platform builtin widgets entirely (client-only by design)', () => {
    const result = buildIslandSsrLayer(
      '<div data-gw-app="menu" data-gw-config=\'{}\'></div><div data-gw-app="cart"></div>',
      records(),
    )
    expect(result.names).toEqual([])
    expect(result.unknownNames).toEqual([])
    expect(result.serverHtml).toBe('')
  })

  it('emits multiple islands of the same name in order', () => {
    const result = buildIslandSsrLayer(
      '<div data-gw-app="store-counter"></div><div data-gw-app="store-counter"></div>',
      records(),
    )
    expect(result.serverHtml.match(/data-gw-ssr="1"/g)).toHaveLength(2)
  })
})

describe('collectIslandNames', () => {
  it('collects names across sources, deduped, in order, skipping builtins', () => {
    expect(
      collectIslandNames([
        '<div data-gw-app="store-counter"></div><div data-gw-app="menu"></div>',
        '<div data-gw-app="store-static"></div><div data-gw-app="store-counter"></div>',
        '',
        null,
      ]),
    ).toEqual(['store-counter', 'store-static'])
  })
})

describe('resolveWidgetIslands', () => {
  it('returns an empty plan without any catalog fetch when there are no islands', async () => {
    const resolve = vi.fn(async () => new Map<string, WidgetCatalogRecord>())
    const plan = await resolveWidgetIslands({
      pageHtml: '<p>plain</p>',
      sectionHtml: [],
      headerHtml: '',
      footerHtml: '',
      resolve,
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(plan).toEqual({
      pageServerHtml: '',
      headerServerHtml: '',
      footerServerHtml: '',
      widgetCss: [],
      widgetScripts: [],
      appSchemas: {},
      unknownNames: [],
    })
  })

  it('builds layers, css/js payloads, schemas and unknown warnings', async () => {
    const resolve = vi.fn(async () => records())
    const plan = await resolveWidgetIslands({
      pageHtml: '<div data-gw-app="store-counter"></div>',
      sectionHtml: ['<div data-gw-app="store-static"></div>'],
      headerHtml: '<div data-gw-app="store-counter"></div>',
      footerHtml: '<div data-gw-app="unknown-tool"></div>',
      resolve,
    })

    expect(resolve).toHaveBeenCalledWith(['store-counter', 'store-static', 'unknown-tool'])
    expect(plan.pageServerHtml).toContain('data-gw-ssr="1"') // page island
    expect(plan.pageServerHtml).toContain('data-gw-ssr="client"') // section island
    expect(plan.headerServerHtml).toContain('data-gw-ssr="1"')
    expect(plan.footerServerHtml).toContain('data-gw-ssr="none"') // unknown island
    expect(plan.unknownNames).toEqual(['unknown-tool'])
    expect(plan.widgetCss).toEqual([{ name: 'store-counter', css: counter.code.css }])
    expect(plan.widgetScripts).toEqual([
      { name: 'store-counter', js: 'register()' },
      { name: 'store-static', js: 'registerStatic()' },
    ])
    expect(plan.appSchemas).toEqual({ 'store-counter': counter.configSchema })
  })
})

describe('createAppStoreCatalogResolver', () => {
  function makeResponse(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }

  it('fetches the library type from the store v2 endpoint and parses records (first wins)', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse(200, {
        success: true,
        mainObjectType: APP_STORE_LIBRARY_TYPE,
        count: 2,
        nextCursor: '',
        objects: [
          { gwAppName: 'store-counter', ssrHtml: '<span>ssr</span>' },
          { gwAppName: 'store-counter', ssrHtml: '<span>duplicate ignored</span>' },
        ],
      }),
    ) as unknown as typeof fetch
    const resolver = createAppStoreCatalogResolver({ baseUrl: 'https://store.test/api/v2', fetchFn })

    const first = await resolver([])
    const url = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain(`https://store.test/api/v2/objects/${encodeURIComponent(APP_STORE_LIBRARY_TYPE)}`)
    expect(url).toContain('limit=200')
    expect(url).not.toContain('typeId=')
    const record = first.get('store-counter')
    expect(record?.ssrHtml).toBe('<span>ssr</span>')
  })

  it('sends the viewer API key as an x-api-key header', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse(200, { success: true, objects: [] }),
    ) as unknown as typeof fetch
    const resolver = createAppStoreCatalogResolver({
      baseUrl: 'https://store.test/api/v2',
      token: 'viewer-key-123',
      fetchFn,
    })
    await resolver([])
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      | RequestInit
      | undefined
    expect(init?.headers).toEqual({ 'x-api-key': 'viewer-key-123' })
  })

  it('follows nextCursor pagination', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse(200, { success: true, objects: [{ gwAppName: 'a' }], nextCursor: 'p2' }),
      )
      .mockResolvedValueOnce(makeResponse(200, { success: true, objects: [{ gwAppName: 'b' }], nextCursor: null }))
    const resolver = createAppStoreCatalogResolver({ baseUrl: 'https://s.test', fetchFn })
    const result = await resolver([])
    expect(result.size).toBe(2)
    const secondUrl = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as string
    expect(secondUrl).toContain('cursor=p2')
  })

  it('is fail-open: success:false responses warn and yield an empty catalog', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse(200, { success: false, error: { code: 'UNAUTHORIZED', message: 'nope' } }),
    ) as unknown as typeof fetch
    const warn = vi.fn()
    const resolver = createAppStoreCatalogResolver({
      baseUrl: 'https://s.test',
      fetchFn,
      warn,
    })
    const result = await resolver([])
    expect(result.size).toBe(0)
    expect(warn).toHaveBeenCalledWith('gw-app-store-unreachable', expect.any(Object))
  })

  it('is fail-open: a failed fetch warns and yields an empty catalog', async () => {
    const fetchFn = vi.fn(async () => makeResponse(503, {})) as unknown as typeof fetch
    const warn = vi.fn()
    const resolver = createAppStoreCatalogResolver({
      baseUrl: 'https://s.test',
      fetchFn,
      warn,
    })
    const result = await resolver([])
    expect(result.size).toBe(0)
    expect(warn).toHaveBeenCalledWith('gw-app-store-unreachable', expect.any(Object))
  })

  it('serves the previous successful catalog when a refresh fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(200, { data: [{ gwAppName: 'a' }] }))
      .mockRejectedValueOnce(new Error('down'))
    const resolver = createAppStoreCatalogResolver({
      baseUrl: 'https://s.test',
      fetchFn,
      ttlMs: 0, // force refresh on every call
    })
    await resolver([])
    const result = await resolver([])
    expect(result.has('a')).toBe(true)
  })

  it('caches successful catalogs for the TTL', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200, { data: [{ gwAppName: 'a' }] }))
    const resolver = createAppStoreCatalogResolver({
      baseUrl: 'https://s.test',
      fetchFn,
      ttlMs: 60_000,
    })
    await resolver([])
    await resolver([])
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('fixture widget catalog resolver', () => {
  it('serves the fixture library records (dev/e2e double)', async () => {
    const resolver = createFixtureWidgetCatalogResolver()
    const result = await resolver([])
    expect(result.get('store-counter')?.ssrHtml).toContain('store-counter-ssr')
    expect(result.get('store-counter')?.configSchema).toEqual({
      type: 'object',
      properties: { limit: { type: 'number', default: 2 } },
    })
    expect(result.get('store-static')?.ssrEnabled).toBe(false)
  })
})

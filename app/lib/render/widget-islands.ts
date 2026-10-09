import { parseFragment, serializeOuter, type DefaultTreeAdapterMap } from 'parse5'
import { z } from 'zod'
import { getEnv } from '@/lib/config/env'
import { getLogger } from '@/lib/log/logger'
import { createFixtureWidgetCatalogResolver } from '@/lib/data/providers/fixtures'

/**
 * Widget island SSR pipeline (PUBLICWEBSITE — WIDGET ISLAND PUBLISH
 * CONTRACT, SSR DEFAULT).
 *
 * Page builders emit islands as contract markup:
 *
 *   <div data-gw-app="Food Ordering Cart" data-gw-config='{}'></div>
 *
 * The catalog is the platform-owned library
 * `website-html-tool-library-applicationstore` served by the application
 * store host. Each record carries `gwAppName`, `configSchema`, `ssrHtml`,
 * `ssrEnabled` and `code.{html,css,js}`. The code + ssrHtml are fetched
 * SERVER-SIDE at render time (never from the browser) and cached.
 *
 * SSR (default) per island:
 *   - ssrHtml present        → injected inside the island + data-gw-ssr="1"
 *   - ssrHtml absent, code.html present
 *                            → code.html injected + data-gw-ssr="template"
 *   - neither                → data-gw-ssr="none" (no error, no crash)
 *   - ssrEnabled:false       → no server markup, data-gw-ssr="client"
 *   - unknown name/store down→ empty island + data-gw-ssr="none" + warning
 *   - platform builtins      → untouched (client-only by design, C12)
 *
 * The output is DETERMINISTIC for a given page version + catalog state
 * (no Math.random / time) — safe for Redis/CDN caching keyed by page version.
 *
 * This module is SERVER-ONLY (parse5 + fetch are never bundled client-side).
 */

type Parse5Node = DefaultTreeAdapterMap['childNode']
type Parse5Element = DefaultTreeAdapterMap['element']

/** The library object type served by the application store host. */
export const APP_STORE_LIBRARY_TYPE = 'website-html-tool-library-applicationstore'

/**
 * Platform builtin widget names (client-only, C12). MUST stay in sync with
 * `BUILTIN_WIDGETS` in lib/gw-sdk/sdk-source.ts — builtins are never resolved
 * against the app store catalog.
 */
export const PLATFORM_BUILTIN_APPS = [
  'menu',
  'cart',
  'checkout-flow',
  'slot-picker',
  'seat-map',
  'account-dashboard',
  'rewards',
  'order-status',
  'search-box',
  'list',
] as const

const BUILTIN_APP_SET: ReadonlySet<string> = new Set(PLATFORM_BUILTIN_APPS)

const DefaultAppStoreApiUrl = 'https://applicationstore.uniconhub.com/api/v2'
const DEFAULT_CATALOG_TTL_MS = 300_000
const DEFAULT_FETCH_TIMEOUT_MS = 10_000
const MAX_CATALOG_PAGES = 10

const WidgetCatalogRecordSchema = z
  .object({
    gwAppName: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    configSchema: z.unknown().optional(),
    ssrHtml: z.string().optional(),
    ssrEnabled: z.preprocess(
      (value) => (typeof value === 'string' && value.toLowerCase() === 'false' ? false : value),
      z.boolean().optional(),
    ),
    code: z.preprocess(
      (value) => {
        if (typeof value === 'string' && value.trim().startsWith('{')) {
          try {
            return JSON.parse(value) as unknown
          } catch {
            return value
          }
        }
        return value
      },
      z
        .object({
          html: z.string().optional(),
          css: z.string().optional(),
          js: z.string().optional(),
        })
        .catchall(z.unknown())
        .optional(),
    ),
  })
  .catchall(z.unknown())

export interface WidgetCatalogRecord {
  gwAppName: string
  /** Store record objectId — used to fetch the detail when the list omits
   * the code block (publish contract Section 3 "Record detail"). */
  id?: string
  title?: string
  description?: string
  category?: string
  configSchema?: unknown
  ssrHtml?: string
  ssrEnabled?: boolean
  code: { html?: string; css?: string; js?: string }
}

/** Resolves catalog records for the given island names (Map by gwAppName). */
export interface WidgetCatalogResolver {
  (names: string[]): Promise<Map<string, WidgetCatalogRecord>>
}

/**
 * Parse one catalog entry into a WidgetCatalogRecord. v2 objects[] items are
 * raw Firestore docs with NO top-level "data" wrapper — tool fields live
 * under `productData.data_categoriesBased` (CMS v2 envelope). Fields may also
 * appear at the top level or under a legacy `data` wrapper; all are accepted,
 * with `data_categoriesBased` winning on collision. `code` may arrive as a
 * JSON string.
 */
export function parseCatalogRecord(record: unknown): WidgetCatalogRecord | null {
  if (typeof record !== 'object' || record === null) return null
  const recordAsObject = record as Record<string, unknown>
  const categoriesBased =
    isRecord(recordAsObject.productData) &&
    isRecord((recordAsObject.productData as { data_categoriesBased?: unknown }).data_categoriesBased)
      ? ((recordAsObject.productData as { data_categoriesBased: object }).data_categoriesBased as object)
      : null
  const source = categoriesBased
    ? { ...recordAsObject, ...(isRecord(recordAsObject.data) ? recordAsObject.data : {}), ...categoriesBased }
    : record
  const parsed = WidgetCatalogRecordSchema.safeParse(source)
  if (!parsed.success) return null
  const code = parsed.data.code ?? {}
  const recordId =
    typeof recordAsObject.id === 'string' && recordAsObject.id.length > 0
      ? recordAsObject.id
      : typeof recordAsObject._id === 'string'
        ? recordAsObject._id
        : undefined
  return {
    gwAppName: parsed.data.gwAppName,
    ...(recordId !== undefined ? { id: recordId } : {}),
    ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
    ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
    ...(parsed.data.configSchema !== undefined ? { configSchema: parsed.data.configSchema } : {}),
    ...(parsed.data.ssrHtml !== undefined ? { ssrHtml: parsed.data.ssrHtml } : {}),
    ...(parsed.data.ssrEnabled !== undefined ? { ssrEnabled: parsed.data.ssrEnabled } : {}),
    code: { html: code.html ?? '', css: code.css ?? '', js: code.js ?? '' },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tolerant extraction of the raw record array from a store response. The
 * canonical shape is `{ data: [...], nextCursor? }`; `{ objects }`, `{ records }`
 * and bare arrays are also accepted so the endpoint may evolve.
 */
export function extractCatalogEntries(
  payload: unknown,
): { records: unknown[]; nextCursor?: string } {
  if (Array.isArray(payload)) return { records: payload }
  if (isRecord(payload)) {
    for (const key of ['data', 'objects', 'records'] as const) {
      const candidate = payload[key]
      if (Array.isArray(candidate)) {
        const nextCursor =
          typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0
            ? payload.nextCursor
            : undefined
        return { records: candidate, nextCursor }
      }
    }
  }
  return { records: [] }
}

export interface AppStoreCatalogConfig {
  baseUrl: string
  token?: string
  ttlMs?: number
  fetchTimeoutMs?: number
  fetchFn?: typeof fetch
  warn?: (message: string, context?: Record<string, unknown>) => void
}

/** Merge a lean list record with its fetched detail (detail wins when set). */
function mergeCatalogRecords(
  base: WidgetCatalogRecord,
  detail: WidgetCatalogRecord,
): WidgetCatalogRecord {
  const pick = <T>(detailValue: T | undefined, baseValue: T | undefined): T | undefined =>
    detailValue ?? baseValue
  return {
    gwAppName: detail.gwAppName || base.gwAppName,
    ...(pick(detail.id, base.id) !== undefined ? { id: pick(detail.id, base.id) } : {}),
    ...(pick(detail.title, base.title) !== undefined ? { title: pick(detail.title, base.title) } : {}),
    ...(pick(detail.description, base.description) !== undefined
      ? { description: pick(detail.description, base.description) }
      : {}),
    ...(pick(detail.category, base.category) !== undefined
      ? { category: pick(detail.category, base.category) }
      : {}),
    ...(pick(detail.configSchema, base.configSchema) !== undefined
      ? { configSchema: pick(detail.configSchema, base.configSchema) }
      : {}),
    ...(pick(detail.ssrHtml, base.ssrHtml) !== undefined
      ? { ssrHtml: pick(detail.ssrHtml, base.ssrHtml) }
      : {}),
    ...(pick(detail.ssrEnabled, base.ssrEnabled) !== undefined
      ? { ssrEnabled: pick(detail.ssrEnabled, base.ssrEnabled) }
      : {}),
    code: {
      html: detail.code.html || base.code.html || '',
      css: detail.code.css || base.code.css || '',
      js: detail.code.js || base.code.js || '',
    },
  }
}

/** Does the record carry any of its three code blocks? */
function recordHasCode(record: WidgetCatalogRecord): boolean {
  const code = record.code ?? {}
  return Boolean((code.html ?? '').trim() || (code.css ?? '').trim() || (code.js ?? '').trim())
}

/**
 * HTTP catalog resolver over the platform-owned application store v2 API.
 *
 * GET {baseUrl}/objects/{APP_STORE_LIBRARY_TYPE}?limit=200[&cursor=<lastId>]
 * x-api-key: <viewer service key>  (scope objects:read — every v2 request
 * must authenticate, CMS contract)
 *
 * Response: { success, mainObjectType, count, nextCursor, objects: [...] };
 * nextCursor empty/null = last page; a 200 body with success:false is
 * treated as a failure (fail-open).
 *
 * Successes are cached in-memory for `ttlMs` (default 5 min — the store has
 * no publish push event today, CMS confirmed TTL-only is acceptable). A
 * failed fetch is fail-open: the previous successful catalog (if any) is
 * served, else an empty catalog — an unreachable store NEVER breaks the
 * page. All duplicates resolve first-wins for determinism.
 */
export function createAppStoreCatalogResolver(
  config: AppStoreCatalogConfig,
): WidgetCatalogResolver {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const token = config.token
  const ttlMs = config.ttlMs ?? DEFAULT_CATALOG_TTL_MS
  const fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const fetchFn = config.fetchFn ?? fetch
  const warn = config.warn

  let cache: { at: number; records: Map<string, WidgetCatalogRecord> } | null = null

  return async function resolveWidgetCatalog(): Promise<Map<string, WidgetCatalogRecord>> {
    const now = Date.now()
    if (cache && now - cache.at < ttlMs) return cache.records

    const records = new Map<string, WidgetCatalogRecord>()
    try {
      let cursor: string | undefined
      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const params = new URLSearchParams({ limit: '200' })
        if (cursor) params.set('cursor', cursor)
        const url = `${baseUrl}/objects/${encodeURIComponent(APP_STORE_LIBRARY_TYPE)}?${params.toString()}`
        const response = await fetchFn(url, {
          headers: token ? { 'x-api-key': token } : undefined,
          signal: AbortSignal.timeout(fetchTimeoutMs),
          cache: 'no-store',
        })
        if (!response.ok) {
          throw new Error(`application store responded ${response.status}`)
        }
        const payload: unknown = await response.json()
        if (isRecord(payload) && payload.success === false) {
          throw new Error('application store rejected the request (success:false)')
        }
        const { records: entries, nextCursor } = extractCatalogEntries(payload)
        for (const entry of entries) {
          const record = parseCatalogRecord(entry)
          if (record && !records.has(record.gwAppName)) records.set(record.gwAppName, record)
        }
        if (!nextCursor) break
        cursor = nextCursor
      }

      // Lean catalogs omit `code`: fetch the detail per record by objectId
      // (publish contract Section 3 "Record detail" — REQUIRED capability).
      // Detail failures are fail-open (the lean record stays, islands render
      // as data-gw-ssr="none").
      const pendingDetails: Array<{ id: string; name: string }> = []
      for (const record of records.values()) {
        if (!record.id || recordHasCode(record)) continue
        pendingDetails.push({ id: record.id, name: record.gwAppName })
      }
      if (pendingDetails.length > 0) {
        await Promise.all(
          pendingDetails.map(async ({ id, name }) => {
            try {
              const detailUrl = `${baseUrl}/objects/${encodeURIComponent(APP_STORE_LIBRARY_TYPE)}/${encodeURIComponent(id)}`
              const detailResponse = await fetchFn(detailUrl, {
                headers: token ? { 'x-api-key': token } : undefined,
                signal: AbortSignal.timeout(fetchTimeoutMs),
                cache: 'no-store',
              })
              if (!detailResponse.ok) return
              const detailPayload: unknown = await detailResponse.json()
              const detailSource =
                isRecord(detailPayload) && isRecord(detailPayload.object)
                  ? detailPayload.object
                  : detailPayload
              const detail = parseCatalogRecord(detailSource)
              const existing = records.get(name)
              if (detail && detail.gwAppName === name && existing) {
                records.set(name, mergeCatalogRecords(existing, detail))
              }
            } catch {
              /* fail-open: keep the lean record */
            }
          }),
        )
      }
      cache = { at: now, records }
    } catch (error) {
      warn?.('gw-app-store-unreachable', {
        message: error instanceof Error ? error.message : String(error),
      })
      return cache ? cache.records : new Map<string, WidgetCatalogRecord>()
    }
    return records
  }
}

/** Lazy per-process catalog resolver (fixture-aware — never used in tests). */
let widgetCatalogResolver: WidgetCatalogResolver | null = null

/**
 * Invalidate the catalog cache (publish webhook path): the store publishes a
 * tool update → triggerRevalidate → POST /api/revalidate → this clears the
 * cached catalog so the next render refetches it (TTL-only is NOT acceptable —
 * the cache key includes the PAGE version, not the widget version).
 */
export function clearAppStoreCatalogCache(): void {
  widgetCatalogResolver = null
}

export function getWidgetCatalogResolver(): WidgetCatalogResolver {
  if (widgetCatalogResolver) return widgetCatalogResolver
  if (getEnv().GW_DEV_FIXTURES === '1') {
    widgetCatalogResolver = createFixtureWidgetCatalogResolver()
    return widgetCatalogResolver
  }
  widgetCatalogResolver = createAppStoreCatalogResolver({
    baseUrl: getEnv().GW_APP_STORE_API_URL ?? DefaultAppStoreApiUrl,
    token: getEnv().GW_APP_STORE_API_KEY,
    ttlMs: getEnv().GW_APP_STORE_CACHE_TTL_MS,
    warn: (message, context) => getLogger().warn(context, message),
  })
  return widgetCatalogResolver
}

// ---------------------------------------------------------------------------
// Island discovery + SSR layer transform (pure, deterministic — parse5 based)
// ---------------------------------------------------------------------------

function isElement(node: Parse5Node): node is Parse5Element {
  return 'tagName' in node && typeof (node as Parse5Element).tagName === 'string'
}

function attributeOf(element: Parse5Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value
}

function setAttribute(element: Parse5Element, name: string, value: string): void {
  const existing = element.attrs.find((attr) => attr.name === name)
  if (existing) existing.value = value
  else element.attrs.push({ name, value, namespace: undefined, prefix: undefined })
}

/** Remove <script> descendants (SSR output must never execute code early). */
function stripScripts(node: Parse5Node): void {
  if (!isElement(node)) return
  node.childNodes = node.childNodes.filter((child) => {
    if (isElement(child) && child.tagName === 'script') return false
    stripScripts(child)
    return true
  })
}

export interface IslandSsrResult {
  /** Island elements only (order of appearance) for the SSR first paint. */
  serverHtml: string
  /** Island names found, in order of appearance, deduped (builtins excluded). */
  names: string[]
  /** Names with no catalog record — the caller logs a warning per name. */
  unknownNames: string[]
}

const EMPTY_ISLAND_RESULT: IslandSsrResult = { serverHtml: '', names: [], unknownNames: [] }

/**
 * Extract the SSR layer of one html source: every island element that has a
 * catalog record is emitted (with ssrHtml injected / data-gw-ssr marked);
 * unknown names are only reported. Scripts are stripped from the emitted
 * islands so nothing executes during the initial parse.
 */
export function buildIslandSsrLayer(
  html: string,
  records: ReadonlyMap<string, WidgetCatalogRecord>,
): IslandSsrResult {
  if (!/data-gw-app/i.test(html)) return EMPTY_ISLAND_RESULT
  const fragment = parseFragment(html)

  const names: string[] = []
  const unknownNames: string[] = []
  const emitted: string[] = []

  const visit = (node: Parse5Node): void => {
    if (!isElement(node)) return
    if (node.tagName === 'script') return

    const appName = (attributeOf(node, 'data-gw-app') ?? '').trim()
    if (appName) {
      if (BUILTIN_APP_SET.has(appName)) return // client-only builtin (C12)
      if (!names.includes(appName)) names.push(appName)
      const record = records.get(appName)
      if (!record) {
        // Unknown name / store down: empty island + data-gw-ssr="none" +
        // warning (WebpageBuilder-confirmed marker semantics).
        if (!unknownNames.includes(appName)) unknownNames.push(appName)
        setAttribute(node, 'data-gw-ssr', 'none')
        stripScripts(node)
        emitted.push(serializeOuter(node))
        return
      }
      const nodeForSsr = node
      if (record.ssrEnabled === false) {
        setAttribute(nodeForSsr, 'data-gw-ssr', 'client')
      } else if (typeof record.ssrHtml === 'string' && record.ssrHtml.trim().length > 0) {
        // Append the placeholder AFTER any existing authored content.
        const placeholder = parseFragment(record.ssrHtml)
        for (const child of Array.from(placeholder.childNodes)) {
          nodeForSsr.childNodes.push(child)
        }
        setAttribute(nodeForSsr, 'data-gw-ssr', '1')
      } else if ((record.code.html ?? '').trim().length > 0) {
        // No dedicated ssrHtml → the widget's own code.html is the SSR markup
        // (website-html-tool contract Step A.2.b, data-gw-ssr="template").
        const template = parseFragment(record.code.html ?? '')
        for (const child of Array.from(template.childNodes)) {
          nodeForSsr.childNodes.push(child)
        }
        setAttribute(nodeForSsr, 'data-gw-ssr', 'template')
      } else {
        setAttribute(nodeForSsr, 'data-gw-ssr', 'none')
      }
      stripScripts(nodeForSsr)
      emitted.push(serializeOuter(nodeForSsr))
      return // islands are flat by contract — never descend inside one
    }

    for (const child of node.childNodes) visit(child)
  }

  for (const child of fragment.childNodes) visit(child)

  return {
    serverHtml: emitted.join('\n'),
    names,
    unknownNames,
  }
}

/** Island names across html sources, in order, deduped (builtins excluded). */
export function collectIslandNames(htmlSources: Array<string | null | undefined>): string[] {
  const names: string[] = []
  for (const html of htmlSources) {
    if (!html || !/data-gw-app/i.test(html)) continue
    const fragment = parseFragment(html)
    const visit = (node: Parse5Node): void => {
      if (!isElement(node)) return
      const appName = (attributeOf(node, 'data-gw-app') ?? '').trim()
      if (appName) {
        if (!BUILTIN_APP_SET.has(appName) && !names.includes(appName)) names.push(appName)
        return // flat islands — never descend inside one
      }
      for (const child of node.childNodes) visit(child)
    }
    for (const child of fragment.childNodes) visit(child)
  }
  return names
}

export interface WidgetScriptEntry {
  name: string
  js: string
}

export interface WidgetCssEntry {
  name: string
  css: string
}

export interface WidgetIslandPlan {
  /** SSR layer for the page ContentMount (page html + sections). */
  pageServerHtml: string
  /** SSR layer for the header chrome ContentMount. */
  headerServerHtml: string
  /** SSR layer for the footer chrome ContentMount. */
  footerServerHtml: string
  /** Widget stylesheets (used anywhere on the page) — injected AFTER page css. */
  widgetCss: WidgetCssEntry[]
  /** Widget code.js blocks (used anywhere on the page) — run after page js,
   *  before auto-mount; each MUST call gw.apps.register (idempotent). */
  widgetScripts: WidgetScriptEntry[]
  /** configSchema per used name — the SDK applies defaults for missing keys. */
  appSchemas: Record<string, unknown>
  /** Island names with no catalog record — caller logs a warning each. */
  unknownNames: string[]
}

const EMPTY_WIDGET_PLAN: WidgetIslandPlan = {
  pageServerHtml: '',
  headerServerHtml: '',
  footerServerHtml: '',
  widgetCss: [],
  widgetScripts: [],
  appSchemas: {},
  unknownNames: [],
}

export interface ResolveWidgetIslandsInput {
  pageHtml: string
  sectionHtml: string[]
  headerHtml: string | null | undefined
  footerHtml: string | null | undefined
  resolve: WidgetCatalogResolver
}

/**
 * Per-page widget pipeline (server-side): discover islands across the page
 * content, sections and chrome → resolve the catalog → build the SSR layer,
 * the hydration payloads (css/js) and the config schemas. Returns an empty
 * plan when the page has no app-store islands (no fetch at all).
 */
export async function resolveWidgetIslands(
  input: ResolveWidgetIslandsInput,
): Promise<WidgetIslandPlan> {
  const sources = [
    input.pageHtml,
    ...input.sectionHtml,
    input.headerHtml ?? '',
    input.footerHtml ?? '',
  ]
  const names = collectIslandNames(sources)
  if (names.length === 0) return EMPTY_WIDGET_PLAN

  const records = await input.resolve(names)

  const pageLayer = buildIslandSsrLayer(input.pageHtml, records)
  const sectionLayers = input.sectionHtml.map((html) => buildIslandSsrLayer(html, records))
  const headerLayer = buildIslandSsrLayer(input.headerHtml ?? '', records)
  const footerLayer = buildIslandSsrLayer(input.footerHtml ?? '', records)

  const unknownNames = [...pageLayer.unknownNames, ...headerLayer.unknownNames, ...footerLayer.unknownNames]
  for (const layer of sectionLayers) {
    for (const name of layer.unknownNames) {
      if (!unknownNames.includes(name)) unknownNames.push(name)
    }
  }

  const usedNames = names.filter((name) => records.has(name))
  const widgetCss: WidgetCssEntry[] = []
  const widgetScripts: WidgetScriptEntry[] = []
  const appSchemas: Record<string, unknown> = {}
  for (const name of usedNames) {
    const record = records.get(name)
    if (!record) continue
    if ((record.code.css ?? '').trim()) widgetCss.push({ name, css: record.code.css ?? '' })
    if ((record.code.js ?? '').trim()) widgetScripts.push({ name, js: record.code.js ?? '' })
    if (record.configSchema !== undefined && isRecord(record.configSchema)) {
      appSchemas[name] = record.configSchema
    }
  }

  return {
    pageServerHtml: [pageLayer.serverHtml, ...sectionLayers.map((layer) => layer.serverHtml)]
      .filter((html) => html.length > 0)
      .join('\n'),
    headerServerHtml: headerLayer.serverHtml,
    footerServerHtml: footerLayer.serverHtml,
    widgetCss,
    widgetScripts,
    appSchemas,
    unknownNames,
  }
}

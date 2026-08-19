// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGwBootstrapScript } from '@/lib/gw-sdk'
import type { GwContext } from '@/lib/gw-sdk'

const baseContext: GwContext = {
  pageId: 'home-page',
  siteId: 'site-a',
  folderId: 'site-a',
  language: 'en',
  host: 'site-a.test',
  currency: 'USD',
  query: { utm_source: 'x' },
  pathParams: {},
}

/** Executes the generated bootstrap source in the happy-dom window. */
function runBootstrap(context: GwContext): void {
  const script = buildGwBootstrapScript(context)
  // The script is self-contained; execute against the test window.
  new Function(script)()
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function stubFetch(
  body: unknown,
  status = 200,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
    makeResponse(status, body),
  )
}

function fetchInit(fetchMock: ReturnType<typeof stubFetch>): RequestInit {
  return (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit
}

function makeForm(): HTMLFormElement {
  document.body.innerHTML =
    '<form data-gw-form id="f">' +
    '<input name="email" type="email" required>' +
    '<input name="msg" value="hi">' +
    '<input name="gw_hp" data-gw-honeypot>' +
    '<span data-gw-form-status></span>' +
    '<button type="submit">Go</button>' +
    '</form>'
  return document.getElementById('f') as HTMLFormElement
}

beforeEach(() => {
  ;(window as unknown as { gw?: unknown }).gw = undefined
  window.localStorage.clear()
  window.sessionStorage.clear()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bootstrap source string (Section 12)', () => {
  it('is a self-contained script with serialized context (DOMPurify vendored separately)', () => {
    const script = buildGwBootstrapScript(baseContext)
    expect(script).toContain('function installGwSdk')
    expect(script).toContain('"pageId":"home-page"')
    expect(script).not.toContain('</script>')
    expect(script).not.toContain('RELAY_SECRET')
  })

  it('runs without errors and installs the typed context', () => {
    const ready = vi.fn()
    window.addEventListener('gw:ready', ready)
    expect(() => runBootstrap(baseContext)).not.toThrow()
    expect(window.gw.pageId).toBe('home-page')
    expect(window.gw.siteId).toBe('site-a')
    expect(window.gw.folderId).toBe('site-a')
    expect(window.gw.language).toBe('en')
    expect(window.gw.host).toBe('site-a.test')
    expect(ready).toHaveBeenCalledOnce()
  })

  it('exposes a fresh gw.ns object per install (C14)', () => {
    runBootstrap(baseContext)
    const first = window.gw.ns
    expect(first).toBeTypeOf('object')
    first['init'] = () => 'page helper'
    expect(window.gw.ns['init']).toBeTypeOf('function')

    // Re-install (SPA navigation) → a NEW namespace, old helpers do not leak.
    runBootstrap(baseContext)
    expect(window.gw.ns).not.toBe(first)
    expect(window.gw.ns['init']).toBeUndefined()

    // A server-provided ns is used when present.
    const provided: Record<string, unknown> = { seed: 42 }
    runBootstrap({ ...baseContext, ns: provided })
    expect(window.gw.ns['seed']).toBe(42)
  })
})

describe('gw.storage (host-scoped + session)', () => {
  it('stores under a per-hostname key prefix', () => {
    runBootstrap(baseContext)
    window.gw.storage.set('k', 'v')
    expect(window.localStorage.getItem('gw:v1:site-a.test:local:k')).toBe('v')
    expect(window.gw.storage.get('k')).toBe('v')
  })

  it('isolates hosts and separates session storage', () => {
    runBootstrap(baseContext)
    window.gw.storage.set('k', 'v-a')
    window.gw.storage.session.set('k', 'v-session')

    runBootstrap({ ...baseContext, host: 'other.test' })
    window.gw.storage.set('k', 'v-b')

    expect(window.gw.storage.get('k')).toBe('v-b')
    expect(window.localStorage.getItem('gw:v1:site-a.test:local:k')).toBe('v-a')
    expect(window.localStorage.getItem('gw:v1:other.test:local:k')).toBe('v-b')
    expect(window.sessionStorage.getItem('gw:v1:site-a.test:session:k')).toBe('v-session')
    expect(window.gw.storage.session.get('k')).toBeNull()
  })

  it('remove clears the scoped key', () => {
    runBootstrap(baseContext)
    window.gw.storage.set('k', 'v')
    window.gw.storage.remove('k')
    expect(window.gw.storage.get('k')).toBeNull()
  })
})

describe('gw.getPageParams / navigate / onRouteChange', () => {
  it('merges query + pathParams', () => {
    runBootstrap({ ...baseContext, query: { a: '1' }, pathParams: { slug: 'about' } })
    expect(window.gw.getPageParams()).toEqual({ a: '1', slug: 'about' })
  })

  it('navigate dispatches ic-navigate and notifies route listeners', () => {
    runBootstrap(baseContext)
    const nav = vi.fn()
    window.addEventListener('ic-navigate', (event) => nav((event as CustomEvent).detail))
    const route = vi.fn()
    window.gw.onRouteChange(route)

    window.gw.navigate('/about')
    expect(nav).toHaveBeenCalledWith({ href: '/about' })
    expect(route).toHaveBeenCalledOnce()
  })

  it('onRouteChange returns an unsubscribe', () => {
    runBootstrap(baseContext)
    const route = vi.fn()
    const off = window.gw.onRouteChange(route)
    off()
    window.gw.navigate('/x')
    expect(route).not.toHaveBeenCalled()
  })
})

describe('gw.sanitize / format helpers', () => {
  it('sanitize strips event handlers (DOMPurify or escaping fallback)', () => {
    runBootstrap(baseContext)
    const result = window.gw.sanitize('<img src=x onerror=alert(1)><b>ok</b>')
    expect(result).not.toContain('onerror')
    if (window.DOMPurify) expect(result).toContain('<b>ok</b>')
  })

  it('formatCurrency and formatDate use Intl with site language/currency', () => {
    runBootstrap(baseContext)
    expect(window.gw.formatCurrency(12.5)).toBe('$12.50')
    expect(window.gw.formatCurrency(10, 'TRY')).toContain('10')
    expect(window.gw.formatDate('2026-08-15').length).toBeGreaterThan(0)
  })
})

describe('gw.forms (Section 14 client contract)', () => {
  it('submits JSON, fires gw:form-success with the response data', async () => {
    const fetchMock = stubFetch({ ok: true, id: 'r1' })
    runBootstrap(baseContext)
    vi.stubGlobal('fetch', fetchMock)

    const form = makeForm()
    ;(form.querySelector('[name="email"]') as HTMLInputElement).value = 'a@b.co'
    const success = vi.fn()
    form.addEventListener('gw:form-success', success)

    const result = await window.gw.forms.submit(form)
    expect(result.ok).toBe(true)
    expect(success).toHaveBeenCalledOnce()
    const detail = (success.mock.calls[0]?.[0] as CustomEvent).detail as { data: unknown }
    expect(detail.data).toEqual({ ok: true, id: 'r1' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/forms/submit',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(String(fetchInit(fetchMock).body)) as Record<string, unknown>
    const values = body.values as Record<string, string>
    expect(values.email).toBe('a@b.co')
    expect(values.msg).toBe('hi')
  })

  it('dispatches gw:form-invalid for empty required fields without fetching', async () => {
    const fetchMock = stubFetch({})
    runBootstrap(baseContext)
    vi.stubGlobal('fetch', fetchMock)

    const form = makeForm()
    const invalid = vi.fn()
    form.addEventListener('gw:form-invalid', invalid)

    const result = await window.gw.forms.submit(form)
    expect(result.ok).toBe(false)
    expect(invalid).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('silently ignores honeypot submissions (no fetch, no events)', async () => {
    const fetchMock = stubFetch({})
    runBootstrap(baseContext)
    vi.stubGlobal('fetch', fetchMock)

    const form = makeForm()
    ;(form.querySelector('[name="email"]') as HTMLInputElement).value = 'a@b.co'
    ;(form.querySelector('[name="gw_hp"]') as HTMLInputElement).value = 'bot'
    const anyEvent = vi.fn()
    form.addEventListener('gw:form-success', anyEvent)
    form.addEventListener('gw:form-error', anyEvent)
    form.addEventListener('gw:form-invalid', anyEvent)

    const result = await window.gw.forms.submit(form)
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(anyEvent).not.toHaveBeenCalled()
  })

  it('dispatches gw:form-error with status on server errors', async () => {
    const fetchMock = stubFetch('boom', 500)
    vi.stubGlobal('fetch', fetchMock)
    runBootstrap(baseContext)

    const form = makeForm()
    ;(form.querySelector('[name="email"]') as HTMLInputElement).value = 'a@b.co'
    const error = vi.fn()
    form.addEventListener('gw:form-error', error)

    const result = await window.gw.forms.submit(form)
    expect(result.ok).toBe(false)
    expect(error).toHaveBeenCalledOnce()
    const detail = (error.mock.calls[0]?.[0] as CustomEvent).detail as {
      error: string
      status: number
    }
    expect(detail.error).toBe('boom')
    expect(detail.status).toBe(500)
  })

  it('uses multipart FormData when file inputs are present', async () => {
    const fetchMock = stubFetch({ ok: true })
    runBootstrap(baseContext)
    vi.stubGlobal('fetch', fetchMock)

    document.body.innerHTML =
      '<form data-gw-form id="f2"><input name="email" required><input name="attach" type="file"><button type="submit">Go</button></form>'
    const form = document.getElementById('f2') as HTMLFormElement
    ;(form.querySelector('[name="email"]') as HTMLInputElement).value = 'a@b.co'
    const fileInput = form.querySelector('[name="attach"]') as HTMLInputElement
    Object.defineProperty(fileInput, 'files', {
      value: { 0: new File(['x'], 'a.txt'), length: 1 },
    })

    await window.gw.forms.submit(form)
    expect(fetchInit(fetchMock).body).toBeInstanceOf(FormData)
  })

  it('bind wires forms idempotently and prevents default', async () => {
    const fetchMock = stubFetch({ ok: true })
    runBootstrap(baseContext)
    vi.stubGlobal('fetch', fetchMock)

    const form = makeForm()
    window.gw.forms.bind()
    window.gw.forms.bind()
    ;(form.querySelector('[name="email"]') as HTMLInputElement).value = 'a@b.co'

    const success = vi.fn()
    form.addEventListener('gw:form-success', success)
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(success).toHaveBeenCalledOnce())
  })
})

describe('gw.db stubs (Section 29 — endpoints arrive in C7)', () => {
  it('query POSTs /api/data/query and returns the result', async () => {
    const fetchMock = stubFetch({ items: [{ id: 'o1' }], total: 1 })
    vi.stubGlobal('fetch', fetchMock)
    runBootstrap(baseContext)

    const result = await window.gw.db.query({ cmsObjectType: 'menu-items' })
    expect(result).toEqual({ items: [{ id: 'o1' }], total: 1 })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/data/query',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('get returns null on 404', async () => {
    const fetchMock = stubFetch({}, 404)
    vi.stubGlobal('fetch', fetchMock)
    runBootstrap(baseContext)

    expect(await window.gw.db.get({ cmsObjectType: 'products', objectId: 'p1' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/data/products/p1')
  })

  it('operation POSTs /api/data/op with {operation, payload}', async () => {
    const fetchMock = stubFetch({ ok: true })
    runBootstrap(baseContext)
    vi.stubGlobal('fetch', fetchMock)

    await window.gw.db.operation('create-order', { items: [] })
    expect(JSON.parse(String(fetchInit(fetchMock).body))).toEqual({
      operation: 'create-order',
      payload: { items: [] },
    })
  })

  it('subscribe uses SSE when EventSource is available (C11)', () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = []
      url: string
      listeners: Record<string, ((message: { data: string; type: string }) => void) | undefined> =
        {}
      closed = false
      constructor(url: string) {
        this.url = url
        FakeEventSource.instances.push(this)
      }
      addEventListener(type: string, handler: (message: { data: string; type: string }) => void) {
        this.listeners[type] = handler
      }
      dispatch(type: string, data: string) {
        this.listeners[type]?.({ type, data })
      }
      close() {
        this.closed = true
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    runBootstrap(baseContext)

    const changes: unknown[] = []
    const unsubscribe = window.gw.db.subscribe({ cmsObjectType: 'orders' }, (change) =>
      changes.push(change),
    )

    const source = FakeEventSource.instances[0]
    expect(source?.url).toBe('/api/subscribe?cmsObjectType=orders')

    source?.dispatch('added', JSON.stringify({ id: 'o1', cmsObjectType: 'orders' }))
    expect(changes).toEqual([{ type: 'added', object: { id: 'o1', cmsObjectType: 'orders' } }])

    source?.dispatch(
      'gw-event',
      JSON.stringify({ id: 'e1', type: 'operation.completed', payload: { operationId: 'x' } }),
    )
    expect(changes[1]).toMatchObject({ type: 'gw-event' })

    unsubscribe()
    expect(source?.closed).toBe(true)
  })

  it('subscribe falls back to polling when EventSource is missing', async () => {
    vi.stubGlobal('EventSource', undefined)
    const fetchMock = stubFetch({ items: [], total: 0 })
    vi.stubGlobal('fetch', fetchMock)
    runBootstrap(baseContext)
    const unsubscribe = window.gw.db.subscribe({}, () => undefined)
    expect(typeof unsubscribe).toBe('function')
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/data/query',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    unsubscribe()
  })
})

describe('gw.apps stubs (Section 35 — full implementation in C12)', () => {
  it('register + mount call factories with {el, config, gw}', () => {
    runBootstrap(baseContext)
    document.body.innerHTML =
      '<div data-gw-app="menu" data-gw-config=\'{"limit":3}\'></div><div data-gw-app="unknown"></div>'

    const factory = vi.fn()
    window.gw.apps.register('menu', factory)
    const appError = vi.fn()
    document.addEventListener('gw:app-error', appError)

    window.gw.apps.mount()
    expect(factory).toHaveBeenCalledOnce()
    const ctx = factory.mock.calls[0]?.[0] as { config: unknown; gw: unknown; el: unknown }
    expect(ctx.config).toEqual({ limit: 3 })
    expect(ctx.gw).toEqual(window.gw)
    expect(appError).toHaveBeenCalledOnce()
  })
})

describe('auth + services', () => {
  it('auth resolves anonymous when the session endpoint has no user', async () => {
    const fetchMock = stubFetch({ user: null })
    vi.stubGlobal('fetch', fetchMock)
    runBootstrap(baseContext)
    await window.gw.authReady
    expect(window.gw.getUser()).toBeNull()
    expect(window.gw.isAuthenticated()).toBe(false)
  })

  it('auth exposes the session user after boot (session persistence)', async () => {
    const fetchMock = stubFetch({ user: { id: 'u1', email: 'a@b.co', roles: ['customer'] } })
    vi.stubGlobal('fetch', fetchMock)
    runBootstrap(baseContext)
    const user = await window.gw.authReady
    expect(user).toEqual({ id: 'u1', email: 'a@b.co', roles: ['customer'] })
    expect(window.gw.getUser()).toEqual(user)
    expect(window.gw.isAuthenticated()).toBe(true)
  })

  it('login navigates to the first-party login page with returnUrl', () => {
    runBootstrap(baseContext)
    window.gw.login('/account')
    expect(window.location.href).toContain('/p/user/login?returnUrl=%2Faccount')
  })

  it('service rejects (C6+/M9)', async () => {
    runBootstrap(baseContext)
    await window.gw.authReady
    await expect(window.gw.service('search')).rejects.toThrow(/not available/)
  })
})

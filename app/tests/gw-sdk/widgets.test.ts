// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGwBootstrapScript, WIDGETS_SOURCE } from '@/lib/gw-sdk'
import type { GwContext } from '@/lib/gw-sdk'

const baseContext: GwContext = {
  pageId: 'widgets',
  siteId: 'site-a',
  folderId: 'site-a',
  language: 'en',
  host: 'site-a.test',
  currency: 'USD',
  query: {},
  pathParams: {},
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

type RouteMap = Record<string, { status?: number; body: unknown | (() => unknown) }>

function stubRoutes(routes: RouteMap) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        const body = typeof route.body === 'function' ? route.body() : route.body
        return makeResponse(route.status ?? 200, body)
      }
    }
    return makeResponse(404, { error: 'not-found' })
  })
}

function install() {
  new Function(buildGwBootstrapScript(baseContext))()
  new Function(WIDGETS_SOURCE)()
}

beforeEach(() => {
  const win = window as unknown as Record<string, unknown>
  win['gw'] = undefined
  win['gwWidgetsLoaded'] = undefined
  win['__gwWidgetsLoaded'] = undefined
  win['__gwWidgetsLoading'] = undefined
  win['__gwAppFactories'] = undefined
  window.localStorage.clear()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('widget library v1 (Section 35 / C12)', () => {
  it('menu widget renders rows from gw.db.query (emulator objects)', async () => {
    vi.stubGlobal(
      'fetch',
      stubRoutes({
        '/api/data/query': {
          body: {
            items: [
              { id: 'm1', name: 'Burger', price: 5, cmsObjectType: 'menu-items' },
              { id: 'm2', name: 'Drink', price: 3, cmsObjectType: 'menu-items' },
            ],
            total: 2,
          },
        },
      }),
    )
    install()
    document.body.innerHTML =
      '<div data-gw-app="menu" data-gw-config=\'{"cmsObjectType":"menu-items"}\'></div>'
    window.gw.apps.mount()

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="gw-menu-row"]')).toHaveLength(2)
    })
    const rows = Array.from(document.querySelectorAll('[data-testid="gw-menu-row"]'))
    expect(rows[0]?.textContent).toContain('Burger')
    expect(rows[0]?.textContent).toContain('Price: 5')
  })

  it('cart widget renders server items and re-renders on gw:cart-changed', async () => {
    let counter = 0
    vi.stubGlobal(
      'fetch',
      stubRoutes({
        '/api/cart': {
          body: () => {
            counter++
            return {
              items: [
                {
                  name: 'Burger',
                  price: 5,
                  qty: counter === 1 ? 1 : 2,
                  cmsObjectType: 'menu-items',
                  objectId: 'm1',
                },
              ],
              total: counter === 1 ? 5 : 10,
              count: 1,
            }
          },
        },
      }),
    )
    install()
    document.body.innerHTML = '<div data-gw-app="cart"></div>'
    window.gw.apps.mount()

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="gw-cart-row"]')?.textContent).toContain('x 1')
    })

    window.dispatchEvent(new CustomEvent('gw:cart-changed'))
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="gw-cart-row"]')?.textContent).toContain('x 2')
    })
  })

  it('slot-picker disables booked slots from data', async () => {
    vi.stubGlobal(
      'fetch',
      stubRoutes({
        '/api/data/query': {
          body: {
            items: [
              { id: 's1', label: '10:00', booked: false, cmsObjectType: 'slots' },
              { id: 's2', label: '11:00', booked: true, cmsObjectType: 'slots' },
            ],
            total: 2,
          },
        },
      }),
    )
    install()
    document.body.innerHTML =
      '<div data-gw-app="slot-picker" data-gw-config=\'{"cmsObjectType":"slots"}\'></div>'
    window.gw.apps.mount()

    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="gw-slot-button"]')).toHaveLength(2)
    })
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="gw-slot-button"]'),
    )
    expect(buttons[0]?.disabled).toBe(false)
    expect(buttons[1]?.disabled).toBe(true)
    expect(buttons[1]?.className).toContain('gw-slot-booked')
  })

  it('surfaces config errors gracefully (no throw, inline message)', async () => {
    install()
    document.body.innerHTML = '<div data-gw-app="menu"></div>'
    window.gw.apps.mount()
    expect(document.querySelector('[data-gw-app="menu"]')?.textContent).toContain(
      'cmsObjectType is required',
    )
  })

  it('mount is idempotent and SPA-safe; unmount re-enables remount', () => {
    install()
    let calls = 0
    window.gw.apps.register('counter', (ctx) => {
      calls++
      ctx.el.textContent = String(calls)
      return () => {
        ctx.el.textContent = 'cleaned'
      }
    })
    document.body.innerHTML = '<div data-gw-app="counter"></div>'

    window.gw.apps.mount()
    expect(calls).toBe(1)
    window.gw.apps.mount() // re-run from data.html scripts on route change
    expect(calls).toBe(1)

    window.gw.apps.unmount()
    expect(document.querySelector('[data-gw-app="counter"]')?.textContent).toBe('cleaned')
    window.gw.apps.mount()
    expect(calls).toBe(2)
  })

  it('unregistered apps dispatch gw:app-error', () => {
    install()
    document.body.innerHTML = '<div data-gw-app="nope"></div>'
    const error = vi.fn()
    document.addEventListener('gw:app-error', error)
    window.gw.apps.mount()
    expect(error).toHaveBeenCalledOnce()
    const detail = (error.mock.calls[0]?.[0] as CustomEvent).detail as { name: string }
    expect(detail.name).toBe('nope')
  })

  it('re-registering a widget replaces the factory (idempotent registration)', () => {
    install()
    const first = vi.fn()
    const second = vi.fn()
    window.gw.apps.register('dup', first)
    window.gw.apps.register('dup', second)
    document.body.innerHTML = '<div data-gw-app="dup"></div>'
    window.gw.apps.mount()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('rewards widget reads the ledger via a config-driven filter', async () => {
    vi.stubGlobal(
      'fetch',
      stubRoutes({
        '/api/auth/session': { body: { user: { id: 'u1', email: 'a@b.co', roles: ['customer'] } } },
        '/api/data/query': {
          body: {
            items: [
              { id: 'r1', customerId: 'u1', points: 12 },
              { id: 'r2', customerId: 'u1', points: 8 },
            ],
            total: 2,
          },
        },
      }),
    )
    install()
    await window.gw.authReady
    document.body.innerHTML =
      '<div data-gw-app="rewards" data-gw-config=\'{"cmsObjectType":"rewards","customerField":"customerId","pointsField":"points"}\'></div>'
    window.gw.apps.mount()

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="gw-rewards-total"]')?.textContent).toBe(
        'Points: 20',
      )
    })
  })
})

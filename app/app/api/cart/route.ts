import { randomUUID } from 'node:crypto'
import { getEnv, type Env } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'
import type { DataProvider } from '@/lib/data/provider'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { CartCallSchema } from '@/lib/contracts/services'
import { DEFAULT_TRAFFIC_RULES, evaluateTraffic, type TrafficRules } from '@/lib/security/traffic'
import { getClientIp, hashIp } from '@/lib/security/guards'
import { createMemoryRateLimiter, type RateLimiter } from '@/lib/cache/memory'
import { readField } from '@/lib/data/common'
import { getAuthService, type AuthService } from '@/lib/auth'
import { SESSION_COOKIE } from '@/app/api/auth/session/route'
import type { SiteResolution } from '@/lib/resolver/site'

/**
 * /api/cart (Section 15 / PART B) — SERVER cart keyed by an anon-token
 * cookie (`gw-cart`) or the user session (`user-<uid>`). Items CRUD; totals
 * ALWAYS computed server-side from the product's stored price. The cart is
 * pure data — checkout goes through flows (C8).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const CART_COOKIE = 'gw-cart'
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const CART_RATE_MAX = 60
export const CART_RATE_WINDOW_MS = 60_000
export const CART_COLLECTION = 'carts'

export interface CartItem {
  cmsObjectType: string
  objectId: string
  name: string
  price: number
  qty: number
}

export interface CartDoc {
  id: string
  items: CartItem[]
  updatedAt?: string
}

export interface CartDeps {
  env?: Env
  resolveSite?: (host: string) => Promise<SiteResolution>
  providerFor?: (tenant: TenantConfig) => DataProvider
  authService?: AuthService
  rateLimiter?: RateLimiter
  trafficRules?: TrafficRules
  now?: () => Date
}

function cartTotal(items: CartItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.price * item.qty, 0) * 100) / 100
}

export async function handleCart(request: Request, deps: CartDeps = {}): Promise<Response> {
  const env = deps.env ?? getEnv()
  const trafficRules = deps.trafficRules ?? DEFAULT_TRAFFIC_RULES

  const url = new URL(request.url)
  if (
    evaluateTraffic(
      { userAgent: request.headers.get('user-agent'), text: `${url.pathname}${url.search}` },
      trafficRules,
    ).blocked
  ) {
    return json({ error: 'blocked' }, 403)
  }

  const host = request.headers.get('x-gw-host') ?? request.headers.get('host') ?? ''
  const siteResult = await (deps.resolveSite ?? getResolverStack().resolveSite)(host)
  if (!siteResult.ok) return json({ error: 'site-not-found' }, 404)
  const site = siteResult.site
  const provider = (deps.providerFor ?? ((tenant) => getResolverStack().getProvider(tenant)))(
    site.tenant,
  )
  const collection = `${CART_COLLECTION}${site.tenant.tableExtension ?? ''}`
  const authService = deps.authService ?? (await getAuthService())

  const cartId = await cartIdentity(request, authService)

  if (request.method === 'GET') {
    const cart = await loadCart(provider, collection, cartId)
    const items = cart?.items ?? []
    return json({ items, total: cartTotal(items), count: items.length, cartId })
  }

  const limiter = deps.rateLimiter ?? sharedLimiter()
  const rate = limiter.check(`cart:${hashIp(getClientIp(request), env.RELAY_SECRET)}`)
  if (!rate.allowed)
    return json({ error: 'rate-limited', retryAfterMs: rate.retryAfterMs ?? 0 }, 429)

  const parsed = CartCallSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-cart-call' }, 400)
  const call = parsed.data

  // Honeypot — silent.
  if (call.gw_hp && call.gw_hp.trim().length > 0) return json({ ok: true, items: [] })

  const existing = await loadCart(provider, collection, cartId)
  let items = existing?.items ?? []

  if (call.action === 'clear') {
    items = []
  } else {
    const item = call.item
    if (call.action === 'remove') {
      items = items.filter(
        (entry) =>
          !(entry.cmsObjectType === item.cmsObjectType && entry.objectId === item.objectId),
      )
    } else {
      // add | update — price ALWAYS from the stored product (server-side).
      const product = await provider.getObject({ type: item.cmsObjectType, id: item.objectId })
      if (!product) return json({ error: 'product-not-found' }, 404)
      const priceValue = readField(product, 'price')
      const price = typeof priceValue === 'number' ? priceValue : Number(priceValue)
      if (!Number.isFinite(price)) return json({ error: 'product-not-priced' }, 400)

      const qty = 'qty' in item ? item.qty : 0
      const existingEntry = items.find(
        (entry) => entry.cmsObjectType === item.cmsObjectType && entry.objectId === item.objectId,
      )
      const snapshot: CartItem = {
        cmsObjectType: item.cmsObjectType,
        objectId: item.objectId,
        name:
          typeof readField(product, 'name') === 'string'
            ? String(readField(product, 'name'))
            : item.objectId,
        price,
        qty: call.action === 'add' && existingEntry ? existingEntry.qty + qty : qty,
      }
      items = existingEntry
        ? items.map((entry) => (entry === existingEntry ? snapshot : entry))
        : [...items, snapshot]
    }
  }

  const doc: CartDoc = {
    id: cartId,
    items,
    updatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  }
  if (existing)
    await provider.updateRecord({
      collection,
      id: cartId,
      data: doc as unknown as Record<string, unknown>,
    })
  else
    await provider.createRecord({
      collection,
      id: cartId,
      data: doc as unknown as Record<string, unknown>,
    })

  const response = json({
    ok: true,
    items,
    total: cartTotal(items),
    count: items.length,
    cartId,
  })
  if (!readCookie(request.headers.get('cookie'), CART_COOKIE)) {
    response.headers.set(
      'Set-Cookie',
      `${CART_COOKIE}=${encodeURIComponent(cartId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CART_COOKIE_MAX_AGE_SECONDS}`,
    )
  }
  return response
}

async function cartIdentity(request: Request, authService: AuthService): Promise<string> {
  const sessionCookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (sessionCookie) {
    const user = await authService.userFromSessionCookie(sessionCookie)
    if (user) return `user-${user.uid}`
  }
  return readCookie(request.headers.get('cookie'), CART_COOKIE) ?? `anon-${randomUUID()}`
}

async function loadCart(
  provider: DataProvider,
  collection: string,
  cartId: string,
): Promise<CartDoc | null> {
  const data = await provider.getRecord({ collection, id: cartId })
  if (!data) return null
  const items = Array.isArray(data['items']) ? (data['items'] as CartItem[]) : []
  return {
    id: cartId,
    items,
    updatedAt: typeof data['updatedAt'] === 'string' ? data['updatedAt'] : undefined,
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

let limiterSingleton: RateLimiter | null = null

function sharedLimiter(): RateLimiter {
  if (!limiterSingleton) {
    limiterSingleton = createMemoryRateLimiter({
      max: CART_RATE_MAX,
      windowMs: CART_RATE_WINDOW_MS,
    })
  }
  return limiterSingleton
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleCart(request)
}

export async function POST(request: Request): Promise<Response> {
  return handleCart(request)
}

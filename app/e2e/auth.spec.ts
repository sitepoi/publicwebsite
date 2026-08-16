import { expect, test } from '@playwright/test'

/**
 * C9 acceptance (Section 17): register → session cookie set → gated page
 * redirects anonymous visitors → account/orders returns ONLY the caller's
 * orders. Runs against the dev server in fixture mode (GW_DEV_FIXTURES=1)
 * with the in-memory fixture auth + seeded orders (lib/auth/fixture.ts,
 * lib/data/providers/fixtures).
 */
test('auth acceptance: register → cookie → gated redirect → own orders', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()

  // Register (tolerate a reused dev server where the email already exists).
  await page.goto('http://localhost:3000/p/user/register')
  await page.fill('input[name="email"]', 'user@example.com')
  await page.fill('input[name="password"]', 'password123')
  await page.click('button[type="submit"]')
  await page.waitForURL('http://localhost:3000/', { timeout: 15_000 }).catch(() => undefined)
  if (!page.url().startsWith('http://localhost:3000/')) {
    // Email already exists (reused dev server) → sign in instead.
    await page.goto('http://localhost:3000/p/user/login')
    await page.fill('input[name="email"]', 'user@example.com')
    await page.fill('input[name="password"]', 'password123')
    await page.click('button[type="submit"]')
    await page.waitForURL('http://localhost:3000/', { timeout: 15_000 })
  }

  // Session cookie: HttpOnly + SameSite=Lax.
  const cookies = await context.cookies()
  const session = cookies.find((cookie) => cookie.name === 'gw-session')
  expect(session).toBeTruthy()
  expect(session?.httpOnly).toBe(true)
  expect(session?.sameSite).toBe('Lax')

  // SDK session is visible to content scripts.
  await expect.poll(() => page.evaluate(() => window.gw?.isAuthenticated() ?? false)).toBe(true)

  // Gated page: anonymous → redirect to the first-party login page.
  const anonContext = await browser.newContext()
  const anonPage = await anonContext.newPage()
  await anonPage.goto('http://localhost:3000/account')
  await expect(anonPage).toHaveURL(/\/p\/user\/login\?returnUrl=%2Faccount/)

  // Gated page: authenticated → renders.
  await page.goto('http://localhost:3000/account')
  await expect(page.getByTestId('fixture-account')).toBeVisible()

  // Account scoping: ONLY the caller's orders (seeded foreign order excluded).
  const orders = await page.evaluate(async () => {
    const response = await fetch('/api/account/orders')
    if (!response.ok) return { status: response.status, items: [] }
    return response.json()
  })
  expect(orders.items).toHaveLength(1)
  expect(orders.items[0]).toMatchObject({ id: 'order-own', total: 42 })

  // Session persistence across requests (me).
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session')
    return response.json()
  })
  expect(me.user.email).toBe('user@example.com')

  await anonContext.close()
  await context.close()
})

import { expect, test, type Page } from '@playwright/test'

/**
 * C13 acceptance — two sample vertical pilots built ONLY from CMS config +
 * data.html (fixture mode), plus the M4 SEO routes and the M10 /app
 * capability page. Runs against the dev server with GW_DEV_FIXTURES=1.
 * Payment is mocked via the flow engine's PaymentIntent stub (Section 31).
 */
const PILOT_EMAIL = 'pilot-buyer@example.com'
const PILOT_PASSWORD = 'password123'

async function signIn(page: Page): Promise<void> {
  // Deterministic API sign-in (register when absent, then login) — avoids
  // racing the first-party form pages under parallel workers.
  await page.goto('http://localhost:3000/')
  const ok = await page.evaluate(
    async ({ email, password }) => {
      await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', email, password }),
      }).catch(() => null)
      const login = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', email, password }),
      })
      return login.ok
    },
    { email: PILOT_EMAIL, password: PILOT_PASSWORD },
  )
  expect(ok).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin' })
        const data = (await response.json().catch(() => null)) as {
          user?: { email?: string }
        } | null
        return data?.user?.email ?? null
      }),
    )
    .toBe(PILOT_EMAIL)
}

test('Pilot A — restaurant order completes end-to-end (payment mocked)', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page)

  await page.goto('http://localhost:3000/restaurant')
  await expect(page.getByTestId('fixture-restaurant')).toBeVisible()

  // Categories rendered via gw.db.query from data.html.
  await expect(page.getByTestId('restaurant-categories')).toHaveText('Mains')

  // Menu widget lists the menu-items objects.
  const rows = page.locator('[data-testid="gw-menu-row"]')
  await expect(rows).toHaveCount(2)

  // Add "Menu Item 1" ($5) to the cart.
  await rows.filter({ hasText: 'Menu Item 1' }).locator('button.gw-menu-add').click()
  await expect(page.getByTestId('gw-cart-list')).toContainText('Menu Item 1')

  // Checkout flow: cart → delivery → payment → done. Wait for each step's
  // re-render before advancing (the flow form is replaced asynchronously).
  await page.fill('input[name="total"]', '5')
  await page.click('[data-testid="gw-flow-form"] button[type="submit"]')
  await expect(page.locator('input[name="address"]')).toBeVisible()
  await page.fill('input[name="address"]', '1 Main St')
  await page.click('[data-testid="gw-flow-form"] button[type="submit"]')
  // Payment step has no inputs — wait until the form has re-rendered to it.
  await expect(page.locator('[data-testid="gw-flow-form"] input')).toHaveCount(0)
  await page.click('[data-testid="gw-flow-form"] button[type="submit"]')
  await expect(page.locator('button.gw-flow-complete')).toBeVisible()
  await page.click('button.gw-flow-complete')
  await expect(page.getByTestId('gw-flow-done')).toHaveText('Completed')

  // Order-status widget (mounted with the created order id, refreshed via
  // subscribe) shows the new order.
  await expect(page.getByTestId('gw-order-status')).toHaveText('Status: new', {
    timeout: 15_000,
  })
})

test('Pilot B — bus ticket purchase + PNR lookup end-to-end (payment mocked)', async ({
  browser,
}) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page)

  // Search page: search-box widget + trip links via gw.db.query.
  await page.goto('http://localhost:3000/tickets')
  await expect(page.getByTestId('fixture-tickets')).toBeVisible()
  await expect(page.getByTestId('trip-link').filter({ hasText: 'Airport Express' })).toBeVisible()
  await page.fill('[data-testid="gw-search-input"]', 'Airport')
  await expect(page.locator('.gw-search-hit').filter({ hasText: 'Airport Express' })).toBeVisible()

  // Template route /t/bus/<id> renders the TRIP's own data.html (M8 content
  // fetch) — not the template's.
  await page.click('[data-testid="trip-link"]')
  await expect(page).toHaveURL(/\/t\/bus\/trip-101/)
  await expect(page.getByTestId('fixture-trip')).toContainText('Airport Express')

  // Seat-map widget: booked seat disabled, open seats enabled.
  await expect(page.locator('.gw-seat-booked').first()).toBeDisabled()
  await expect(page.locator('button.gw-seat:not(.gw-seat-booked)').first()).toBeEnabled()

  // Ticket checkout: seats → passengers → payment (per-seat formula) → done.
  await page.fill('input[name="count"]', '2')
  await page.click('[data-testid="gw-flow-form"] button[type="submit"]')
  await expect(page.locator('input[name="name"]')).toBeVisible()
  await page.fill('input[name="name"]', 'Alice Cooper')
  await page.click('[data-testid="gw-flow-form"] button[type="submit"]')
  await expect(page.locator('[data-testid="gw-flow-form"] input')).toHaveCount(0)
  await page.click('[data-testid="gw-flow-form"] button[type="submit"]')
  await expect(page.locator('button.gw-flow-complete')).toBeVisible()
  await page.click('button.gw-flow-complete')
  await expect(page.getByTestId('gw-flow-done')).toHaveText('Completed')

  // PNR page lists the issued ticket.
  await page.click('#pnr-link')
  await expect(page).toHaveURL(/\/pnr/)
  const pnrRow = page.getByTestId('pnr-row').filter({ hasText: 'Alice Cooper' })
  await expect(pnrRow).toContainText('2 seat(s)')
  await expect(pnrRow).toContainText('issued')
})

test('M4 — sitemap.xml / robots.txt / llms.txt served per host', async ({ request }) => {
  const sitemap = await request.get('http://localhost:3000/sitemap.xml')
  expect(sitemap.status()).toBe(200)
  const xml = await sitemap.text()
  expect(xml).toContain('<urlset')
  expect(xml).toContain('https://site-a.test/restaurant')
  expect(xml).toContain('https://site-a.test/tickets')

  const robots = await request.get('http://localhost:3000/robots.txt')
  expect(robots.status()).toBe(200)
  expect(await robots.text()).toContain('Sitemap:')

  const llms = await request.get('http://localhost:3000/llms.txt')
  expect(llms.status()).toBe(200)
  expect(await llms.text()).toContain('Restaurant Order')
})

test('M10 — /app/<appId> renders the registered capability page', async ({ page }) => {
  await page.goto('http://localhost:3000/app/booking')
  await expect(page.getByTestId('fixture-app-booking')).toContainText('Booking console')
  await page.goto('http://localhost:3000/app/does-not-exist')
  await expect(page.getByText(/not found/i).first()).toBeVisible()
})

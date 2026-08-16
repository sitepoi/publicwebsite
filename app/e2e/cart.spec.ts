import { expect, test } from '@playwright/test'

/**
 * C10 cart acceptance: the SERVER cart (anon-token cookie) survives SPA
 * navigation. Runs in fixture mode (GW_DEV_FIXTURES=1) — the seeded
 * `menu-items/menu-1` product has price 5 (lib/data/providers/fixtures).
 */
test('server cart persists across SPA navigation', async ({ page }) => {
  await page.goto('http://localhost:3000/')

  // Add via the cart API — price and totals are SERVER-side.
  const added = await page.evaluate(async () => {
    const response = await fetch('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        item: { cmsObjectType: 'menu-items', objectId: 'menu-1', qty: 2 },
      }),
    })
    return response.json()
  })
  expect(added.total).toBe(10)
  expect(added.items[0]).toMatchObject({ objectId: 'menu-1', price: 5, qty: 2 })

  // SPA navigation away (data-ic-nav-href) — the cart must survive.
  await page.click('#nav-about')
  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByTestId('fixture-about')).toBeVisible()

  // SPA navigation back home.
  await page.goBack()
  await expect(page.getByTestId('fixture-home')).toBeVisible()

  const cart = await page.evaluate(async () => {
    const response = await fetch('/api/cart')
    return response.json()
  })
  expect(cart.count).toBe(1)
  expect(cart.total).toBe(10)
})

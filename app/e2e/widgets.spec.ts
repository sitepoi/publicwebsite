import { expect, test } from '@playwright/test'

/**
 * C12 acceptance (Section 35): the widget demo page renders the menu from
 * fixture objects, the cart widget persists across SPA navigation, and the
 * slot-picker disables booked slots from data. Runs in fixture mode.
 */
test('widget demo: menu, persistent cart, booked slot disabled', async ({ page }) => {
  await page.goto('http://localhost:3000/widgets')
  await expect(page.getByTestId('fixture-widgets')).toBeVisible()

  // Menu renders from fixture objects (menu-items folder menu-folder).
  const menu = page.getByTestId('gw-menu-list')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('gw-menu-row')).toHaveCount(2)
  await expect(menu).toContainText('Menu Item 1')
  await expect(menu).toContainText('Drink')

  // Slot-picker: 10:00 enabled, 11:00 (booked) disabled.
  const slots = page.getByTestId('gw-slots')
  await expect(slots).toBeVisible()
  const slotButtons = slots.getByTestId('gw-slot-button')
  await expect(slotButtons).toHaveCount(2)
  await expect(slotButtons.nth(0)).toBeEnabled()
  await expect(slotButtons.nth(1)).toBeDisabled()

  // Add 'Menu Item 1' (price 5) → cart widget shows the server total.
  await menu
    .getByTestId('gw-menu-row')
    .filter({ hasText: 'Menu Item 1' })
    .getByRole('button', { name: 'Add' })
    .click()
  const cart = page.getByTestId('gw-cart-list')
  await expect(cart.getByTestId('gw-cart-row')).toHaveCount(1)
  await expect(cart.getByTestId('gw-cart-total')).toContainText('$5.00')

  // SPA navigation away and back — the server cart persists.
  await page.evaluate(() => window.gw.navigate('/about'))
  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByTestId('fixture-about')).toBeVisible()
  await page.evaluate(() => window.gw.navigate('/widgets'))
  await expect(page).toHaveURL(/\/widgets$/)

  await expect(page.getByTestId('gw-cart-row')).toHaveCount(1)
  await expect(page.getByTestId('gw-cart-total')).toContainText('$5.00')
})

test('widget demo: list widget renders items as inert text (C14)', async ({ page }) => {
  await page.goto('http://localhost:3000/widgets')
  await expect(page.getByTestId('fixture-widgets')).toBeVisible()

  const list = page.getByTestId('gw-list')
  await expect(list).toBeVisible()
  await expect(list.getByTestId('gw-list-row')).toHaveCount(2)
  await expect(list).toContainText('Menu Item 1')
  await expect(list).toContainText('Drink')
  await expect(list.locator('img')).toHaveCount(0)
})

test('sections compose in order; missing/private skipped; trace comment present (C14)', async ({
  page,
}) => {
  await page.goto('http://localhost:3000/sections')
  await expect(page.getByTestId('fixture-sections')).toBeVisible()
  await expect(page.getByTestId('fixture-section-a')).toBeVisible()
  await expect(page.getByTestId('fixture-section-b')).toBeVisible()
  await expect(page.getByTestId('fixture-page-own')).toBeVisible()
  await expect(page.getByTestId('fixture-section-private')).toHaveCount(0)

  // Order: section A before section B before the page's own content.
  const order = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="fixture-section-a"]')
    const b = document.querySelector('[data-testid="fixture-section-b"]')
    const own = document.querySelector('[data-testid="fixture-page-own"]')
    if (!a || !b || !own) return null
    return (
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      Boolean(b.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
  })
  expect(order).toBe(true)

  // Section JS ran; sharedCss injected; trace comment present without secrets.
  const state = await page.evaluate(() => {
    const container = document.querySelector('.gw-page-content')
    const first = container?.firstChild
    const comment = first && first.nodeType === 8 ? (first as Comment).textContent : ''
    return {
      sectionRan: (window as unknown as { gwSectionARan?: number }).gwSectionARan === 1,
      sharedCss: Boolean(document.querySelector('style[data-gw-shared-css]')),
      comment,
    }
  })
  expect(state.sectionRan).toBe(true)
  expect(state.sharedCss).toBe(true)
  expect(state.comment).toContain('gw-page: sections')
  expect(state.comment).not.toContain('http')
  expect(state.comment).not.toContain('previewSecret')
})

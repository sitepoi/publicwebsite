import { expect, test } from '@playwright/test'

/**
 * e2e smoke (Section 21): the app boots and serves the website pipeline.
 * The full C4 acceptance lives in e2e/website.spec.ts (fixture mode).
 */
test('app boots and serves the home page', async ({ page }) => {
  const response = await page.goto('http://localhost:3000/')
  expect(response?.status()).toBe(200)
  await expect(page.getByTestId('fixture-home')).toBeVisible()
})

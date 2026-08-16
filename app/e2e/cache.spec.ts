import { expect, test } from '@playwright/test'

/**
 * C11 acceptance: the revalidate publish webhook purges by tag (shared
 * secret). Runs against the fixture dev server; `site-<folderId>` purges
 * also clear the resolver memory caches (Section 18).
 */
test('revalidate purges by tag with the shared secret', async ({ page }) => {
  await page.goto('http://localhost:3000/')
  await expect(page.getByTestId('fixture-home')).toBeVisible()

  // Without the secret → 401.
  const unauthorized = await page.evaluate(async () => {
    const response = await fetch('/api/revalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['page-home-page'] }),
    })
    return response.status
  })
  expect(unauthorized).toBe(401)

  // With the shared dev secret (REVALIDATE_SECRET in .env.local) → 200.
  const purged = await page.evaluate(async () => {
    const response = await fetch('/api/revalidate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-revalidate-secret': 'demo-revalidate-secret',
      },
      body: JSON.stringify({ tags: ['page-home-page', 'site-site-a'] }),
    })
    return response.json()
  })
  expect(purged.ok).toBe(true)
  expect(purged.purged).toEqual(['page-home-page', 'site-site-a'])

  // The served page is still fresh after the purge.
  await page.goto('http://localhost:3000/')
  await expect(page.getByTestId('fixture-home')).toBeVisible()
})

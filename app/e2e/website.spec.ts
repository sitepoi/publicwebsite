import { expect, test } from '@playwright/test'

/**
 * C4 acceptance (Section 21): the fixture site renders; scripts execute with
 * top-level hoisting; styles hoist; SPA nav re-runs content scripts; no
 * console errors. Served by the dev server in fixture mode (GW_DEV_FIXTURES=1).
 */
test('fixture site renders pages, styles, scripts and SPA navigation', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))

  // Home page renders chrome + content.
  await page.goto('http://localhost:3000/')
  await expect(page.getByTestId('fixture-header')).toBeVisible()
  await expect(page.getByTestId('fixture-footer')).toBeVisible()
  await expect(page.getByTestId('fixture-home')).toBeVisible()
  await expect(page).toHaveTitle('Fixture Home')

  // gw bootstrap context is available before content scripts.
  const context = await page.evaluate(() => window.gw)
  expect(context?.pageId).toBe('home-page')
  expect(context?.folderId).toBe('site-a')
  expect(context?.language).toBe('en')

  // Content script executed, top-level function hoisted to window.
  await expect.poll(() => page.evaluate(() => window.gwFixtureHomeRan ?? 0)).toBe(1)
  await expect.poll(() => page.evaluate(() => typeof window.gwFixtureHomeFn)).toBe('function')

  // Styles hoisted: page + chrome css tags (deduped) + theme CSS variable applied.
  await expect(page.locator('style[data-gw-css]')).toHaveCount(2)
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--gw-color-primary').trim(),
  )
  expect(primary).toBe('#111263')

  // headCode slot ran.
  await expect.poll(() => page.evaluate(() => window.gwHeadCodeRan)).toBe(true)

  // gw SDK smoke (C5): storage, sanitize (vendored DOMPurify), formatting.
  await page.waitForFunction(() => Boolean(window.DOMPurify))
  const smoke = await page.evaluate(() => ({
    currency: window.gwSmokeCurrency,
    sanitized: window.gw.sanitize('<img src=x onerror=alert(1)><b>ok</b>'),
    stored: window.gwSmokeStored,
    notifyType: typeof window.gw.notify,
    params: window.gw.getPageParams(),
  }))
  expect(smoke.currency).toBe('$12.50')
  expect(smoke.sanitized).toContain('<b>ok</b>')
  expect(smoke.sanitized).not.toContain('onerror')
  expect(smoke.stored).toBe('yes')
  expect(smoke.notifyType).toBe('function')
  expect(smoke.params).toEqual({})

  // gw.forms on the fixture form: endpoint arrives in C6 → gw:form-error.
  await page.fill('#smoke-form input[name="email"]', 'a@b.co')
  const formEvent = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        window.addEventListener('gw:form-success', () => resolve('success'), { once: true })
        window.addEventListener('gw:form-error', () => resolve('error'), { once: true })
        window.addEventListener('gw:form-invalid', () => resolve('invalid'), { once: true })
      }),
  )
  await page.click('#smoke-form button[type="submit"]')
  expect(await formEvent).toBe('error')

  // SPA navigation: data-ic-nav-href → detail page, scripts re-run there.
  await page.click('#nav-about')
  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByTestId('fixture-about')).toBeVisible()
  await page.click('#nav-product')
  await expect(page).toHaveURL(/\/menu-items\/menu-1$/)
  await expect(page.getByTestId('fixture-product')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.gwFixtureProductRan ?? 0))
    .toBeGreaterThanOrEqual(1)

  // Re-init on route change: back to home → content script re-runs.
  await page.goBack()
  await expect(page.getByTestId('fixture-about')).toBeVisible()
  await page.goBack()
  await expect(page.getByTestId('fixture-home')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.gwFixtureHomeRan ?? 0))
    .toBeGreaterThanOrEqual(2)

  // Draft page is hidden without preview and visible with the preview secret.
  await page.goto('http://localhost:3000/draft-page')
  await expect(page.getByText('404 — Page not found')).toBeVisible()
  await page.goto('http://localhost:3000/draft-page?gw-preview=demo-preview')
  await expect(page.getByTestId('fixture-draft')).toBeVisible()

  // No console errors — except the intentional 404 navigations above (the
  // browser logs the failed resource load of the 404 document itself) and the
  // intentional gw:form-error form submission (the fixture form has no form
  // type → the server rejects it with 400, which the browser also logs).
  const unexpected = errors.filter(
    (message) => !message.includes('404 (Not Found)') && !message.includes('400 (Bad Request)'),
  )
  expect(unexpected).toEqual([])
})

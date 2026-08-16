import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright e2e config (Section 21) — smoke tests per representative site.
 * Not part of the CI skeleton yet (CI = lint → typecheck → test → build);
 * run locally with `pnpm e2e` after `pnpm exec playwright install`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // e2e runs against the in-memory fixture site (C4 deliverable).
      GW_DEV_FIXTURES: '1',
    },
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    // Full-suite runs load heavily (firebase-admin import graphs) — give
    // workers room to wind down (pino/thread teardown, C11).
    teardownTimeout: 30_000,
  },
})

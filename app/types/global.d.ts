/**
 * window typings: the window.gw SDK v2 surface (lib/gw-sdk) + analytics
 * globals + the fixture-page smoke flags used by tests/e2e.
 */
import type { GwSdk } from '@/lib/gw-sdk'

declare global {
  interface Window {
    gw: GwSdk
    DOMPurify?: { sanitize(html: string, options?: unknown): string } | null
    gtag?: (...args: unknown[]) => void
    dataLayer?: Array<Record<string, unknown>>
    fbq?: (...args: unknown[]) => void
    gwHeadCodeRan?: boolean
    gwFixtureHomeRan?: number
    gwFixtureHomeFn?: () => string
    gwFixtureAboutRan?: number
    gwFixtureProductRan?: number
    gwSmokeCurrency?: string
    gwSmokeStored?: string | null
  }
}

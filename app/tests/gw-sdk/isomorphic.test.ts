import { describe, expect, it } from 'vitest'
import { buildGwBootstrapScript } from '@/lib/gw-sdk'

/**
 * Hard rule (Section 12): isomorphic module — no window at import time.
 * This test file runs in the default NODE environment; importing the SDK and
 * generating the bootstrap source must not touch window/document.
 */
describe('gw-sdk isomorphism (no window at import time)', () => {
  it('loads and builds the bootstrap source in a Node environment', () => {
    expect(typeof window).toBe('undefined')
    const script = buildGwBootstrapScript({
      pageId: 'p1',
      siteId: 'site-a',
      folderId: 'site-a',
      language: 'en',
      host: 'site-a.test',
    })
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(1000)
  })
})

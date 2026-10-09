import { describe, expect, it } from 'vitest'
import { GET } from '@/app/sw.js/route'

describe('/sw.js (self-destructing service worker, D-DWH-28)', () => {
  it('serves a javascript worker that unregisters itself', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = await response.text()
    expect(body).toContain('self.registration')
    expect(body).toContain('.unregister()')
    expect(body).toContain('skipWaiting')
  })
})

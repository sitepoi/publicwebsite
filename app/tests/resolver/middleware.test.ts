import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

describe('proxy (host normalization + traffic rules)', () => {
  it('normalizes the host and sets x-gw-host', () => {
    const request = new NextRequest('http://WWW.Site-A.com:3000/about', {
      headers: { host: 'WWW.Site-A.com:3000' },
    })
    const response = proxy(request)
    expect(response.status).toBe(200)
    // Next propagates request-header overrides via x-middleware-* headers.
    expect(response.headers.get('x-middleware-request-x-gw-host')).toBe('www.site-a.com')
    expect(response.headers.get('x-middleware-override-headers')).toContain('x-gw-host')
  })

  it('passes through clean traffic untouched', () => {
    const request = new NextRequest('https://site-a.com/en/page?q=1', {
      headers: { host: 'site-a.com', 'user-agent': 'Mozilla/5.0' },
    })
    const response = proxy(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-request-x-gw-host')).toBe('site-a.com')
  })

  it('does not block anything while the rule set is empty (configurable later)', () => {
    const request = new NextRequest('https://site-a.com/wp-admin', {
      headers: { host: 'site-a.com', 'user-agent': 'BadBot/1.0' },
    })
    expect(proxy(request).status).toBe(200)
  })
})

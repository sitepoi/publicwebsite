import { describe, expect, it } from 'vitest'
import { decodeSessionCookie, encodeSessionCookie } from '@/lib/auth/firebase'

describe('session cookie format (REST-only sessions, D-DWH-27)', () => {
  const secret = 'test-secret'

  it('round-trips the payload', () => {
    const payload = { idToken: 'tok-1', expiresAt: Date.now() + 1000, refreshToken: 'rt-1' }
    const cookie = encodeSessionCookie(payload, secret)
    expect(cookie.startsWith('v1.')).toBe(true)
    expect(decodeSessionCookie(cookie, secret)).toEqual(payload)
  })

  it('rejects a tampered payload', () => {
    const cookie = encodeSessionCookie({ idToken: 'tok-1', expiresAt: 1 }, secret)
    const parts = cookie.split('.')
    const tampered = `${parts[0]}.${Buffer.from('{"idToken":"evil"}').toString('base64url')}.${parts[2]}`
    expect(decodeSessionCookie(tampered, secret)).toBeNull()
  })

  it('rejects a cookie signed with a different secret', () => {
    const cookie = encodeSessionCookie({ idToken: 'tok-1', expiresAt: 1 }, secret)
    expect(decodeSessionCookie(cookie, 'other-secret')).toBeNull()
  })

  it('rejects malformed cookies', () => {
    expect(decodeSessionCookie('', secret)).toBeNull()
    expect(decodeSessionCookie('v2.a.b', secret)).toBeNull()
    expect(decodeSessionCookie('v1.not-base64.sig', secret)).toBeNull()
    expect(decodeSessionCookie('v1.e30.bad', secret)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { hostMatches, normalizeHost } from '@/lib/resolver/host'

describe('normalizeHost (Section 7.3 rule 1)', () => {
  it('lowercases the host', () => {
    expect(normalizeHost('WWW.Site-A.com')).toBe('www.site-a.com')
  })

  it('strips the port', () => {
    expect(normalizeHost('site-a.com:3000')).toBe('site-a.com')
    expect(normalizeHost('SITE-A.COM:8080')).toBe('site-a.com')
  })

  it('keeps non-numeric port-like suffixes', () => {
    expect(normalizeHost('site-a.com:abc')).toBe('site-a.com:abc')
  })

  it('strips a trailing dot (FQDN form)', () => {
    expect(normalizeHost('site-a.com.')).toBe('site-a.com')
    expect(normalizeHost('site-a.com...')).toBe('site-a.com')
  })

  it('unbrackets IPv6 hosts', () => {
    expect(normalizeHost('[::1]:3000')).toBe('::1')
  })

  it('returns null for empty/invalid input', () => {
    expect(normalizeHost('')).toBeNull()
    expect(normalizeHost(null)).toBeNull()
    expect(normalizeHost(undefined)).toBeNull()
    expect(normalizeHost('   ')).toBeNull()
    expect(normalizeHost('...')).toBeNull()
  })
})

describe('hostMatches (Section 7.3 rule 3 — exact + *.wildcard)', () => {
  it('matches exact hosts', () => {
    expect(hostMatches('site-a.com', 'site-a.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(hostMatches('WWW.SITE-A.com', 'www.site-a.com')).toBe(true)
  })

  it('matches *.domain wildcards for one subdomain label', () => {
    expect(hostMatches('www.site-a.com', '*.site-a.com')).toBe(true)
  })

  it('matches *.domain wildcards for multiple labels', () => {
    expect(hostMatches('a.b.site-a.com', '*.site-a.com')).toBe(true)
  })

  it('bare domain does NOT match its own wildcard', () => {
    expect(hostMatches('site-a.com', '*.site-a.com')).toBe(false)
  })

  it('rejects unrelated domains', () => {
    expect(hostMatches('other.com', '*.site-a.com')).toBe(false)
    expect(hostMatches('site-a.com.evil.com', '*.site-a.com')).toBe(false)
  })

  it('rejects malformed patterns', () => {
    expect(hostMatches('anything.com', '*')).toBe(false)
    expect(hostMatches('anything.com', '*.')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRAFFIC_RULES,
  containsDeniedWords,
  evaluateTraffic,
  isBlockedUserAgent,
} from '@/lib/security/traffic'

const rules = {
  blockedUserAgents: ['badbot', 'curl'],
  deniedWords: ['wp-admin', 'phpmyadmin'],
}

describe('traffic rules (Section 19 / C2)', () => {
  it('blocks known bots by user-agent substring, case-insensitive', () => {
    expect(isBlockedUserAgent('Mozilla/5.0 BadBot/2.0', rules)).toBe(true)
    expect(isBlockedUserAgent('curl/8.0', rules)).toBe(true)
    expect(isBlockedUserAgent('Mozilla/5.0 (good)', rules)).toBe(false)
    expect(isBlockedUserAgent(null, rules)).toBe(false)
  })

  it('blocks denied words in the request URL, case-insensitive', () => {
    expect(containsDeniedWords('/wp-admin/login.php', rules)).toBe(true)
    expect(containsDeniedWords('/PhpMyAdmin/index.php', rules)).toBe(true)
    expect(containsDeniedWords('/products/pizza', rules)).toBe(false)
  })

  it('evaluateTraffic reports reason and passes clean traffic', () => {
    expect(evaluateTraffic({ userAgent: 'badbot', text: '/' }, rules)).toEqual({
      blocked: true,
      reason: 'user-agent',
    })
    expect(evaluateTraffic({ userAgent: 'Mozilla/5.0', text: '/wp-admin' }, rules)).toEqual({
      blocked: true,
      reason: 'denied-word',
    })
    expect(evaluateTraffic({ userAgent: 'Mozilla/5.0', text: '/about' }, rules)).toEqual({
      blocked: false,
    })
  })

  it('default rules block nothing until configured', () => {
    expect(DEFAULT_TRAFFIC_RULES).toEqual({ blockedUserAgents: [], deniedWords: [] })
    expect(
      evaluateTraffic({ userAgent: 'badbot', text: '/wp-admin' }, DEFAULT_TRAFFIC_RULES),
    ).toEqual({ blocked: false })
  })
})

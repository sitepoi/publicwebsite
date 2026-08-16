/**
 * Traffic rules (Section 19 / C2) — typed, configurable, dependency-free
 * (safe for the edge middleware bundle).
 *
 * Same semantics as the legacy trafficManagement: user-agent matching and
 * denied-word matching over the request URL, case-insensitive. The rule set
 * is typed and passed in by callers; `DEFAULT_TRAFFIC_RULES` blocks nothing —
 * deployments configure their own rules (ADR-002).
 */
export interface TrafficRules {
  /** User agents blocked by case-insensitive substring match. */
  blockedUserAgents: string[]
  /** Words that block the request when found in path+query (case-insensitive). */
  deniedWords: string[]
}

export const DEFAULT_TRAFFIC_RULES: TrafficRules = {
  blockedUserAgents: [],
  deniedWords: [],
}

export type TrafficBlockReason = 'user-agent' | 'denied-word'

export interface TrafficVerdict {
  blocked: boolean
  reason?: TrafficBlockReason
}

export interface TrafficRequest {
  userAgent: string | null | undefined
  text: string
}

export function isBlockedUserAgent(
  userAgent: string | null | undefined,
  rules: TrafficRules,
): boolean {
  if (!userAgent || rules.blockedUserAgents.length === 0) return false
  const normalized = userAgent.toLowerCase()
  return rules.blockedUserAgents.some((pattern) => normalized.includes(pattern.toLowerCase()))
}

export function containsDeniedWords(text: string, rules: TrafficRules): boolean {
  if (rules.deniedWords.length === 0) return false
  const normalized = text.toLowerCase()
  return rules.deniedWords.some((word) => normalized.includes(word.toLowerCase()))
}

export function evaluateTraffic(request: TrafficRequest, rules: TrafficRules): TrafficVerdict {
  if (isBlockedUserAgent(request.userAgent, rules)) {
    return { blocked: true, reason: 'user-agent' }
  }
  if (containsDeniedWords(request.text, rules)) {
    return { blocked: true, reason: 'denied-word' }
  }
  return { blocked: false }
}

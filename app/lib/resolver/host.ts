/**
 * Host normalization + host matching (Sections 5 / 7.3).
 *
 * Pure, dependency-free — safe for the edge middleware bundle.
 *
 * Section 7.3 rule 1: normalize host (strip port, lowercase).
 * Section 7.3 rule 3: `hostNames` matching — exact or `*.sub` wildcard
 * (decided: `*.domain` matches any host with at least one label before
 * `domain`; the bare domain itself does NOT match — ADR-002).
 */

export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null
  let host = raw.trim().toLowerCase()
  if (host.length === 0) return null

  // Trailing dot (FQDN form).
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.length === 0) return null

  if (host.startsWith('[')) {
    // IPv6 bracket form: [::1]:3000 → ::1
    const end = host.indexOf(']')
    if (end === -1) return null
    host = host.slice(1, end)
    if (host.length === 0) return null
  } else {
    // Strip port only when the remainder is purely numeric (hostname:port).
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
      host = host.slice(0, colon)
    }
  }

  return host.length > 0 ? host : null
}

/** Exact match, or `*.domain` wildcard (at least one subdomain label). */
export function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host)
  const normalizedPattern = normalizeHost(pattern)
  if (!normalizedHost || !normalizedPattern) return false

  if (normalizedPattern.startsWith('*.')) {
    const domain = normalizedPattern.slice(2)
    if (domain.length === 0) return false
    // `www.site-a.com` matches `*.site-a.com`; bare `site-a.com` does not.
    return normalizedHost.endsWith(`.${domain}`)
  }
  return normalizedHost === normalizedPattern
}

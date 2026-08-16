import { createHash } from 'node:crypto'
import { normalizeHost } from '@/lib/resolver/host'

/**
 * Request guards (Section 14 / 19): same-origin, client IP (HASHED only —
 * hard rule: raw IPs are never stored), per-IP rate-limit keys.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const candidate = forwarded ? forwarded.split(',')[0]?.trim() : ''
  return candidate || 'local'
}

/** SHA-256 with the relay secret as salt — raw IPs never leave this function. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex')
}

/** Same-origin check: browsers send Origin; non-browser clients may omit it. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  // Prefer the raw Host header (carries the port in dev); the proxy's
  // normalized x-gw-host is the fallback. Both sides are port-stripped
  // before comparison (normalizeHost — Section 7.3 rule 1).
  const host = request.headers.get('host') ?? request.headers.get('x-gw-host') ?? ''
  if (!host) return false
  try {
    const originHost = normalizeHost(new URL(origin).host)
    const requestHost = normalizeHost(host)
    if (!originHost || !requestHost) return false
    return originHost === requestHost
  } catch {
    return false
  }
}

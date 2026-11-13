/**
 * CMS v2 first-party service token minter (server-only).
 *
 * A fresh short-lived JWT is minted for EVERY request attempt with the alg,
 * kid, issuer, audience and private key returned by the per-tenant credential
 * resolver. Nothing is cached here: no token reuse, no jti reuse.
 *
 * HARD RULES:
 * - Node crypto only (never browser crypto).
 * - Never log the token, the private key or the jti.
 * - ES256 signatures use ieee-p1363 (raw r||s), NOT DER.
 */

import { randomUUID, sign } from 'node:crypto'

export type CmsServiceAlg = 'RS256' | 'ES256'

export interface CmsServiceTokenInput {
  privateKeyPem: string
  alg: CmsServiceAlg
  kid: string
  issuer: string
  audience: string
  appId: string
  tenantId: string
  deploymentId: string
  ttlSeconds: number
  /** Injectable clock (milliseconds) for deterministic tests. */
  nowMs?: () => number
}

export interface CmsServiceTokenClaims {
  iss: string
  aud: string
  sub: string
  app: string
  tenantId: string
  deploymentId: string
  iat: number
  exp: number
  jti: string
}

export interface CmsServiceTokenHeader {
  alg: CmsServiceAlg
  kid: string
  typ: 'JWT'
}

/** RFC 7515 base64url (no padding) for strings and buffers. */
export function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

/** Build the claims object (exported for tests/debug metadata only). */
export function buildCmsServiceTokenClaims(
  input: CmsServiceTokenInput,
  nowMs: number,
): CmsServiceTokenClaims {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new Error('cms-service-token-invalid-ttl')
  }
  const iat = Math.floor(nowMs / 1000)
  return {
    iss: input.issuer,
    aud: input.audience,
    sub: `service:${input.appId}`,
    app: input.appId,
    tenantId: input.tenantId,
    deploymentId: input.deploymentId,
    iat,
    exp: iat + input.ttlSeconds,
    jti: randomUUID(),
  }
}

/** Mint one fresh JWT. Never cache or reuse the returned token. */
export function buildCmsServiceToken(input: CmsServiceTokenInput): string {
  const nowMs = (input.nowMs ?? Date.now)()
  const header: CmsServiceTokenHeader = {
    alg: input.alg,
    kid: input.kid,
    typ: 'JWT',
  }
  const claims = buildCmsServiceTokenClaims(input, nowMs)

  const headerPart = base64UrlEncode(JSON.stringify(header))
  const payloadPart = base64UrlEncode(JSON.stringify(claims))
  const signingInput = `${headerPart}.${payloadPart}`

  const signature =
    input.alg === 'ES256'
      ? sign('sha256', Buffer.from(signingInput), {
          key: input.privateKeyPem,
          dsaEncoding: 'ieee-p1363',
        })
      : sign('RSA-SHA256', Buffer.from(signingInput), input.privateKeyPem)

  return `${signingInput}.${signature.toString('base64url')}`
}

/** The one header the CMS v2 accepts for a first-party service call. */
export function buildCmsServiceAuthHeaders(input: CmsServiceTokenInput): Record<string, string> {
  return { 'x-unicon-service-token': buildCmsServiceToken(input) }
}

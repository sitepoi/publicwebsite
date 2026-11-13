import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildCmsServiceToken, buildCmsServiceAuthHeaders } from '@/lib/server/cmsServiceToken'

interface KeyPair {
  privatePem: string
  publicPem: string
}

function rsaKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function ecKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function decodeToken(token: string): {
  header: Record<string, unknown>
  claims: Record<string, unknown>
  signingInput: string
  signature: Buffer
} {
  const [headerPart, payloadPart, signaturePart] = token.split('.')
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('malformed token')
  return {
    header: JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
    signingInput: `${headerPart}.${payloadPart}`,
    signature: Buffer.from(signaturePart, 'base64url'),
  }
}

const BASE_INPUT = {
  alg: 'RS256' as const,
  kid: 'kid-1',
  issuer: 'https://publicwebsite-app-issuer-service.uniconhub.com',
  audience: 'uniconhub-cms-api',
  appId: 'publicwebsite',
  tenantId: 'tenant-a',
  deploymentId: 'site-a',
  ttlSeconds: 60,
}

describe('CMS service token (runtime-fetch first-party auth)', () => {
  it('RS256: header carries alg/kid/typ and claims match the spec', () => {
    const keys = rsaKeyPair()
    const token = buildCmsServiceToken({ ...BASE_INPUT, privateKeyPem: keys.privatePem })
    const decoded = decodeToken(token)

    expect(decoded.header).toEqual({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' })
    expect(decoded.claims['iss']).toBe(BASE_INPUT.issuer)
    expect(decoded.claims['aud']).toBe(BASE_INPUT.audience)
    expect(decoded.claims['sub']).toBe('service:publicwebsite')
    expect(decoded.claims['app']).toBe('publicwebsite')
    expect(decoded.claims['tenantId']).toBe('tenant-a')
    expect(decoded.claims['deploymentId']).toBe('site-a')
    expect(decoded.claims['exp']).toBe((decoded.claims['iat'] as number) + BASE_INPUT.ttlSeconds)
    expect(typeof decoded.claims['jti']).toBe('string')

    const valid = verify(
      'RSA-SHA256',
      Buffer.from(decoded.signingInput),
      keys.publicPem,
      decoded.signature,
    )
    expect(valid).toBe(true)
  })

  it('ES256: ieee-p1363 signature (64 bytes) verifies against the enrolled public key', () => {
    const keys = ecKeyPair()
    const token = buildCmsServiceToken({
      ...BASE_INPUT,
      alg: 'ES256',
      privateKeyPem: keys.privatePem,
    })
    const decoded = decodeToken(token)

    expect(decoded.header).toEqual({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' })
    expect(decoded.signature.length).toBe(64)

    const validP1363 = verify(
      'sha256',
      Buffer.from(decoded.signingInput),
      { key: keys.publicPem, dsaEncoding: 'ieee-p1363' },
      decoded.signature,
    )
    expect(validP1363).toBe(true)

    // DER is the wrong encoding — it must NOT verify.
    const validDer = verify(
      'sha256',
      Buffer.from(decoded.signingInput),
      keys.publicPem,
      decoded.signature,
    )
    expect(validDer).toBe(false)
  })

  it('mints a fresh token and a fresh jti on every call (never reuses)', () => {
    const keys = rsaKeyPair()
    const first = buildCmsServiceToken({ ...BASE_INPUT, privateKeyPem: keys.privatePem })
    const second = buildCmsServiceToken({ ...BASE_INPUT, privateKeyPem: keys.privatePem })

    expect(first).not.toBe(second)
    expect(decodeToken(first).claims['jti']).not.toBe(decodeToken(second).claims['jti'])
  })

  it('uses the injected clock for iat/exp', () => {
    const keys = rsaKeyPair()
    const token = buildCmsServiceToken({
      ...BASE_INPUT,
      privateKeyPem: keys.privatePem,
      ttlSeconds: 30,
      nowMs: () => 1_700_000_000_000,
    })
    const claims = decodeToken(token).claims
    expect(claims['iat']).toBe(1_700_000_000)
    expect(claims['exp']).toBe(1_700_000_030)
  })

  it('rejects invalid TTL values', () => {
    const keys = rsaKeyPair()
    expect(() =>
      buildCmsServiceToken({ ...BASE_INPUT, privateKeyPem: keys.privatePem, ttlSeconds: 0 }),
    ).toThrow('cms-service-token-invalid-ttl')
  })

  it('returns the x-unicon-service-token header helper', () => {
    const keys = rsaKeyPair()
    const headers = buildCmsServiceAuthHeaders({ ...BASE_INPUT, privateKeyPem: keys.privatePem })
    expect(Object.keys(headers)).toEqual(['x-unicon-service-token'])
    expect(headers['x-unicon-service-token']?.split('.')).toHaveLength(3)
  })
})

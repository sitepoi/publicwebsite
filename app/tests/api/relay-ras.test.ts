import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { TenantConfig } from '@/lib/contracts/tenants'
import type { Env } from '@/lib/config/env'

const { resolveTenantMock } = vi.hoisted(() => ({
  resolveTenantMock: vi.fn(),
}))

vi.mock('@/lib/config/env', () => ({
  getEnv: (): Env =>
    ({
      RELAY_SECRET: 'test-relay-secret',
    }) as Env,
}))

vi.mock('@/lib/resolver', () => ({
  getResolverStack: () => ({
    resolveTenant: resolveTenantMock,
  }),
}))

import { GET } from '@/app/api/relay/ras/route'

const tenant: TenantConfig = {
  tenantId: 'tenant-a',
  databaseProvider: 'firestore',
  firebase: { projectId: 'project-a' },
  tableExtension: 'uniconbaseapps',
  defaultAppId: 'my-app',
}

describe('GET /api/relay/ras (tooling parity, Section 6)', () => {
  it('rejects requests without the relay secret', async () => {
    const request = new NextRequest('http://localhost:3000/api/relay/ras?hostname=site-a.com')
    const response = await GET(request)
    expect(response.status).toBe(401)
  })

  it('returns a base64 SAFE config for a known host', async () => {
    resolveTenantMock.mockResolvedValueOnce(tenant)
    const request = new NextRequest('http://localhost:3000/api/relay/ras?hostname=site-a.com', {
      headers: { 'x-relay-secret': 'test-relay-secret' },
    })
    const response = await GET(request)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { config: string; hostname: string }
    expect(body.hostname).toBe('site-a.com')
    const decoded = JSON.parse(Buffer.from(body.config, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >
    expect(decoded).toEqual({
      tenantId: 'tenant-a',
      databaseProvider: 'firestore',
      tableExtension: 'uniconbaseapps',
      projectId: 'project-a',
      defaultAppId: 'my-app',
    })
    // NEVER credentials in the relay payload (secrets env-only, Section 19).
    expect(body.config).not.toContain('privateKey')
    expect(body.config).not.toContain('clientEmail')
  })

  it('returns 404 for an unknown host', async () => {
    resolveTenantMock.mockResolvedValueOnce(null)
    const request = new NextRequest(
      'http://localhost:3000/api/relay/ras?hostname=unknown.example',
      {
        headers: { 'x-relay-secret': 'test-relay-secret' },
      },
    )
    const response = await GET(request)
    expect(response.status).toBe(404)
  })
})

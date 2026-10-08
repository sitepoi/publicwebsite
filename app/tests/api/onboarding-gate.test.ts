import { describe, expect, it } from 'vitest'
import { handleOnboardingSelfCheck } from '@/app/api/onboarding/self-check/route'
import { handleRelayValidate } from '@/app/api/relay/validate/route'
import type { Env } from '@/lib/config/env'
import type { TenantConfig } from '@/lib/contracts/tenants'
import { createFakeProvider } from '@/tests/resolver/fakes'

const testEnv = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_APP_NAME: 'test-app',
  FIREBASE_PROJECT_ID: 'websites-a0e13',
  FIREBASE_ADMIN_CLIENT_EMAIL: 'demo-client-email',
  FIREBASE_ADMIN_PRIVATE_KEY: 'demo-private-key',
  RELAY_SECRET: 'demo-relay-secret',
  FORMS_RATE_LIMIT_MAX: 20,
  FORMS_RATE_LIMIT_WINDOW_MS: 60000,
  REVALIDATE_SECRET: 'demo-revalidate-secret',
  CMS_API_KEY: 'cms-key-{abc}',
  CMS_ADMIN_DOMAIN: 'https://cms.uniconhub.com',
  DEVELOPER_EMAIL: '',
} as Env

const tenantConfig: TenantConfig = {
  tenantId: 'acme',
  databaseProvider: 'firestore',
  firebase: { projectId: 'acme-website-project' },
}

const siteResolution = {
  ok: true as const,
  site: {
    host: 'acme.com',
    tenant: tenantConfig,
    appId: 'website-builder-uniconbaseapps',
    appPublicAccess: undefined,
    folderId: 'acme-site',
    settings: { hostNames: ['acme.com'] },
  },
}

function makeProvider() {
  return createFakeProvider({
    queryObjects: async (query) => {
      const slugFilter = query.filters?.find((filter) => filter.field === 'slug')
      const slug = slugFilter && typeof slugFilter.value === 'string' ? slugFilter.value : ''
      const items =
        slug === 'default-settings'
          ? [{ id: 'settings-1', slug: 'default-settings', typeId: 'acme-site', data: { hostNames: ['acme.com'] } }]
          : slug === 'home-page'
            ? [{ id: 'home-1', slug: 'home-page', typeId: 'acme-site' }]
            : []
      return { items, total: items.length, page: 1, pageSize: 200, facets: {}, relations: {} }
    },
  })
}

function selfCheckRequest(hostname: string, secret?: string): Request {
  const headers: Record<string, string> = {}
  if (secret) headers['x-revalidate-secret'] = secret
  return new Request(`https://uniconhub.com/api/onboarding/self-check?hostname=${hostname}`, {
    headers,
  })
}

describe('handleOnboardingSelfCheck (T-16)', () => {
  it('answers 401 without the secret', async () => {
    const response = await handleOnboardingSelfCheck(selfCheckRequest('acme.com'), {
      env: testEnv,
      resolveTenant: async () => tenantConfig,
      resolveSite: async () => siteResolution,
      providerFor: () => makeProvider(),
      checkCredentials: () => null,
    })
    expect(response.status).toBe(401)
  })

  it('reports every layer pass for a healthy hostname', async () => {
    const response = await handleOnboardingSelfCheck(selfCheckRequest('acme.com', 'demo-revalidate-secret'), {
      env: testEnv,
      resolveTenant: async () => tenantConfig,
      resolveSite: async () => siteResolution,
      providerFor: () => makeProvider(),
      checkCredentials: () => null,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      layers: Array<{ layer: string; status: string }>
    }
    expect(body.ok).toBe(true)
    const layerStatuses = Object.fromEntries(body.layers.map((layer) => [layer.layer, layer.status]))
    expect(layerStatuses['L1']).toBe('na')
    expect(layerStatuses['L2']).toBe('pass')
    expect(layerStatuses['L3']).toBe('pass')
    expect(layerStatuses['L4']).toBe('pass')
    expect(layerStatuses['L6']).toBe('pass')
  })

  it('reports tenant-not-found with L2..L5 failed', async () => {
    const response = await handleOnboardingSelfCheck(selfCheckRequest('ghost.com', 'demo-revalidate-secret'), {
      env: testEnv,
      resolveTenant: async () => null,
      resolveSite: async () => ({ ok: false, reason: 'tenant-not-found' }),
      providerFor: () => makeProvider(),
      checkCredentials: () => null,
    })
    const body = (await response.json()) as { ok: boolean; layers: Array<{ layer: string; status: string }> }
    expect(body.ok).toBe(false)
    const failed = body.layers.filter((layer) => layer.status === 'fail').map((layer) => layer.layer)
    expect(failed).toContain('L2')
    expect(failed).toContain('L4')
    expect(failed).toContain('L5')
  })

  it('reports the exact credential problem on L3', async () => {
    const response = await handleOnboardingSelfCheck(selfCheckRequest('acme.com', 'demo-revalidate-secret'), {
      env: testEnv,
      resolveTenant: async () => tenantConfig,
      resolveSite: async () => siteResolution,
      providerFor: () => makeProvider(),
      checkCredentials: () => "Missing Firebase admin private key for project 'acme-website-project'",
    })
    const body = (await response.json()) as { ok: boolean; layers: Array<{ layer: string; status: string; detail: string }> }
    const credentialsLayer = body.layers.find((layer) => layer.layer === 'L3')
    expect(credentialsLayer?.status).toBe('fail')
    expect(credentialsLayer?.detail).toContain('acme-website-project')
    expect(body.ok).toBe(false)
  })
})

describe('handleRelayValidate (T-17)', () => {
  function validateRequest(body: unknown, secret?: string): Request {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (secret) headers['x-relay-secret'] = secret
    return new Request('https://uniconhub.com/api/relay/validate', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  }

  it('answers 401 without the relay secret', async () => {
    const response = await handleRelayValidate(validateRequest({ kind: 'tenant-config', payload: {} }), {
      env: testEnv,
    })
    expect(response.status).toBe(401)
  })

  it('accepts a valid tenant-config', async () => {
    const response = await handleRelayValidate(
      validateRequest(
        {
          kind: 'tenant-config',
          payload: { tenantId: 'acme', databaseProvider: 'firestore', firebase: { projectId: 'p' } },
        },
        'demo-relay-secret',
      ),
      { env: testEnv },
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { ok: boolean }).toEqual({ ok: true })
  })

  it('rejects an invalid tenant-config with issues (422)', async () => {
    const response = await handleRelayValidate(
      validateRequest({ kind: 'tenant-config', payload: { databaseProvider: 'mysql' } }, 'demo-relay-secret'),
      { env: testEnv },
    )
    expect(response.status).toBe(422)
    const body = (await response.json()) as { ok: boolean; issues: string[] }
    expect(body.ok).toBe(false)
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('validates a legacy relay base64 (mapping + authTenant)', async () => {
    const legacy = Buffer.from(
      JSON.stringify({ projectId: 'p', tenantId: 'acme', authTenant: 'auth-1' }),
    ).toString('base64')
    const valid = await handleRelayValidate(
      validateRequest({ kind: 'relay-base64', encoded: legacy }, 'demo-relay-secret'),
      { env: testEnv },
    )
    expect((await valid.json()) as { ok: boolean }).toEqual({ ok: true })

    const withoutAuthTenant = Buffer.from(
      JSON.stringify({ projectId: 'p', tenantId: 'acme' }),
    ).toString('base64')
    const invalid = await handleRelayValidate(
      validateRequest({ kind: 'relay-base64', encoded: withoutAuthTenant }, 'demo-relay-secret'),
      { env: testEnv },
    )
    expect(invalid.status).toBe(422)
    const body = (await invalid.json()) as { ok: boolean; issues: string[] }
    expect(body.ok).toBe(false)
    expect(body.issues[0]).toContain('authTenant')
  })

  it('validates site-settings and app-definition payloads', async () => {
    const siteResponse = await handleRelayValidate(
      validateRequest(
        { kind: 'site-settings', payload: { hostNames: ['acme.com'] } },
        'demo-relay-secret',
      ),
      { env: testEnv },
    )
    expect((await siteResponse.json()) as { ok: boolean }).toEqual({ ok: true })

    const appResponse = await handleRelayValidate(
      validateRequest(
        { kind: 'app-definition', payload: { id: 'website-builder-uniconbaseapps', capabilities: ['website'] } },
        'demo-relay-secret',
      ),
      { env: testEnv },
    )
    expect((await appResponse.json()) as { ok: boolean }).toEqual({ ok: true })
  })
})

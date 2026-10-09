import { describe, expect, it, vi } from 'vitest'
import { createTenant } from '@/lib/onboarding/service'
import {
  handleTenantCreate,
  TENANT_CREATE_RATE_MAX,
  TENANT_CREATE_RATE_WINDOW_MS,
} from '@/app/api/tenant/create/route'
import { createMemoryRateLimiter } from '@/lib/cache/memory'
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
  tenantId: 'websites-a0e13',
  databaseProvider: 'firestore',
  firebase: { projectId: 'websites-a0e13' },
}

const validRequest = {
  tenantId: 'acme',
  adminEmail: 'admin@acme.com',
  adminPassword: 'password-123',
  hostNames: ['acme.com', 'www.acme.com'],
}

function makeRequest(body: unknown): Request {
  return new Request('https://uniconhub.com/api/tenant/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('createTenant service (T-12/T-13)', () => {
  it('creates the tenant with the legacy shapes + the new site skeleton', async () => {
    const written: Array<{ collection: string; id?: string; data: Record<string, unknown> }> = []
    const provider = createFakeProvider({
      getRecord: async () => null,
      queryObjects: async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 200,
        facets: {},
        relations: {},
      }),
      createRecord: async (input) => {
        written.push({ collection: input.collection, id: input.id, data: input.data })
        return { id: input.id ?? 'generated' }
      },
    })
    const cmsCall = vi.fn(async (path: string) => {
      if (path.includes('/ctgc/')) return { contents: { tenantId: 'auth-tenant-1' } }
      if (path.includes('/cugc/')) return { contents: { uid: 'admin-uid-1' } }
      return { ok: true }
    })

    const result = await createTenant(validRequest, {
      provider,
      cmsApiKey: testEnv.CMS_API_KEY,
      projectId: 'websites-a0e13',
      cmsCall,
      registryHostNames: async () => ['acme.com', 'www.acme.com'],
      resolveTenantForHost: async () => ({ tenantId: 'acme' }),
      purge: async () => ({ ok: true, detail: 'HTTP 200' }),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.authTenantId).toBe('auth-tenant-1')
    expect(result.adminUid).toBe('admin-uid-1')
    expect(result.envVarNames).toEqual([
      'websites_a0e13_firebase_admin_project_id',
      'websites_a0e13_firebase_admin_private_key',
      'websites_a0e13_firebase_admin_client_email',
    ])

    const websiteSettings = written.find((entry) => entry.id === 'website-settings-acme')
    expect(websiteSettings?.data['_id']).toBe('website-settings')
    expect(websiteSettings?.data['tenantId']).toBe('acme')

    const cmsSettings = written.find((entry) => entry.id === 'cms-settings-acme')
    expect(cmsSettings?.data['_id']).toBe('cms-settings')
    const objectTypes = cmsSettings?.data['objectTypes'] as Array<Record<string, unknown>>
    expect(objectTypes[0]?.['capabilities']).toEqual(['website'])

    const adminUser = written.find((entry) => entry.id === 'admin@acme.com-acme')
    expect(adminUser?.data['roles']).toEqual(['admin'])

    const siteFolder = written.find((entry) => entry.collection === 'om_object_types')
    const folderData = (siteFolder?.data['data'] ?? {}) as Record<string, unknown>
    const websiteConfig = (folderData['websiteConfig'] ?? {}) as Record<string, unknown>
    expect(websiteConfig['hostNames']).toEqual(['acme.com', 'www.acme.com'])

    const homePage = written.find((entry) => entry.data['slug'] === 'home-page')
    expect(homePage?.data['typeId']).toBe('acme-site')

    // cms endpoints called in the legacy order (cna non-fatal).
    expect(cmsCall.mock.calls.map((call) => call[0]).join('|')).toContain('/ctgc/acme/')
    expect(cmsCall.mock.calls.map((call) => call[0]).join('|')).toContain('/cugc/auth-tenant-1/')
    expect(cmsCall.mock.calls.map((call) => call[0]).join('|')).toContain('/cna/auth-tenant-1/')
  })

  it('reports already-exists without calling the CMS or writing (D-DWH-15)', async () => {
    const provider = createFakeProvider({
      getRecord: async (input) =>
        input.id === 'cms-settings-acme' ? { _id: 'cms-settings' } : null,
    })
    const cmsCall = vi.fn(async () => ({}))

    const result = await createTenant(validRequest, {
      provider,
      cmsApiKey: testEnv.CMS_API_KEY,
      projectId: 'websites-a0e13',
      cmsCall,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('already-exists')
    expect(result.existing).toContain('cms-settings')
    expect(cmsCall).not.toHaveBeenCalled()
  })

  it('reports already-exists when a website folder already maps a requested host', async () => {
    const provider = createFakeProvider({
      getRecord: async () => null,
      getObjectTypes: async () => [
        {
          id: 'existing-folder',
          mainObjectType: 'website-builder-uniconbaseapps',
          data: { websiteConfig: { hostNames: ['acme.com'] } },
        },
      ],
    })
    const result = await createTenant(validRequest, {
      provider,
      cmsApiKey: testEnv.CMS_API_KEY,
      projectId: 'websites-a0e13',
      cmsCall: async () => ({}),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('already-exists')
    expect(result.existing).toContain('website folder hostNames')
  })

  it('surfaces a CMS failure as cms-error (CTGC)', async () => {
    const provider = createFakeProvider({
      getRecord: async () => null,
      queryObjects: async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 200,
        facets: {},
        relations: {},
      }),
    })
    const result = await createTenant(validRequest, {
      provider,
      cmsApiKey: testEnv.CMS_API_KEY,
      projectId: 'websites-a0e13',
      cmsCall: async () => {
        throw new Error('upstream down')
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cms-error')
  })
})

describe('handleTenantCreate route (T-11/T-14)', () => {
  function makeDeps(overrides: Partial<Parameters<typeof handleTenantCreate>[1]> = {}) {
    const written: Array<{ collection: string; id?: string; data: Record<string, unknown> }> = []
    const provider = createFakeProvider({
      getRecord: async () => null,
      queryObjects: async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 200,
        facets: {},
        relations: {},
      }),
      createRecord: async (input) => {
        written.push({ collection: input.collection, id: input.id, data: input.data })
        return { id: input.id ?? 'generated' }
      },
    })
    return {
      deps: {
        env: testEnv,
        resolveTenant: async () => tenantConfig,
        providerFor: () => provider,
        cmsCall: async (path: string) => {
          if (path.includes('/ctgc/')) return { contents: { tenantId: 'auth-tenant-1' } }
          if (path.includes('/cugc/')) return { contents: { uid: 'admin-uid-1' } }
          return {}
        },
        registryHostNames: async () => ['acme.com', 'www.acme.com'],
        purge: async () => ({ ok: true, detail: 'HTTP 200' }),
        rateLimiter: createMemoryRateLimiter({ max: 100, windowMs: 60000 }),
        runLiveChecks: false,
        ...overrides,
      },
      written,
    }
  }

  it('rejects an invalid tenant id with 400', async () => {
    const { deps } = makeDeps()
    const response = await handleTenantCreate(
      makeRequest({ ...validRequest, tenantId: 'A!C' }),
      deps,
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('invalid-tenant-request')
  })

  it('answers 503 when the CMS API key is not configured', async () => {
    const { deps } = makeDeps({ env: { ...testEnv, CMS_API_KEY: undefined } })
    const response = await handleTenantCreate(makeRequest(validRequest), deps)
    expect(response.status).toBe(503)
  })

  it('silently drops honeypot submissions', async () => {
    const { deps } = makeDeps()
    const response = await handleTenantCreate(
      makeRequest({ ...validRequest, gw_hp: 'filled' }),
      deps,
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as { ok: boolean }).toEqual({ ok: true })
  })

  it('returns created payload with env vars + verification + purge', async () => {
    const { deps } = makeDeps()
    const response = await handleTenantCreate(makeRequest(validRequest), deps)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      success: boolean
      tenantId: string
      envVarNames: string[]
      verification: Array<{ pass: boolean }>
      purge: { ok: boolean }
    }
    expect(body.success).toBe(true)
    expect(body.tenantId).toBe('acme')
    expect(body.envVarNames[0]).toBe('websites_a0e13_firebase_admin_project_id')
    expect(body.verification.length).toBeGreaterThan(0)
    expect(body.purge.ok).toBe(true)
  })

  it('answers 409 already-exists and never overwrites', async () => {
    const { deps, written } = makeDeps()
    const existingProvider = createFakeProvider({
      getRecord: async (input) =>
        input.id === 'website-settings-acme' ? { _id: 'website-settings' } : null,
    })
    const response = await handleTenantCreate(makeRequest(validRequest), {
      ...deps,
      providerFor: () => existingProvider,
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; existing: string[] }
    expect(body.error).toBe('already-exists')
    expect(body.existing).toContain('website-settings')
    expect(written).toHaveLength(0)
  })

  it('rate limits repeated attempts', async () => {
    const { deps } = makeDeps()
    const rateLimiter = createMemoryRateLimiter({ max: TENANT_CREATE_RATE_MAX, windowMs: TENANT_CREATE_RATE_WINDOW_MS })
    for (let attempt = 0; attempt < TENANT_CREATE_RATE_MAX + 1; attempt += 1) {
      const response = await handleTenantCreate(makeRequest(validRequest), {
        ...deps,
        rateLimiter,
      })
      if (attempt === TENANT_CREATE_RATE_MAX) {
        expect(response.status).toBe(429)
      }
    }
  })

  it('registers the requested domains and keeps the module env names lowercase (T-14)', async () => {
    const { deps, written } = makeDeps()
    await handleTenantCreate(makeRequest(validRequest), deps)
    const siteFolder = written.find((entry) => entry.collection === 'om_object_types')
    const folderData = (siteFolder?.data['data'] ?? {}) as Record<string, unknown>
    const websiteConfig = (folderData['websiteConfig'] ?? {}) as Record<string, unknown>
    expect(websiteConfig['hostNames']).toEqual(['acme.com', 'www.acme.com'])
  })

  void TENANT_CREATE_RATE_WINDOW_MS
})

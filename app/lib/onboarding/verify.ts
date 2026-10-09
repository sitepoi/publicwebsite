import type { DataProvider } from '@/lib/data/provider'
import { hostMatches } from '@/lib/resolver/host'

/**
 * Tenant-onboarding verification (SSOT section 6.10, T-14) - the server-side
 * half of the go-live gate. Each check returns id/name/pass/detail so the
 * registration screen can show exactly which layer is missing.
 */
export interface OnboardingCheck {
  id: string
  name: string
  pass: boolean
  detail: string
}

export interface VerifyTenantInput {
  hostNames: string[]
  tenantId: string
  appId: string
  provider: DataProvider
  resolveTenantForHost?: (host: string) => Promise<{ tenantId?: string } | null>
  registryHostNames?: () => Promise<string[]>
  runLiveChecks?: boolean
}

export async function verifyTenantOnboarding(input: VerifyTenantInput): Promise<OnboardingCheck[]> {
  const checks: OnboardingCheck[] = []
  const primaryHost = input.hostNames[0]

  // V-01: the registry (sitepoi-relay applications) maps each requested host.
  const registryHostNames = await input.registryHostNames?.().catch(() => undefined)
  if (registryHostNames) {
    for (const host of input.hostNames) {
      const matched = registryHostNames.some((pattern) => hostMatches(host, pattern))
      checks.push({
        id: `V-01-${host}`,
        name: `Registry maps ${host}`,
        pass: matched,
        detail: matched
          ? 'Hostname found in the sitepoi-relay applications registry.'
          : 'Hostname NOT in the registry yet - the CMS CNA call registers it; custom domains must be added CMS-side.',
      })
    }
  } else {
    checks.push({
      id: 'V-01',
      name: 'Registry resolution',
      pass: false,
      detail: 'Registry could not be read (sitepoi-relay admin credentials missing in the deployment env?).',
    })
  }

  if (input.resolveTenantForHost) {
    const resolved = await input.resolveTenantForHost(primaryHost).catch(() => null)
    checks.push({
      id: 'V-01-tenant',
      name: 'Registry points to the intended tenant',
      pass: resolved?.tenantId === input.tenantId,
      detail: resolved
        ? `Resolved tenant: ${resolved.tenantId ?? '(none)'} (expected ${input.tenantId})`
        : 'No tenant resolved for the host yet.',
    })
  }

  const settingsDocs = await input.provider.getSettings(['cms-settings'])
  checks.push({
    id: 'C-cms-settings',
    name: 'cms-settings document exists',
    pass: settingsDocs.length > 0,
    detail:
      settingsDocs.length > 0
        ? 'Tenant config written.'
        : 'cms-settings document missing (L4 write failed?).',
  })

  const folders = await input.provider.getObjectTypes(input.appId)
  const folderMapping = folders.find((folder) => {
    const data = (folder.data ?? {}) as Record<string, unknown>
    const config = (data['websiteConfig'] ?? {}) as Record<string, unknown>
    const names = Array.isArray(config['hostNames']) ? config['hostNames'] : []
    return input.hostNames.some((host) =>
      names.some((name) => typeof name === 'string' && hostMatches(host, name)),
    )
  })
  checks.push({
    id: 'C-folder-hostnames',
    name: 'website folder maps the domain(s)',
    pass: Boolean(folderMapping),
    detail: folderMapping
      ? 'Website folder written with matching hostNames.'
      : 'No website folder matches the requested hostNames.',
  })

  const homeQuery = await input.provider.queryObjects({
    cmsObjectType: input.appId,
    filters: [{ field: 'slug', op: '==', value: 'home-page' }],
    pageSize: 200,
  })
  checks.push({
    id: 'C-home-page',
    name: 'home-page stub exists',
    pass: homeQuery.items.length > 0,
    detail: homeQuery.items.length > 0 ? 'Home page renders at /.' : 'home-page object missing.',
  })

  if (input.runLiveChecks) {
    checks.push(
      await liveHttpCheck('V-02', `Home renders at https://${primaryHost}/`, `https://${primaryHost}/`),
      await liveHttpCheck(
        'V-05',
        `Sitemap served at https://${primaryHost}/sitemap.xml`,
        `https://${primaryHost}/sitemap.xml`,
      ),
    )
  } else {
    checks.push({
      id: 'V-02/V-05',
      name: 'Live render checks (post-deploy)',
      pass: false,
      detail: `After DNS + deployment open https://${primaryHost}/ and /sitemap.xml - both must return 200 (D-DWH-07).`,
    })
  }
  return checks
}

async function liveHttpCheck(id: string, name: string, url: string): Promise<OnboardingCheck> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    clearTimeout(timeoutId)
    return { id, name, pass: response.ok, detail: `HTTP ${response.status} from ${url}` }
  } catch {
    return { id, name, pass: false, detail: `Request to ${url} failed (DNS/deployment not ready?).` }
  }
}

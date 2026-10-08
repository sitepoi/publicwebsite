import type { z } from 'zod'
import { TenantConfigSchema, type TenantConfig } from '@/lib/contracts/tenants'
import { AppDefinitionSchema, type AppDefinition } from '@/lib/contracts/app-config'
import { SiteSettingsSchema, type SiteSettings } from '@/lib/contracts/site-settings'
import { decodeLegacyRelayBase64 } from '@/lib/resolver/tenant'

/**
 * Writer-side validation contract (T-17, D-DWH-02) - the SAME Zod schemas the
 * platform parses with, exported for external tools (CMS, sitepoi-relay
 * writers) to call BEFORE writing anything. Mirrors the platform's tolerance
 * rules exactly: invalid entries must be rejected at the writer, not
 * discovered at render time (failure matrix F-03).
 */

export type RegistryValidation =
  | { ok: true; value: TenantConfig | AppDefinition | SiteSettings }
  | { ok: false; issues: string[] }

export type RegistryValidationKind = 'tenant-config' | 'app-definition' | 'site-settings'

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

export function validateTenantConfig(raw: unknown): RegistryValidation {
  const result = TenantConfigSchema.safeParse(raw)
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: issuesOf(result.error) }
}

export function validateAppDefinition(raw: unknown): RegistryValidation {
  const result = AppDefinitionSchema.safeParse(raw)
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: issuesOf(result.error) }
}

export function validateSiteSettings(raw: unknown): RegistryValidation {
  const result = SiteSettingsSchema.safeParse(raw)
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: issuesOf(result.error) }
}

/** Legacy relay base64 (fbSettings.base64) → mapping (6.2) → tenant-config validation. */
export function validateRelayBase64(encoded: string): RegistryValidation {
  const mapped = decodeLegacyRelayBase64(encoded)
  if (mapped === undefined) {
    return {
      ok: false,
      issues: ['Invalid base64 payload, or missing projectId/authTenant (D-DWH-12 requires authTenant).'],
    }
  }
  return validateTenantConfig(mapped)
}

export function validateRegistryPayload(
  kind: RegistryValidationKind,
  payload: unknown,
): RegistryValidation {
  switch (kind) {
    case 'tenant-config':
      return validateTenantConfig(payload)
    case 'app-definition':
      return validateAppDefinition(payload)
    case 'site-settings':
      return validateSiteSettings(payload)
  }
}

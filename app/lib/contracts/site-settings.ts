import { z } from 'zod'

/**
 * Site settings contract (Section 7.4) — the DATA of the reserved-slug
 * `default-settings` object inside a website folder.
 *
 * Folders stay generic: domain mapping, theme, code slots and plugins all live
 * here. `hostNames` is REQUIRED (≥1) — it is the domain mapping for the site.
 */
export const SiteThemeSchema = z
  .object({
    colors: z.record(z.string(), z.string()).optional(),
    cssVariables: z.record(z.string(), z.string()).optional(),
    cssClasses: z.array(z.string()).optional(),
  })
  .catchall(z.unknown())

export type SiteTheme = z.infer<typeof SiteThemeSchema>

export const SitePluginsSchema = z
  .object({
    googleAnalyticsId: z.string().optional(),
    googleTagId: z.string().optional(),
    facebookPixelId: z.string().optional(),
    shareThis: z.string().optional(),
  })
  .catchall(z.unknown())

export type SitePlugins = z.infer<typeof SitePluginsSchema>

export const SiteWebSettingsSchema = z
  .object({
    sitemap: z
      .object({
        include: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    robots: z
      .object({
        disallow: z.array(z.string()).optional(),
      })
      .catchall(z.unknown())
      .optional(),
    indexNow: z
      .object({
        keyEnv: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown())

export type SiteWebSettings = z.infer<typeof SiteWebSettingsSchema>

export const SiteSettingsSchema = z
  .object({
    schemaVersion: z.string().optional(),
    hostNames: z.array(z.string()).min(1),
    primaryHost: z.string().optional(),
    defaultLanguage: z.string().optional(),
    previewSecret: z.string().optional(),
    currency: z.string().optional(),
    /** C14: site-level stylesheet injected BEFORE page css (Section 7.4). */
    sharedCss: z.string().optional(),
    theme: SiteThemeSchema.optional(),
    headCode: z.string().optional(),
    bodyStartCode: z.string().optional(),
    bodyEndCode: z.string().optional(),
    plugins: SitePluginsSchema.optional(),
    webSettings: SiteWebSettingsSchema.optional(),
    /** T-45 outside-API relay: the per-site host allowlist for widget
     * external fetches (https-only; exact hosts or `*.domain` wildcards). */
    externalApiHosts: z.array(z.string()).optional(),
    /** T-46 (D-WFLOW-43): the CMS v2 base URL this site's write relay and
     * key lookups are sent to (the CMS resolves the tenant from the
     * request HOST - Q-43). Optional - default = GW_CMS_WRITE_API_URL /
     * https://cms.uniconhub.com/api/v2. */
    cmsApiBaseUrl: z.string().url().optional(),
    /** T-46 (D-WFLOW-43): outbound write grants of THIS site - keys the
     * site may use, referenced BY NAME (secrets stay in the CMS).
     * `targetTenant` omitted = the site's own tenant (same-tenant
     * cross-app writes). `objectTypes` = the types this grant covers.
     * `cmsBaseUrl` = the target tenant's CMS host (defaults to the site's
     * cmsApiBaseUrl). */
    writeGrants: z
      .array(
        z.object({
          targetTenant: z.string().optional(),
          keyName: z.string().min(1),
          objectTypes: z.array(z.string()).min(1),
          cmsBaseUrl: z.string().url().optional(),
        }),
      )
      .optional(),
    /** First-party CMS relay allowlist (runtime-fetch service auth): the CMS
     * object types this site may reach through /api/cms/objects/* (reads and
     * writes). Absent/empty = the relay rejects every type. The CMS still
     * applies its own scope, private-type and folder checks. */
    cmsRelayObjectTypes: z.array(z.string().min(1)).optional(),
  })
  .catchall(z.unknown())

export type SiteSettings = z.infer<typeof SiteSettingsSchema>

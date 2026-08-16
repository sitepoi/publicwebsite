import { z } from 'zod'

/**
 * App-level config (Section 7.1) — the `cms-settings.objectTypes[]` entry.
 *
 * Any app id is allowed; an app becomes a website source when its
 * `capabilities` include `"website"` (NO hardcoded app id — current default is
 * `website-builder-uniconbaseapps`, tenant-configurable per Q12).
 */
export const WEBSITE_CAPABILITY = 'website'

/** Plan default website app id (Q12) — used ONLY when nothing else is
 * configured; never a hardcoded match (Section 7.3 rule 2). */
export const DEFAULT_APP_ID = 'website-builder-uniconbaseapps'

/** Settings doc that carries the app registry (Section 7.1:
 * `cms-settings.objectTypes[]` — existing doc). */
export const CMS_SETTINGS_DOC_ID = 'cms-settings'

export const CmsSettingsDocSchema = z
  .object({
    objectTypes: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown())

export type CmsSettingsDoc = z.infer<typeof CmsSettingsDocSchema>

export const AppDefinitionSchema = z
  .object({
    schemaVersion: z.string().optional(),
    id: z.string().min(1),
    capabilities: z.array(z.string()).optional(),
    rules: z
      .object({
        publicAccess: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    webSettings: z
      .object({
        sitemapSettings: z
          .object({
            addObjectsToSitemap: z.string().optional(),
          })
          .catchall(z.unknown())
          .optional(),
      })
      .catchall(z.unknown())
      .optional(),
    renderer: z
      .object({
        package: z.string(),
        version: z.string(),
      })
      .catchall(z.unknown())
      .optional(),
    routes: z.record(z.string(), z.unknown()).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())

export type AppDefinition = z.infer<typeof AppDefinitionSchema>

/** True when the app is website-capable (Section 7.3 resolution rule 2). */
export function isWebsiteCapable(app: Pick<AppDefinition, 'capabilities'>): boolean {
  return app.capabilities?.includes(WEBSITE_CAPABILITY) ?? false
}

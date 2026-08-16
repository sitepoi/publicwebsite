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
    theme: SiteThemeSchema.optional(),
    headCode: z.string().optional(),
    bodyStartCode: z.string().optional(),
    bodyEndCode: z.string().optional(),
    plugins: SitePluginsSchema.optional(),
    webSettings: SiteWebSettingsSchema.optional(),
  })
  .catchall(z.unknown())

export type SiteSettings = z.infer<typeof SiteSettingsSchema>

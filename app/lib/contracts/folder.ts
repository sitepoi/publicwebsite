import { z } from 'zod'

/**
 * Folder / website config (Section 7.2) — an `om_object_types` doc.
 *
 * A website folder is a completely NORMAL folder — NO website-specific fields
 * at all. Domain mapping and site config live in the `default-settings` OBJECT
 * inside the folder (Section 7.4 / contracts/site-settings.ts).
 */
export const FolderObjectTypeSchema = z
  .object({
    schemaVersion: z.string().optional(),
    id: z.string().min(1),
    slug: z.string().optional(),
    mainObjectType: z.string().optional(),
    name: z.string().optional(),
    categories: z.array(z.unknown()).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())

export type FolderObjectType = z.infer<typeof FolderObjectTypeSchema>

/** Plan name for the same shape (Section 6B interface: getObjectTypes → ObjectType[]). */
export type ObjectType = FolderObjectType

/** Reserved-slug site objects (Section 7.4 / Q3-Q5). */
export const RESERVED_SITE_SLUGS = ['default-header', 'default-footer', 'default-settings'] as const

export type ReservedSiteSlug = (typeof RESERVED_SITE_SLUGS)[number]

export const DEFAULT_SETTINGS_SLUG = 'default-settings'

export const DEFAULT_HEADER_SLUG = 'default-header'

export const DEFAULT_FOOTER_SLUG = 'default-footer'

/** Home page slug (Q12): object with slug 'home-page' (per language). */
export const HOME_PAGE_SLUG = 'home-page'

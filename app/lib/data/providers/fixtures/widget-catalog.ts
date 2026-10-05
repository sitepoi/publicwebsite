import type { WidgetCatalogRecord } from '@/lib/render/widget-islands'
import { parseCatalogRecord } from '@/lib/render/widget-islands'
import { fixtureWidgetCatalog } from './fixture-data'

/**
 * FixtureWidgetCatalogResolver — the GW_DEV_FIXTURES=1 double for the
 * application-store catalog fetch (never used in production). It serves the
 * in-memory `fixtureWidgetCatalog` so the island SSR pipeline is exercisable
 * in dev/e2e without network access to the store host.
 */
export function createFixtureWidgetCatalogResolver(): (
  names: string[],
) => Promise<Map<string, WidgetCatalogRecord>> {
  const records = new Map<string, WidgetCatalogRecord>()
  for (const entry of fixtureWidgetCatalog) {
    const record = parseCatalogRecord(entry)
    if (record && !records.has(record.gwAppName)) records.set(record.gwAppName, record)
  }
  return async () => records
}

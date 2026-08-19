import { randomUUID } from 'node:crypto'
import type { DataProvider, DataTransaction, SettingsDoc } from '@/lib/data/provider'
import type { DataQueryResult } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { ObjectType } from '@/lib/contracts/folder'
import { applyFilters, interpretQuery, withQueryDefaults } from '@/lib/data/common'
import { fixtureObjects, fixtureRecords, fixtureSettings, FIXTURE_FOLDER_ID } from './fixture-data'

/**
 * FixtureDataProvider — a DEV-ONLY fake implementing the DataProvider
 * contract over the in-memory fixture site (C4 deliverable). It is a test
 * double, not a database backend: it never appears in tenant configs and is
 * selected only via `GW_DEV_FIXTURES=1` in lib/resolver/index.ts (ADR-004).
 */
export class FixtureDataProvider implements DataProvider {
  readonly name = 'firestore' as const

  private readonly objects: ObjectRecord[]
  private readonly records: Map<string, Record<string, unknown>>

  constructor(
    objects: ObjectRecord[] = fixtureObjects,
    records: Map<string, Record<string, unknown>> = fixtureRecords,
  ) {
    this.objects = objects
    this.records = records
  }

  async getSettings(itemIds: string[]): Promise<SettingsDoc[]> {
    return itemIds.flatMap((id) => {
      const data = fixtureSettings[id]
      return data ? [{ id, ...data }] : []
    })
  }

  async getObjectTypes(mainObjectType: string): Promise<ObjectType[]> {
    if (mainObjectType !== fixtureObjects[0]?.cmsObjectType) return []
    return [{ id: FIXTURE_FOLDER_ID, slug: FIXTURE_FOLDER_ID, mainObjectType, name: 'Site A' }]
  }

  async getObject(input: { type: string; id: string }): Promise<ObjectRecord | null> {
    return (
      this.objects.find(
        (record) => record.id === input.id && record.cmsObjectType === input.type,
      ) ?? null
    )
  }

  async queryObjects(query: Parameters<DataProvider['queryObjects']>[0]): Promise<DataQueryResult> {
    const resolved = withQueryDefaults(query)
    let items = this.objects.filter((record) => record.cmsObjectType === resolved.cmsObjectType)
    if (resolved.folder !== undefined) {
      items = items.filter((record) => record.typeId === resolved.folder)
    }
    items = applyFilters(items, resolved.filters)
    return interpretQuery({
      items,
      query: resolved,
      loadRelated: async (targetType, ids) =>
        this.objects.filter(
          (record) => record.cmsObjectType === targetType && ids.includes(record.id),
        ),
    })
  }

  async createObject(): Promise<ObjectRecord> {
    throw new Error('FixtureDataProvider is read-only (dev fixture)')
  }

  async updateObject(): Promise<ObjectRecord> {
    throw new Error('FixtureDataProvider is read-only (dev fixture)')
  }

  async deleteObject(): Promise<void> {
    throw new Error('FixtureDataProvider is read-only (dev fixture)')
  }

  async createRecord(input: {
    collection: string
    id?: string
    data: Record<string, unknown>
  }): Promise<{ id: string }> {
    const id = input.id ?? `fx-${randomUUID()}`
    this.records.set(`${input.collection}:${id}`, input.data)
    return { id }
  }

  async getRecord(input: {
    collection: string
    id: string
  }): Promise<Record<string, unknown> | null> {
    return this.records.get(`${input.collection}:${input.id}`) ?? null
  }

  async queryRecords(input: {
    collection: string
    filters?: Parameters<DataProvider['queryRecords']>[0]['filters']
    limit?: number
  }): Promise<Record<string, unknown>[]> {
    let records: ObjectRecord[] = []
    for (const [key, data] of this.records) {
      if (key.startsWith(`${input.collection}:`)) records.push(data as ObjectRecord)
    }
    if (input.filters && input.filters.length > 0) records = applyFilters(records, input.filters)
    return records.slice(0, input.limit ?? 100)
  }

  async updateRecord(input: {
    collection: string
    id: string
    data: Record<string, unknown>
  }): Promise<void> {
    const key = `${input.collection}:${input.id}`
    this.records.set(key, { ...(this.records.get(key) ?? {}), ...input.data })
  }

  async deleteRecord(input: { collection: string; id: string }): Promise<void> {
    this.records.delete(`${input.collection}:${input.id}`)
  }

  async runTransaction<T>(fn: (tx: DataTransaction) => Promise<T>): Promise<T> {
    // In-memory transaction (C13 pilots): staged writes commit atomically
    // after fn resolves; a throw discards the staging.
    const staged: Array<{
      collection: string
      id?: string
      data: Record<string, unknown>
      mode: 'set' | 'update' | 'delete'
    }> = []
    const tx: DataTransaction = {
      get: async (input) => this.records.get(`${input.collection}:${input.id}`) ?? null,
      set: async (input) => {
        staged.push({ collection: input.collection, id: input.id, data: input.data, mode: 'set' })
      },
      update: async (input) => {
        staged.push({
          collection: input.collection,
          id: input.id,
          data: input.data,
          mode: 'update',
        })
      },
      delete: async (input) => {
        staged.push({ collection: input.collection, id: input.id, data: {}, mode: 'delete' })
      },
    }
    const result = await fn(tx)
    for (const write of staged) {
      const key = `${write.collection}:${write.id ?? `fx-${randomUUID()}`}`
      if (write.mode === 'set') this.records.set(key, write.data)
      else if (write.mode === 'update')
        this.records.set(key, { ...(this.records.get(key) ?? {}), ...write.data })
      else this.records.delete(key)
    }
    return result
  }

  subscribe(): () => void {
    return () => undefined
  }

  async uploadFile(): Promise<{ path: string; url: string }> {
    throw new Error('FixtureDataProvider has no storage (dev fixture)')
  }
}

const FIXTURE_PROVIDER_KEY = Symbol.for('gw.fixture.provider')

/** Singleton via globalThis — see lib/auth/fixture.ts (Turbopack module instances). */
export function createFixtureProvider(): DataProvider {
  const store = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = store[FIXTURE_PROVIDER_KEY] as DataProvider | undefined
  if (existing) return existing
  const provider = new FixtureDataProvider()
  store[FIXTURE_PROVIDER_KEY] = provider
  return provider
}

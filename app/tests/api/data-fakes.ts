import type {
  DataProvider,
  DataTransaction,
  SettingsDoc,
  CreateRecordInput,
} from '@/lib/data/provider'
import type { DataQueryResult } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { ObjectType } from '@/lib/contracts/folder'
import type { SiteConfig } from '@/lib/resolver/site'
import type { Env } from '@/lib/config/env'
import { applyFilters, interpretQuery } from '@/lib/data/common'

/**
 * Stateful fake provider for the data API tests (Section 6B): objects +
 * settings + folders + a collection-scoped record store with transactional
 * staging (rollback = discard). Same assertions run against the Firestore
 * emulator when FIRESTORE_EMULATOR_HOST is available (ADR-007).
 */
export interface StoreOptions {
  objects?: ObjectRecord[]
  settings?: Record<string, Record<string, unknown>>
  folders?: ObjectType[]
  records?: Map<string, Record<string, unknown>>
}

export interface CommittedWrite {
  collection: string
  id?: string
  data: Record<string, unknown>
  mode: 'set' | 'update' | 'delete'
}

export interface StoreProviderHandle {
  provider: DataProvider
  records: Map<string, Record<string, unknown>>
  committed: CommittedWrite[]
  operationResults: Map<string, Record<string, unknown>>
  queryCalls: () => number
  /** Push a record change into active subscribe() listeners (SSE tests). */
  emitRecordChange: (change: {
    type: 'added' | 'modified' | 'removed'
    object: ObjectRecord
  }) => void
}

export function createStoreProvider(options: StoreOptions = {}): StoreProviderHandle {
  const objects = options.objects ?? []
  const settings = options.settings ?? {}
  const folders = options.folders ?? []
  const records = options.records ?? new Map<string, Record<string, unknown>>()
  const operationResults = new Map<string, Record<string, unknown>>()
  const committed: CommittedWrite[] = []
  const subscribers = new Set<
    (change: { type: 'added' | 'modified' | 'removed'; object: ObjectRecord }) => void
  >()
  let queryCalls = 0

  const provider: DataProvider = {
    name: 'firestore',
    getSettings: async (itemIds) =>
      itemIds.flatMap((id) => {
        const data = settings[id]
        return data ? [{ id, ...data }] : []
      }),
    getObjectTypes: async () => folders,
    getObject: async ({ type, id }) => {
      const match = objects.find((record) => record.id === id && record.cmsObjectType === type)
      if (match) return match
      if (type === 'operation-results') {
        const result = operationResults.get(id)
        return result ? { id, ...result } : null
      }
      return null
    },
    queryObjects: async (query): Promise<DataQueryResult> => {
      queryCalls++
      let items = objects.filter((record) => record.cmsObjectType === query.cmsObjectType)
      if (query.folder !== undefined)
        items = items.filter((record) => record.typeId === query.folder)
      return interpretQuery({
        items,
        query,
        loadRelated: async (targetType, ids) =>
          objects.filter(
            (record) => record.cmsObjectType === targetType && ids.includes(record.id),
          ),
      })
    },
    createObject: async (input) => {
      if (input.type === 'operation-results' && input.id) {
        operationResults.set(input.id, input.data)
      }
      return { id: input.id ?? 'generated', ...input.data }
    },
    updateObject: async (input) => ({ id: input.id, ...input.data }),
    deleteObject: async () => undefined,
    createRecord: async (input: CreateRecordInput) => {
      committed.push({ collection: input.collection, id: input.id, data: input.data, mode: 'set' })
      const key = `${input.collection}:${input.id ?? `auto-${committed.length}`}`
      records.set(key, input.data)
      return { id: input.id ?? `auto-${committed.length}` }
    },
    getRecord: async ({ collection, id }) => records.get(`${collection}:${id}`) ?? null,
    queryRecords: async (input) => {
      let matches = [...records.entries()]
        .filter(([key]) => key.startsWith(`${input.collection}:`))
        .map(([, data]) => data)
      if (input.filters && input.filters.length > 0) {
        matches = applyFilters(
          matches as ObjectRecord[],
          input.filters,
        ) as unknown as typeof matches
      }
      return matches.slice(0, input.limit ?? 100)
    },
    updateRecord: async (input) => {
      committed.push({
        collection: input.collection,
        id: input.id,
        data: input.data,
        mode: 'update',
      })
      const key = `${input.collection}:${input.id}`
      records.set(key, { ...(records.get(key) ?? {}), ...input.data })
    },
    deleteRecord: async (input) => {
      committed.push({ collection: input.collection, id: input.id, data: {}, mode: 'delete' })
      records.delete(`${input.collection}:${input.id}`)
    },
    runTransaction: async <T>(fn: (tx: DataTransaction) => Promise<T>) => {
      const staged: CommittedWrite[] = []
      const readAtTx = (key: string) => records.get(key) ?? null
      const tx: DataTransaction = {
        get: async (input) => readAtTx(`${input.collection}:${input.id}`),
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
      const result = await fn(tx) // throws → rollback (nothing committed)
      for (const write of staged) {
        const key = `${write.collection}:${write.id ?? `auto-${committed.length + 1}`}`
        if (write.mode === 'set') records.set(key, write.data)
        else if (write.mode === 'update')
          records.set(key, { ...(records.get(key) ?? {}), ...write.data })
        else records.delete(key)
        committed.push(write)
      }
      return result
    },
    subscribe: (_channel, onChange) => {
      subscribers.add(onChange)
      return () => {
        subscribers.delete(onChange)
      }
    },
    uploadFile: async (input) => ({
      path: input.path,
      url: `https://storage.example/${input.path}`,
    }),
  }

  return {
    provider,
    records,
    committed,
    operationResults,
    queryCalls: () => queryCalls,
    emitRecordChange: (change) => {
      for (const subscriber of subscribers) subscriber(change)
    },
  }
}

export function makeDataSite(): SiteConfig {
  return {
    host: 'site-a.test',
    tenant: { tenantId: 't1', databaseProvider: 'firestore' },
    appId: 'website-builder-uniconbaseapps',
    folderId: 'folder-a',
    settings: { hostNames: ['site-a.test'], defaultLanguage: 'en' },
  }
}

export const dataEnv = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_APP_NAME: 'gw-test',
  FIREBASE_PROJECT_ID: 'project-a',
  FIREBASE_ADMIN_CLIENT_EMAIL: 'admin@project-a.iam.gserviceaccount.com',
  FIREBASE_ADMIN_PRIVATE_KEY: 'demo-key',
  RELAY_SECRET: 'test-salt',
  FORMS_RATE_LIMIT_MAX: 5,
  FORMS_RATE_LIMIT_WINDOW_MS: 60_000,
  REVALIDATE_SECRET: 'revalidate-secret',
} as Env

export function makeQueryRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://site-a.test/api/data/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test', ...headers },
    body: JSON.stringify(body),
  })
}

export function makeOpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://site-a.test/api/data/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gw-host': 'site-a.test', ...headers },
    body: JSON.stringify(body),
  })
}

export type { SettingsDoc }

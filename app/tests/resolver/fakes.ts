import type {
  DataProvider,
  DataTransaction,
  GetObjectInput,
  SettingsDoc,
  UpdateObjectInput,
} from '@/lib/data/provider'
import type { DataQueryResult } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { ObjectType } from '@/lib/contracts/folder'

/**
 * Firestore-free fake DataProvider (Section 6B) — unit tests inject data
 * through it; no Firebase SDK anywhere.
 */
export interface FakeProviderOverrides {
  getSettings?: (itemIds: string[]) => Promise<SettingsDoc[]>
  getObjectTypes?: (mainObjectType: string) => Promise<ObjectType[]>
  getObject?: (input: GetObjectInput) => Promise<ObjectRecord | null>
  queryObjects?: DataProvider['queryObjects']
  createRecord?: DataProvider['createRecord']
  getRecord?: DataProvider['getRecord']
  queryRecords?: DataProvider['queryRecords']
  updateRecord?: DataProvider['updateRecord']
  deleteRecord?: DataProvider['deleteRecord']
  uploadFile?: DataProvider['uploadFile']
}

export function createFakeProvider(overrides: FakeProviderOverrides = {}): DataProvider {
  return {
    name: 'firestore',
    getSettings: async () => [],
    getObjectTypes: async () => [],
    getObject: async () => null,
    queryObjects: async (): Promise<DataQueryResult> => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 24,
      facets: {},
      relations: {},
    }),
    createObject: async (input) => ({ id: input.id ?? 'generated-id', ...input.data }),
    updateObject: async (input: UpdateObjectInput) => ({ id: input.id, ...input.data }),
    deleteObject: async () => undefined,
    createRecord: async (input) => ({ id: input.id ?? 'generated-record-id' }),
    getRecord: async () => null,
    queryRecords: async () => [],
    updateRecord: async () => undefined,
    deleteRecord: async () => undefined,
    runTransaction: async <T>(fn: (tx: DataTransaction) => Promise<T>) =>
      fn({
        get: async () => null,
        set: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
      }),
    subscribe: () => () => undefined,
    uploadFile: async (input) => ({
      path: input.path,
      url: `https://storage.example/${input.path}`,
    }),
    ...overrides,
  }
}

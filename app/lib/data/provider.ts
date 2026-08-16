import type { DataQueryRequest, DataQueryResult } from '@/lib/contracts/data-query'
import type { DataFilter } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'
import type { ObjectType } from '@/lib/contracts/folder'

/**
 * DataProvider — the ONE data access contract for the whole platform
 * (Section 6B, decision 2026-08-14).
 *
 * App code (resolvers, APIs, operations, flows, SEO, cache) calls ONLY this
 * interface. Provider-specific code lives completely inside its own adapter
 * folder (lib/data/providers/firestore/, lib/data/providers/supabase/) and the
 * two adapters never share code beyond this contract + lib/data/common/.
 *
 * Layer model (Section 6B):
 *
 *   app code (provider-agnostic)
 *     │ calls ONLY the interface
 *   lib/data/provider.ts            (DataProvider contract — common)
 *     │
 *   lib/data/common/                (query/filter/facet/relation interpreter)
 *     │
 *   ┌───┴──────────────┐
 *   FirestoreProvider    SupabaseProvider   (fully separate adapters)
 *
 * A per-tenant backend switch is a tenant-config change
 * (`databaseProvider: 'firestore' | 'supabase'`) — app logic and the other
 * provider's adapter are never touched.
 */

export type DatabaseProviderName = 'firestore' | 'supabase'

/** A doc from the `settings` collection (Section 6B: getSettings). */
export interface SettingsDoc {
  id: string
  [key: string]: unknown
}

export interface GetObjectInput {
  type: string
  id: string
}

export interface CreateObjectInput {
  type: string
  id?: string
  data: Record<string, unknown>
}

export interface UpdateObjectInput {
  type: string
  id: string
  data: Record<string, unknown>
}

export interface DeleteObjectInput {
  type: string
  id: string
}

export interface CreateRecordInput {
  /** Target collection name (forms write to `${destinationTable}${ext}`, Section 14). */
  collection: string
  id?: string
  data: Record<string, unknown>
}

export interface GetRecordInput {
  collection: string
  id: string
}

export interface QueryRecordsInput {
  collection: string
  filters?: DataFilter[]
  limit?: number
}

export interface CreatedRecord {
  id: string
}

export interface UpdateRecordInput {
  collection: string
  id: string
  data: Record<string, unknown>
}

export interface DeleteRecordInput {
  collection: string
  id: string
}

export interface TxGetInput {
  collection: string
  id: string
}

export interface TxSetInput {
  collection: string
  id?: string
  data: Record<string, unknown>
}

export interface TxUpdateInput {
  collection: string
  id: string
  data: Record<string, unknown>
}

export interface TxDeleteInput {
  collection: string
  id: string
}

export type DataChangeType = 'added' | 'modified' | 'removed'

export interface DataChange {
  type: DataChangeType
  object: ObjectRecord
}

export interface SubscribeChannel {
  cmsObjectType?: string
  folder?: string
}

export type Unsubscribe = () => void

export interface UploadFileInput {
  path: string
  buffer: Buffer
  contentType: string
}

export interface StoredFile {
  path: string
  url: string
}

/**
 * Narrowed transactional handle handed to `runTransaction(fn)`. Provider
 * adapters map this onto their native transaction type (Firestore now,
 * Postgres later). Collection-scoped so operations can read-modify-write
 * arbitrary admin tables (Section 30).
 */
export interface DataTransaction {
  get(input: TxGetInput): Promise<Record<string, unknown> | null>
  set(input: TxSetInput): Promise<void>
  update(input: TxUpdateInput): Promise<void>
  delete(input: TxDeleteInput): Promise<void>
}

export interface DataProvider {
  readonly name: DatabaseProviderName

  /** Settings docs by id (settings collection). */
  getSettings(itemIds: string[]): Promise<SettingsDoc[]>

  /** Object types (folders) whose mainObjectType matches. */
  getObjectTypes(mainObjectType: string): Promise<ObjectType[]>

  /** One object by id (public first, then private — server enforces gating). */
  getObject(input: GetObjectInput): Promise<ObjectRecord | null>

  /** Generic read per the Section 29 contract. */
  queryObjects(query: DataQueryRequest): Promise<DataQueryResult>

  // Guarded write paths only (forms/operations — Sections 14, 30):
  createObject(input: CreateObjectInput): Promise<ObjectRecord>
  updateObject(input: UpdateObjectInput): Promise<ObjectRecord>
  deleteObject(input: DeleteObjectInput): Promise<void>

  /** Collection-scoped write (form results land in `${destinationTable}${ext}`). */
  createRecord(input: CreateRecordInput): Promise<CreatedRecord>

  /** Collection-scoped read (flow draft states, Section 31). */
  getRecord(input: GetRecordInput): Promise<Record<string, unknown> | null>

  /** Collection-scoped list read with server-side filters (account scoping, Section 32). */
  queryRecords(input: QueryRecordsInput): Promise<Record<string, unknown>[]>

  /** Collection-scoped update/delete (operations engine, Section 30). */
  updateRecord(input: UpdateRecordInput): Promise<void>
  deleteRecord(input: DeleteRecordInput): Promise<void>

  /** All-or-nothing writes (Section 33). */
  runTransaction<T>(fn: (tx: DataTransaction) => Promise<T>): Promise<T>

  /** Provider-native realtime (Section 34). */
  subscribe(channel: SubscribeChannel, onChange: (change: DataChange) => void): Unsubscribe

  /** Storage adapter (Firebase Storage now, Supabase Storage later). */
  uploadFile(input: UploadFileInput): Promise<StoredFile>
}

import {
  FieldPath,
  getFirestore,
  type CollectionReference,
  type DocumentData,
  type Firestore,
  type Query,
  type Transaction,
  type WhereFilterOp,
} from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import type { TenantConfig } from '@/lib/contracts/tenants'
import type {
  CreateObjectInput,
  CreateRecordInput,
  GetRecordInput,
  QueryRecordsInput,
  CreatedRecord,
  DataChange,
  DataProvider,
  DataTransaction,
  DeleteObjectInput,
  DeleteRecordInput,
  GetObjectInput,
  SettingsDoc,
  StoredFile,
  SubscribeChannel,
  Unsubscribe,
  UpdateObjectInput,
  UpdateRecordInput,
  UploadFileInput,
} from '@/lib/data/provider'
import type {
  DataFilter,
  DataFilterOp,
  DataQueryRequest,
  DataQueryResult,
} from '@/lib/contracts/data-query'
import type { ObjectType } from '@/lib/contracts/folder'
import type { ObjectRecord } from '@/lib/contracts/objects'
import {
  applyFilters,
  computeFacets,
  resolveRelations,
  searchItems,
  withQueryDefaults,
} from '@/lib/data/common'
import { getFirebaseAdminApp, type FirebaseAdminConfig } from '@/lib/firestore/admin-app'

/**
 * FirestoreProvider — the Firestore adapter (Sections 6 / 6B).
 *
 * Collection names stay Uniconhub-admin-compatible (Section 6 hard rule):
 *
 *   om_objects{ext} / om_private_objects{ext}   — objects (ext = tableExtension)
 *   om_object_types                             — folder/object-type docs
 *   settings                                    — settings docs
 *
 * Record shapes are never rewritten — NEXT-GEN only READS differently.
 *
 * v1 baseline notes (hardened in C7): filters with op 'contains', `search`,
 * and `facets` are interpreted over the fetched result window via the common
 * core; `total` is exact only when the query consists of Firestore-translatable
 * filters. Provider-agnostic code above us never sees these details.
 */

const OM_OBJECTS = 'om_objects'
const OM_PRIVATE_OBJECTS = 'om_private_objects'
const OM_OBJECT_TYPES = 'om_object_types'
const OM_SETTINGS = 'settings'

/** Max ids per Firestore `in` query (server limit 10). */
const IN_CHUNK_SIZE = 10

export class FirestoreProvider implements DataProvider {
  readonly name = 'firestore' as const

  private readonly config: FirebaseAdminConfig
  private readonly tableExtension: string
  private db?: Firestore

  constructor(config: FirebaseAdminConfig & { tableExtension?: string }) {
    this.config = config
    this.tableExtension = config.tableExtension ?? ''
  }

  private get firestore(): Firestore {
    if (!this.db) this.db = getFirestore(getFirebaseAdminApp(this.config))
    return this.db
  }

  private get objectsCollection(): CollectionReference<DocumentData> {
    return this.firestore.collection(`${OM_OBJECTS}${this.tableExtension}`)
  }

  private get privateObjectsCollection(): CollectionReference<DocumentData> {
    return this.firestore.collection(`${OM_PRIVATE_OBJECTS}${this.tableExtension}`)
  }

  async getSettings(itemIds: string[]): Promise<SettingsDoc[]> {
    if (itemIds.length === 0) return []
    const collection = this.firestore.collection(OM_SETTINGS)
    const snaps = await Promise.all(itemIds.map((id) => collection.doc(id).get()))
    return snaps.filter((snap) => snap.exists).map((snap) => ({ id: snap.id, ...snap.data() }))
  }

  async getObjectTypes(mainObjectType: string): Promise<ObjectType[]> {
    const snap = await this.firestore
      .collection(OM_OBJECT_TYPES)
      .where('mainObjectType', '==', mainObjectType)
      .get()
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  }

  async getObject(input: GetObjectInput): Promise<ObjectRecord | null> {
    const publicSnap = await this.objectsCollection.doc(input.id).get()
    if (publicSnap.exists) return snapshotToRecord(publicSnap)

    // Private objects (rules.publicAccess === 'no' → om_private_objects) are
    // server-filtered; v1 checks existence only — page gating arrives with
    // auth sessions (Section 17 / C9).
    const privateSnap = await this.privateObjectsCollection.doc(input.id).get()
    return privateSnap.exists ? snapshotToRecord(privateSnap) : null
  }

  async queryObjects(query: DataQueryRequest): Promise<DataQueryResult> {
    const resolved = withQueryDefaults(query)

    let ref: Query<DocumentData> = this.objectsCollection.where(
      'cmsObjectType',
      '==',
      resolved.cmsObjectType,
    )
    if (resolved.folder !== undefined) ref = ref.where('typeId', '==', resolved.folder)

    // Firestore-translatable filters go to the server; 'contains' is applied
    // by the common interpreter over the fetched window (v1 baseline).
    for (const filter of resolved.filters) {
      if (filter.op === 'contains') continue
      ref = ref.where(filter.field, toFirestoreOp(filter.op), toFirestoreValue(filter))
    }

    const hasTailWork = resolved.filters.some((filter) => filter.op === 'contains')
    const countRef: Query<DocumentData> = ref

    if (resolved.orderBy !== undefined) ref = ref.orderBy(resolved.orderBy, resolved.orderDir)
    const start = (resolved.page - 1) * resolved.pageSize
    ref = ref.offset(start).limit(resolved.pageSize)

    const snap = await ref.get()
    let items = snap.docs.map(snapshotToRecord)

    if (hasTailWork) {
      items = applyFilters(
        items,
        resolved.filters.filter((filter) => filter.op === 'contains'),
      )
    }
    if (resolved.search !== undefined) items = searchItems(items, resolved.search)

    const facets = computeFacets(items, resolved.facets)
    const relations = await resolveRelations(items, resolved.relations, (targetType, ids) =>
      this.getObjectsByIds(targetType, ids),
    )

    const total = hasTailWork
      ? start + items.length // window-approximate; hardened in C7
      : (await countRef.count().get()).data().count

    return {
      items,
      total,
      page: resolved.page,
      pageSize: resolved.pageSize,
      facets,
      relations,
    }
  }

  async createObject(input: CreateObjectInput): Promise<ObjectRecord> {
    const docRef =
      input.id !== undefined ? this.objectsCollection.doc(input.id) : this.objectsCollection.doc()
    await docRef.set(input.data)
    return { id: docRef.id, ...input.data }
  }

  async updateObject(input: UpdateObjectInput): Promise<ObjectRecord> {
    await this.objectsCollection.doc(input.id).update(input.data)
    return { id: input.id, ...input.data }
  }

  async deleteObject(input: DeleteObjectInput): Promise<void> {
    await this.objectsCollection.doc(input.id).delete()
  }

  async createRecord(input: CreateRecordInput): Promise<CreatedRecord> {
    const collection = this.firestore.collection(input.collection)
    const ref = input.id !== undefined ? collection.doc(input.id) : collection.doc()
    await ref.set(input.data)
    return { id: ref.id }
  }

  async getRecord(input: GetRecordInput): Promise<Record<string, unknown> | null> {
    const snap = await this.firestore.collection(input.collection).doc(input.id).get()
    return snap.exists ? (snap.data() as Record<string, unknown>) : null
  }

  async queryRecords(input: QueryRecordsInput): Promise<Record<string, unknown>[]> {
    let ref: Query<DocumentData> = this.firestore.collection(input.collection)
    const serverFilters = (input.filters ?? []).filter((filter) => filter.op !== 'contains')
    for (const filter of serverFilters) {
      ref = ref.where(filter.field, toFirestoreOp(filter.op), toFirestoreValue(filter))
    }
    ref = ref.limit(input.limit ?? 100)
    const snap = await ref.get()
    let records = snap.docs.map((doc) => doc.data() as Record<string, unknown>)
    const containsFilters = (input.filters ?? []).filter((filter) => filter.op === 'contains')
    if (containsFilters.length > 0) {
      records = applyFilters(records as ObjectRecord[], containsFilters) as unknown as Record<
        string,
        unknown
      >[]
    }
    return records
  }

  async updateRecord(input: UpdateRecordInput): Promise<void> {
    await this.firestore.collection(input.collection).doc(input.id).update(input.data)
  }

  async deleteRecord(input: DeleteRecordInput): Promise<void> {
    await this.firestore.collection(input.collection).doc(input.id).delete()
  }

  async runTransaction<T>(fn: (tx: DataTransaction) => Promise<T>): Promise<T> {
    const db = this.firestore
    return db.runTransaction(async (tx) => {
      const adapter = this.transactionAdapter(tx)
      return fn(adapter)
    })
  }

  subscribe(channel: SubscribeChannel, onChange: (change: DataChange) => void): Unsubscribe {
    let ref: Query<DocumentData> = this.objectsCollection
    if (channel.cmsObjectType !== undefined) {
      ref = ref.where('cmsObjectType', '==', channel.cmsObjectType)
    }
    if (channel.folder !== undefined) ref = ref.where('typeId', '==', channel.folder)

    return ref.onSnapshot((snap) => {
      for (const change of snap.docChanges()) {
        onChange({ type: change.type, object: snapshotToRecord(change.doc) })
      }
    })
  }

  async uploadFile(input: UploadFileInput): Promise<StoredFile> {
    const file = getStorage(getFirebaseAdminApp(this.config)).bucket().file(input.path)
    await file.save(input.buffer, { contentType: input.contentType })
    return { path: input.path, url: file.publicUrl() }
  }

  private transactionAdapter(tx: Transaction): DataTransaction {
    return {
      get: async (input) => {
        const snap = await tx.get(this.firestore.collection(input.collection).doc(input.id))
        return snap.exists ? (snap.data() ?? {}) : null
      },
      set: async (input) => {
        const collection = this.firestore.collection(input.collection)
        const ref = input.id !== undefined ? collection.doc(input.id) : collection.doc()
        tx.set(ref, input.data)
      },
      update: async (input) => {
        tx.update(this.firestore.collection(input.collection).doc(input.id), input.data)
      },
      delete: async (input) => {
        tx.delete(this.firestore.collection(input.collection).doc(input.id))
      },
    }
  }

  private async getObjectsByIds(targetType: string, ids: string[]): Promise<ObjectRecord[]> {
    if (ids.length === 0) return []
    const results: ObjectRecord[] = []
    for (let index = 0; index < ids.length; index += IN_CHUNK_SIZE) {
      const chunk = ids.slice(index, index + IN_CHUNK_SIZE)
      const snap = await this.objectsCollection.where(FieldPath.documentId(), 'in', chunk).get()
      results.push(...snap.docs.map(snapshotToRecord))
    }
    void targetType // relation target types map to the same object collections in v1
    return results
  }
}

export function createFirestoreProvider(tenant: TenantConfig): FirestoreProvider {
  const projectId = tenant.firebase?.projectId
  if (!projectId) {
    throw new Error(
      `Tenant '${tenant.tenantId}' uses databaseProvider 'firestore' but has no ` +
        'tenant.firebase.projectId (Section 6B)',
    )
  }
  return new FirestoreProvider({
    projectId,
    clientEmailEnv: tenant.firebase?.clientEmailEnv,
    privateKeyEnv: tenant.firebase?.privateKeyEnv,
    tableExtension: tenant.tableExtension,
  })
}

function snapshotToRecord(snap: {
  id: string
  data: () => DocumentData | undefined
}): ObjectRecord {
  return { id: snap.id, ...(snap.data() ?? {}) }
}

function toFirestoreOp(op: DataFilterOp): WhereFilterOp {
  switch (op) {
    case '==':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
    case 'in':
      return op
    case 'contains':
      throw new Error("'contains' filters are applied by the common interpreter, never Firestore")
  }
}

function toFirestoreValue(
  filter: DataFilter,
): string | number | boolean | null | (string | number | boolean | null)[] {
  const { value } = filter
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value
  }
  if (Array.isArray(value)) {
    const values = value.filter(
      (entry): entry is string | number | boolean | null =>
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean' ||
        entry === null,
    )
    if (values.length > 0) return values
  }
  throw new Error(
    `Filter '${filter.field} ${filter.op}' has a non-scalar value (objects are not ` +
      'supported as Firestore filter values)',
  )
}

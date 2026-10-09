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
  ObjectReadOptions,
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
import { sortItems } from '@/lib/data/common/filters'
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
  /** Tenant isolation (Section 6.11, D-DWH-16): tenants share ONE Firebase
   * project and are separated by the `tenantId` field - every read filters
   * and every write tags with this id. */
  private readonly tenantId: string
  private db?: Firestore

  constructor(config: FirebaseAdminConfig & { tableExtension?: string; tenantId?: string }) {
    this.config = config
    this.tableExtension = config.tableExtension ?? ''
    this.tenantId = config.tenantId ?? ''
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

  private get objectTypesCollection(): CollectionReference<DocumentData> {
    return this.firestore.collection(`${OM_OBJECT_TYPES}${this.tableExtension}`)
  }

  private get settingsCollection(): CollectionReference<DocumentData> {
    return this.firestore.collection(`${OM_SETTINGS}${this.tableExtension}`)
  }

  async getSettings(itemIds: string[]): Promise<SettingsDoc[]> {
    if (itemIds.length === 0) return []
    // Compatibility (Section 6.11): settings docs use ids {itemId}-{tenantId}
    // with an `_id` field - reads are FIELD queries, never doc-id reads.
    const results: SettingsDoc[] = []
    for (let index = 0; index < itemIds.length; index += IN_CHUNK_SIZE) {
      const chunk = itemIds.slice(index, index + IN_CHUNK_SIZE)
      const snap = await this.settingsCollection
        .where('_id', 'in', chunk)
        .where('tenantId', '==', this.tenantId)
        .get()
      results.push(...snap.docs.map((snap) => ({ id: snap.id, ...snap.data() })))
    }
    return results
  }

  async getObjectTypes(mainObjectType: string): Promise<ObjectType[]> {
    const snap = await this.objectTypesCollection
      .where('mainObjectType', '==', mainObjectType)
      .where('tenantId', '==', this.tenantId)
      .get()
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  }

  async getObject(
    input: GetObjectInput,
    options: ObjectReadOptions = {},
  ): Promise<ObjectRecord | null> {
    // Section 6.5: objects live in om_private_objects when the app's
    // rules.publicAccess is 'no' - the resolver passes the scope.
    const collection = options.usePrivateObjects
      ? this.privateObjectsCollection
      : this.objectsCollection
    const snap = await collection.doc(input.id).get()
    if (!snap.exists) return null
    const record = snapshotToRecord(snap)
    if (typeof record.tenantId === 'string' && record.tenantId !== this.tenantId) return null
    return record
  }

  async queryObjects(
    query: DataQueryRequest,
    options: ObjectReadOptions = {},
  ): Promise<DataQueryResult> {
    const resolved = withQueryDefaults(query)

    const collection = options.usePrivateObjects
      ? this.privateObjectsCollection
      : this.objectsCollection
    const base = collection
      .where('cmsObjectType', '==', resolved.cmsObjectType)
      .where('tenantId', '==', this.tenantId)

    // Folder scope (D-DWH-24): a single `folder` or a `folders` TREE chunked
    // to Firestore's IN limit of 30. No scope → one unfiltered run.
    const scopeChunks: Array<string[] | undefined> = []
    if (resolved.folders !== undefined && resolved.folders.length > 0) {
      for (let offset = 0; offset < resolved.folders.length; offset += 30) {
        scopeChunks.push(resolved.folders.slice(offset, offset + 30))
      }
    } else if (resolved.folder !== undefined) {
      scopeChunks.push([resolved.folder])
    } else {
      scopeChunks.push(undefined)
    }

    const hasTailWork = resolved.filters.some((filter) => filter.op === 'contains')
    const start = (resolved.page - 1) * resolved.pageSize

    const itemsById = new Map<string, ObjectRecord>()
    let total = 0
    for (const chunk of scopeChunks) {
      let ref: Query<DocumentData> = base
      if (chunk !== undefined) ref = ref.where('typeId', 'in', chunk)

      // Firestore-translatable filters go to the server; 'contains' is
      // applied by the common interpreter over the fetched window (v1 baseline).
      for (const filter of resolved.filters) {
        if (filter.op === 'contains') continue
        ref = ref.where(filter.field, toFirestoreOp(filter.op), toFirestoreValue(filter))
      }

      const countRef: Query<DocumentData> = ref
      if (resolved.orderBy !== undefined) ref = ref.orderBy(resolved.orderBy, resolved.orderDir)
      const snap = await ref.offset(start).limit(resolved.pageSize).get()
      for (const record of snap.docs.map(snapshotToRecord)) {
        if (!itemsById.has(record.id)) itemsById.set(record.id, record)
      }
      if (!hasTailWork && chunk !== undefined) {
        total += (await countRef.count().get()).data().count
      }
    }

    let items = [...itemsById.values()]
    if (resolved.orderBy !== undefined) {
      items = sortItems(items, resolved.orderBy, resolved.orderDir)
    }
    items = items.slice(0, resolved.pageSize)

    if (hasTailWork) {
      items = applyFilters(
        items,
        resolved.filters.filter((filter) => filter.op === 'contains'),
      )
    }
    if (resolved.search !== undefined) items = searchItems(items, resolved.search)

    const facets = computeFacets(items, resolved.facets)
    const relations = await resolveRelations(items, resolved.relations, (targetType, ids) =>
      this.getObjectsByIds(targetType, ids, options),
    )

    const finalTotal = hasTailWork
      ? start + items.length // window-approximate; hardened in C7
      : total

    return {
      items,
      total: finalTotal,
      page: resolved.page,
      pageSize: resolved.pageSize,
      facets,
      relations,
    }
  }

  async createObject(input: CreateObjectInput): Promise<ObjectRecord> {
    const docRef =
      input.id !== undefined ? this.objectsCollection.doc(input.id) : this.objectsCollection.doc()
    const data = withTenantId(input.data, this.tenantId)
    await docRef.set(data)
    return { id: docRef.id, ...data }
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
    await ref.set(withTenantId(input.data, this.tenantId))
    return { id: ref.id }
  }

  async getRecord(input: GetRecordInput): Promise<Record<string, unknown> | null> {
    const snap = await this.firestore.collection(input.collection).doc(input.id).get()
    if (!snap.exists) return null
    const data = (snap.data() ?? {}) as Record<string, unknown>
    if (typeof data['tenantId'] === 'string' && data['tenantId'] !== this.tenantId) return null
    return data
  }

  async queryRecords(input: QueryRecordsInput): Promise<Record<string, unknown>[]> {
    let ref: Query<DocumentData> = this.firestore.collection(input.collection).where(
      'tenantId',
      '==',
      this.tenantId,
    )
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
    let ref: Query<DocumentData> = this.objectsCollection.where('tenantId', '==', this.tenantId)
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
        tx.set(ref, withTenantId(input.data, this.tenantId))
      },
      update: async (input) => {
        tx.update(this.firestore.collection(input.collection).doc(input.id), input.data)
      },
      delete: async (input) => {
        tx.delete(this.firestore.collection(input.collection).doc(input.id))
      },
    }
  }

  private async getObjectsByIds(
    targetType: string,
    ids: string[],
    options: ObjectReadOptions = {},
  ): Promise<ObjectRecord[]> {
    if (ids.length === 0) return []
    const collection = options.usePrivateObjects
      ? this.privateObjectsCollection
      : this.objectsCollection
    const results: ObjectRecord[] = []
    for (let index = 0; index < ids.length; index += IN_CHUNK_SIZE) {
      const chunk = ids.slice(index, index + IN_CHUNK_SIZE)
      const snap = await collection
        .where(FieldPath.documentId(), 'in', chunk)
        .where('tenantId', '==', this.tenantId)
        .get()
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
    tenantId: tenant.tenantId,
  })
}

/** Tag a write with the tenant id (D-DWH-16) unless the data already has one. */
function withTenantId(data: Record<string, unknown>, tenantId: string): Record<string, unknown> {
  if (tenantId.length === 0 || data['tenantId'] !== undefined) return data
  return { ...data, tenantId }
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

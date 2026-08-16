import type { DataProvider, CreateRecordInput, UploadFileInput } from '@/lib/data/provider'
import type { SiteConfig } from '@/lib/resolver/site'
import type { Env } from '@/lib/config/env'
import type { ObjectRecord } from '@/lib/contracts/objects'
import { createFakeProvider } from '../resolver/fakes'

/**
 * Firestore-free forms test doubles (Section 6B): a recording DataProvider
 * that captures createRecord/uploadFile writes so the tests assert the exact
 * saveForm-compatible record shape without an emulator binary. The same
 * assertions run against the Firestore adapter when FIRESTORE_EMULATOR_HOST
 * is available (ADR-006).
 */
export interface RecordedWrite {
  input: CreateRecordInput
}

export function createRecordingProvider(objects: ObjectRecord[] = []) {
  const writes: RecordedWrite[] = []
  const uploads: UploadFileInput[] = []

  const provider = createFakeProvider({
    createRecord: async (input) => {
      writes.push({ input })
      return { id: input.id ?? 'generated-record-id' }
    },
    uploadFile: async (input) => {
      uploads.push(input)
      return { path: input.path, url: `https://storage.example/${input.path}` }
    },
    queryObjects: async (query) => {
      const filtered = objects.filter((record) => {
        if (query.cmsObjectType !== undefined && record.cmsObjectType !== query.cmsObjectType) {
          return false
        }
        if (query.folder !== undefined && record.typeId !== query.folder) return false
        const slug = query.filters?.find((filter) => filter.field === 'slug')
        return !slug || record.slug === slug.value
      })
      return {
        items: filtered,
        total: filtered.length,
        page: 1,
        pageSize: 24,
        facets: {},
        relations: {},
      }
    },
  })

  return { provider, writes, uploads }
}

export function makeTestSite(): SiteConfig {
  return {
    host: 'site-a.test',
    tenant: { tenantId: 't1', databaseProvider: 'firestore', tableExtension: 'ext' },
    appId: 'website-builder-uniconbaseapps',
    folderId: 'folder-a',
    settings: { hostNames: ['site-a.test'], defaultLanguage: 'en' },
  }
}

export const testEnv = {
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

export function makeJsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://site-a.test/api/forms/submit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gw-host': 'site-a.test',
      origin: 'https://site-a.test',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

export function makeUploadRequest(file: File, headers: Record<string, string> = {}): Request {
  const formData = new FormData()
  formData.append('file', file)
  return new Request('https://site-a.test/api/forms/upload', {
    method: 'POST',
    headers: { 'x-gw-host': 'site-a.test', origin: 'https://site-a.test', ...headers },
    body: formData,
  })
}

export function makeFormTypeObject(
  formTypeId: string,
  data: Record<string, unknown>,
): ObjectRecord {
  return {
    id: `ft-${formTypeId}`,
    contentId: formTypeId,
    slug: 'form-type-definition',
    cmsObjectType: 'system-items',
    typeId: 'system',
    meta: { slug: 'form-type-definition', language: 'en' },
    data: { formTypeId, type: 'json', ...data },
  }
}

export type { DataProvider }

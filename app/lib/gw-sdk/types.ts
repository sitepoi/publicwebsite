/**
 * window.gw SDK v2 — public types (Section 12).
 *
 * These types describe the runtime surface installed by
 * `buildGwBootstrapScript` (lib/gw-sdk/bootstrap.ts). The SDK itself is
 * serialized as a self-contained script string and executed in the browser —
 * see runtime.ts.
 */

import type { DataQueryResult } from '@/lib/contracts/data-query'
import type { ObjectRecord } from '@/lib/contracts/objects'

export interface GwContext {
  pageId: string
  siteId: string
  folderId: string
  language: string
  host: string
  currency?: string
  query?: Record<string, string>
  pathParams?: Record<string, string>
}

export interface GwUser {
  id: string
  name?: string
  email?: string
  roles: string[]
  tenantId?: string
}

export interface GwStorageArea {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export interface GwStorage extends GwStorageArea {
  session: GwStorageArea
}

export type GwNotifySeverity = 'info' | 'success' | 'warning' | 'error'

export interface GwNotifyOptions {
  severity?: GwNotifySeverity
  duration?: number
  title?: string
}

export interface GwModalOptions {
  title?: string
  closeable?: boolean
}

export type GwRouteChangeListener = () => void
export type GwUnsubscribe = () => void

export interface GwFormSubmitOptions {
  formTypeId?: string
}

export interface GwFormSubmitResult {
  ok: boolean
  status?: number
  data?: unknown
  error?: string
}

export interface GwFormInvalidDetail {
  field: string
  message: string
}

export type GwDataQueryParams = Parameters<GwDb['query']>[0]

export interface GwSseEvent {
  id: string
  type: string
  folderId?: string
  tenantId?: string
  payload?: Record<string, unknown>
  createdAt?: string
}

export type GwDataChange =
  | { type: 'added' | 'modified' | 'removed'; object: ObjectRecord }
  | { type: 'gw-event'; event: GwSseEvent }

export interface GwDb {
  /** Section 29 READ — POST /api/data/query (public objects only). */
  query(params: {
    cmsObjectType: string
    folder?: string
    filters?: Array<{ field: string; op: string; value: unknown }>
    search?: string
    orderBy?: string
    orderDir?: 'asc' | 'desc'
    page?: number
    pageSize?: number
    language?: string
    relations?: Array<{ field: string; targetType: string; targetField?: string }>
    facets?: string[]
  }): Promise<DataQueryResult>
  /** Section 29 READ — GET /api/data/{cmsObjectType}/{objectId}. */
  get(params: { cmsObjectType: string; objectId: string }): Promise<ObjectRecord | null>
  /** Section 29 WRITE — POST /api/data/op (the ONLY set path). */
  operation(
    operation: string,
    payload: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ): Promise<unknown>
  /** Section 29/34 realtime — SSE since C11 (polling fallback). */
  subscribe(
    channel: { cmsObjectType?: string; folder?: string },
    onChange: (change: GwDataChange) => void,
  ): GwUnsubscribe
}

export interface GwAppFactoryContext {
  el: Element
  config: Record<string, unknown>
  gw: GwSdk
}

export type GwAppFactory = (context: GwAppFactoryContext) => void | (() => void)

export interface GwApps {
  /** Idempotent — re-registering replaces the factory (SPA-safe, C12). */
  register(name: string, factory: GwAppFactory): void
  /** Mounts every [data-gw-app] island in scope; already-mounted islands skip. */
  mount(root?: ParentNode): void
  /** Runs cleanup functions and unmarks mounted islands (re-mountable). */
  unmount(root?: ParentNode): void
}

export interface GwForms {
  submit(form: HTMLFormElement, options?: GwFormSubmitOptions): Promise<GwFormSubmitResult>
  bind(root?: ParentNode): void
}

export interface GwSdk {
  pageId: string
  siteId: string
  folderId: string
  language: string
  host: string
  currency?: string

  getPageParams(): Record<string, string>
  navigate(path: string): void
  openUrl(url: string): void
  onRouteChange(listener: GwRouteChangeListener): GwUnsubscribe

  getUser(): GwUser | null
  isAuthenticated(): boolean
  /** Resolves once the boot-time session fetch completes (C9). */
  authReady: Promise<GwUser | null>
  /** Re-fetch the session (login/logout followed by this call). */
  refreshAuth(): Promise<GwUser | null>
  login(returnUrl?: string): void
  logout(): void

  storage: GwStorage
  track(event: string, data?: Record<string, unknown>): void
  trackPageView(): void

  notify(message: string, options?: GwNotifyOptions): void
  showModal(html: string, options?: GwModalOptions): () => void
  setLoading(loading: boolean): void

  sanitize(html: string): string
  formatDate(value: Date | string | number, locale?: string): string
  formatCurrency(amount: number | string, currency?: string): string

  forms: GwForms
  db: GwDb
  apps: GwApps

  /** Server-validated services (Section 12) — endpoints arrive C6/M9+. */
  service(name: string): Promise<never>
}

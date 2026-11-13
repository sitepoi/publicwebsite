import { NextResponse, type NextRequest } from 'next/server'
import { handleCmsRelay } from '@/lib/server/cmsRelay'

/**
 * First-party CMS v2 relay (runtime-fetch service auth).
 *
 *   GET   /api/cms/objects/{type}            list
 *   GET   /api/cms/objects/{type}/{id}       detail
 *   POST  /api/cms/objects/{type}/query      query
 *   POST  /api/cms/objects/{type}            create  (x-unicon-write-source)
 *   PATCH /api/cms/objects/{type}/{id}       update  (x-unicon-write-source)
 *   PUT   /api/cms/objects/{type}/{id}       update  (x-unicon-write-source)
 *   DELETE                                   ALWAYS 403
 *
 * The tenant is resolved from the trusted host (proxy sets x-gw-host); the
 * browser never supplies tenantId. Credentials are fetched server-side from
 * the Secret API and a fresh service JWT is minted per attempt — no key or
 * token ever reaches the browser.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<Response> {
  return handleCmsRelay(request)
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleCmsRelay(request)
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return handleCmsRelay(request)
}

export async function PUT(request: NextRequest): Promise<Response> {
  return handleCmsRelay(request)
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: 'CMS_DELETE_NOT_ALLOWED' }, { status: 403 })
}

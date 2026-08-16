import { NextResponse, type NextRequest } from 'next/server'
import { getEnv } from '@/lib/config/env'
import { getResolverStack } from '@/lib/resolver'

/**
 * GET /api/relay/ras?hostname=… — tooling parity with the legacy relay
 * (Section 6 / C2).
 *
 * Guarded by the RELAY_SECRET env (x-relay-secret header). Returns a SAFE
 * metadata subset, base64-encoded like the legacy config — NEVER credentials
 * (secrets are env-only; the client couples to server routes, Section 6B).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getEnv()
  if (request.headers.get('x-relay-secret') !== env.RELAY_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const hostname =
    request.nextUrl.searchParams.get('hostname') ??
    request.headers.get('x-gw-host') ??
    request.headers.get('host') ??
    ''

  const tenant = await getResolverStack().resolveTenant(hostname)
  if (!tenant) {
    return NextResponse.json({ error: 'tenant-not-found', hostname }, { status: 404 })
  }

  const safeConfig = {
    tenantId: tenant.tenantId,
    databaseProvider: tenant.databaseProvider,
    tableExtension: tenant.tableExtension ?? '',
    projectId: tenant.firebase?.projectId ?? '',
    defaultAppId: tenant.defaultAppId ?? '',
  }
  const encoded = Buffer.from(JSON.stringify(safeConfig)).toString('base64')

  return NextResponse.json({ hostname, config: encoded })
}

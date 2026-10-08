import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getEnv, type Env } from '@/lib/config/env'
import { validateRegistryPayload, validateRelayBase64 } from '@/lib/onboarding/validate'

/**
 * POST /api/relay/validate (T-17) - the writer-side validation contract.
 * External tools (CMS, sitepoi-relay writers) call this BEFORE writing so
 * invalid entries are rejected at the writer, not silently skipped at render
 * time (F-03). Guarded by x-relay-secret (RELAY_SECRET).
 *
 * Body: { kind: 'tenant-config' | 'app-definition' | 'site-settings' | 'relay-base64',
 *         payload?: unknown, encoded?: string }
 * 200 { ok: true } · 422 { ok: false, issues } · 401 unauthorized · 400 invalid-request
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RelayValidateRequestSchema = z.object({
  kind: z.enum(['tenant-config', 'app-definition', 'site-settings', 'relay-base64']),
  payload: z.unknown().optional(),
  encoded: z.string().optional(),
})

export async function handleRelayValidate(
  request: Request,
  deps: { env?: Env } = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  if (request.headers.get('x-relay-secret') !== env.RELAY_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const parsed = RelayValidateRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid-request',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
      { status: 400 },
    )
  }
  const input = parsed.data

  const result =
    input.kind === 'relay-base64'
      ? validateRelayBase64(input.encoded ?? '')
      : validateRegistryPayload(input.kind, input.payload)

  if (!result.ok) {
    return NextResponse.json({ ok: false, issues: result.issues }, { status: 422 })
  }
  return NextResponse.json({ ok: true })
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = await handleRelayValidate(request)
  return NextResponse.json(await response.json(), { status: response.status })
}

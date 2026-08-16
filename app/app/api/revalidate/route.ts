import { z } from 'zod'
import { getEnv, type Env } from '@/lib/config/env'
import { purgeTags, type PurgeDeps } from '@/lib/cache/purge'
import { getLogger, newRequestId } from '@/lib/log/logger'

/**
 * POST /api/revalidate (Section 18) — publish webhook guarded by the shared
 * REVALIDATE_SECRET (x-revalidate-secret header). Body: { tags: string[] }
 * with the site-/page-/type-/host- tag vocabulary; site-* purges also clear
 * the resolver memory caches so config changes are served immediately.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RevalidateBodySchema = z
  .object({
    tags: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict()

export interface RevalidateDeps {
  env?: Env
  purge?: (tags: string[]) => Promise<string[]>
}

export async function handleRevalidate(
  request: Request,
  deps: RevalidateDeps = {},
): Promise<Response> {
  const env = deps.env ?? getEnv()
  const log = getLogger()
  const requestId = request.headers.get('x-request-id') ?? newRequestId()

  const secret = request.headers.get('x-revalidate-secret')
  if (!secret || secret !== env.REVALIDATE_SECRET) {
    log.warn({ requestId, path: '/api/revalidate', msg: 'revalidate: bad secret' })
    return json({ error: 'unauthorized' }, 401)
  }

  const parsed = RevalidateBodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid-revalidate-call' }, 400)

  const purged = await (deps.purge ?? ((tags) => purgeTags(tags)))(parsed.data.tags)
  log.info({ requestId, path: '/api/revalidate', purged, msg: 'tags purged' })
  return json({ ok: true, purged })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(request: Request): Promise<Response> {
  return handleRevalidate(request)
}

export type { PurgeDeps }

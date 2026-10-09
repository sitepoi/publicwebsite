import { SW_CLEANUP_SOURCE } from '@/lib/gw-sdk'

/**
 * GET /sw.js — self-destructing service worker (D-DWH-28).
 *
 * This platform registers NO service worker. Browsers that carry a STALE
 * registration from the earlier platform serving this origin keep requesting
 * /sw.js on every navigation (Vercel logs those as 404 warnings on the
 * [[...slug]] route). Serving this tiny worker lets those clients unregister
 * themselves; new visits never fetch it again.
 */
export const dynamic = 'force-static'

export function GET(): Response {
  return new Response(SW_CLEANUP_SOURCE, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    },
  })
}

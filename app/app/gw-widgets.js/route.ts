import { WIDGETS_SOURCE } from '@/lib/gw-sdk'

/**
 * GET /gw-widgets.js — the widget library v1 script (C12). Lazy-loaded by
 * the SDK when a builtin data-gw-app island first mounts. Static-cacheable.
 */
export const dynamic = 'force-static'

export function GET(): Response {
  return new Response(WIDGETS_SOURCE, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  })
}

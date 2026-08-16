import { SDK_SOURCE } from './sdk-source'
import type { GwContext } from './types'

/**
 * Bootstrap source builder (Section 12) — wraps the explicit SDK source
 * (lib/gw-sdk/sdk-source.ts — NEVER compiled-function toString, see ADR-005)
 * with the serialized page context. DOMPurify is loaded separately as a
 * vendored static script (/vendor/purify.min.js via ScriptSlot); sanitize
 * degrades to a tag-stripping fallback until it loads.
 */
export function buildGwBootstrapScript(context: GwContext): string {
  const serialized = JSON.stringify(context).replace(/</g, '\\u003c')
  return '(' + SDK_SOURCE + ')(' + serialized + ');\n'
}

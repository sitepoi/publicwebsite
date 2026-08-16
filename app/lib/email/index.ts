import { getEnv } from '@/lib/config/env'
import { SesMailService } from './ses'
import type { MailService } from './types'

/**
 * Mail service selection (Section 15) — env creds only. Returns null when
 * SES is not configured (the route answers 503 email-not-configured).
 */
let cached: MailService | null = null
let resolved = false

export function getMailService(): MailService | null {
  if (!resolved) {
    resolved = true
    const env = getEnv()
    if (
      env.SES_ACCESS_KEY_ID &&
      env.SES_SECRET_ACCESS_KEY &&
      env.SES_REGION &&
      env.SES_FROM_ADDRESS
    ) {
      cached = new SesMailService({
        region: env.SES_REGION,
        fromAddress: env.SES_FROM_ADDRESS,
        accessKeyId: env.SES_ACCESS_KEY_ID,
        secretAccessKey: env.SES_SECRET_ACCESS_KEY,
      })
    }
  }
  return cached
}

export type { MailService, MailInput } from './types'

/** Escape user data before merging into email templates (no raw injection). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Merge {{key}} placeholders from server-selected template + escaped data. */
export function renderTemplate(html: string, data: Record<string, unknown>): string {
  return html.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
    escapeHtml(data[key]),
  )
}

/** Plain merge (no escaping) — for non-HTML fields like the subject line. */
export function fillTemplate(text: string, data: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
    String(data[key] ?? ''),
  )
}

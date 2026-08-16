import { StripePayService } from './stripe'
import type { StripeService } from './types'

/**
 * Stripe service selection + env convention (Section 15 / Section 22):
 *
 *   <TENANT>_STRIPE_SECRET         <TENANT>_STRIPE_WEBHOOK_SECRET
 *   <TENANT>_STRIPE_PUBLISHABLE
 *
 * with the global STRIPE_SECRET / STRIPE_WEBHOOK_SECRET as fallback.
 * Secrets are read from process.env ONLY (hard rule).
 */
export function stripeEnvNames(tenantId: string): {
  secretEnv: string
  webhookSecretEnv: string
} {
  const prefix = tenantId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return {
    secretEnv: `${prefix}_STRIPE_SECRET`,
    webhookSecretEnv: `${prefix}_STRIPE_WEBHOOK_SECRET`,
  }
}

export function resolveStripeKeys(tenantId: string): {
  secretKey: string | undefined
  webhookSecret: string | undefined
} {
  const names = stripeEnvNames(tenantId)
  return {
    secretKey: process.env[names.secretEnv] ?? process.env.STRIPE_SECRET,
    webhookSecret: process.env[names.webhookSecretEnv] ?? process.env.STRIPE_WEBHOOK_SECRET,
  }
}

const cache = new Map<string, StripeService>()

export function getStripeService(tenantId: string): StripeService {
  const existing = cache.get(tenantId)
  if (existing) return existing

  const { secretKey, webhookSecret } = resolveStripeKeys(tenantId)
  if (!secretKey || secretKey.length === 0) throw new Error('stripe-not-configured')
  const service = new StripePayService(secretKey, webhookSecret)
  cache.set(tenantId, service)
  return service
}

export type { StripeService, StripeIntent, StripeWebhookEvent } from './types'

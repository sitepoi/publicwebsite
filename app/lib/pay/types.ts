/**
 * Payment service abstraction (Section 15 / C10) — the ONE payment contract
 * for app code. Stripe is the current adapter (lib/pay/stripe.ts); the
 * amount is ALWAYS computed server-side by callers — this interface only
 * receives what the server decided.
 */
export interface StripeIntent {
  id: string
  clientSecret: string | null
  amount: number // minor units (cents)
  currency: string
  status: string
  metadata: Record<string, string>
}

export interface StripeWebhookEvent {
  type: string
  data: {
    object: {
      id: string
      metadata: Record<string, string>
    }
  }
}

export interface StripeService {
  readonly name: string

  createPaymentIntent(input: {
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<StripeIntent>

  retrievePaymentIntent(id: string): Promise<StripeIntent>

  /** Stripe webhook signature verification (raw body + signature header). */
  constructWebhookEvent(rawBody: string, signature: string): Promise<StripeWebhookEvent>
}

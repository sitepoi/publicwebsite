import Stripe from 'stripe'
import type { StripeService, StripeIntent, StripeWebhookEvent } from './types'

/**
 * StripePayService (Section 15) — PaymentIntents + webhook signature
 * verification via the official Stripe SDK. Keys are injected by the caller
 * (env-only, `<TENANT>_STRIPE_*` convention — lib/pay/index.ts).
 */
export class StripePayService implements StripeService {
  readonly name = 'stripe'

  private readonly client: Stripe

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.client = new Stripe(secretKey)
  }

  async createPaymentIntent(input: {
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<StripeIntent> {
    const intent = await this.client.paymentIntents.create({
      amount: input.amount,
      currency: input.currency,
      metadata: input.metadata,
      automatic_payment_methods: { enabled: true },
    })
    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      metadata: intent.metadata as Record<string, string>,
    }
  }

  async retrievePaymentIntent(id: string): Promise<StripeIntent> {
    const intent = await this.client.paymentIntents.retrieve(id)
    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      metadata: intent.metadata as Record<string, string>,
    }
  }

  async constructWebhookEvent(rawBody: string, signature: string): Promise<StripeWebhookEvent> {
    if (!this.webhookSecret) throw new Error('stripe-not-configured')
    const event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret)
    const object = event.data.object as { id: string; metadata?: Record<string, string> }
    return {
      type: event.type,
      data: { object: { id: object.id, metadata: object.metadata ?? {} } },
    }
  }
}

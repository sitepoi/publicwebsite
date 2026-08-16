import { z } from 'zod'

/**
 * Service endpoint contracts (Section 15 / C10):
 * payments (Stripe), email (SES), search (fuse), cart.
 *
 * HARD RULES: payment amounts are ALWAYS computed server-side (intent create
 * accepts only a flowStateId — never an amount); secrets are env-only;
 * the cart is pure data and checkout goes through flows (C8).
 */
export const AUTH_EMAIL = z.string().trim().min(3).max(254)

/** POST /api/pay/stripe/intent — amount comes from the flow's amountFormula. */
export const PayIntentCreateSchema = z
  .object({
    flowStateId: z.string().min(1),
  })
  .strict()

export const PayConfirmSchema = z
  .object({
    paymentIntentId: z.string().min(1),
  })
  .strict()

/** POST /api/email/send — template selection is SERVER-side; no raw html. */
export const EmailSendSchema = z
  .object({
    to: AUTH_EMAIL,
    templateId: z.string().min(1).max(200),
    subject: z.string().max(200).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    gw_hp: z.string().optional(),
  })
  .strict()

export const CartItemSchema = z.object({
  cmsObjectType: z.string().min(1),
  objectId: z.string().min(1),
  qty: z.number().int().min(1).max(999),
})

export const CartCallSchema = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('add'), item: CartItemSchema, gw_hp: z.string().optional() })
    .strict(),
  z
    .object({ action: z.literal('update'), item: CartItemSchema, gw_hp: z.string().optional() })
    .strict(),
  z
    .object({
      action: z.literal('remove'),
      item: CartItemSchema.omit({ qty: true }),
      gw_hp: z.string().optional(),
    })
    .strict(),
  z.object({ action: z.literal('clear'), gw_hp: z.string().optional() }).strict(),
])

export type CartCall = z.infer<typeof CartCallSchema>

/** GET /api/search query parameters. */
export const SearchQuerySchema = z.object({
  type: z.string().min(1),
  folder: z.string().optional(),
  q: z.string().min(1).max(200),
  lang: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
})

export type SearchQuery = z.infer<typeof SearchQuerySchema>

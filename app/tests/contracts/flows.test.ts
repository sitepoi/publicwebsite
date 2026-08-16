import { describe, expect, it } from 'vitest'
import { FlowCallSchema, FlowDefinitionSchema } from '@/lib/contracts/flows'

/** The flow definition example from Section 31 — parsed EXACTLY. */
const section31Example = {
  flowId: 'checkout',
  steps: [
    {
      id: 'cart',
      dataDefinitions: [{ field: 'items', type: 'array' }],
      validationRules: [{ field: 'items', rule: 'minLength', value: 1 }],
    },
    { id: 'delivery', dataDefinitions: [{ field: 'address' }, { field: 'time' }] },
    { id: 'payment', paymentProvider: 'stripe', amountFormula: 'cart.total + delivery.fee' },
    {
      id: 'done',
      hooks: [
        { type: 'operation', operationId: 'create-order' },
        { type: 'email' },
        { type: 'operation', operationId: 'decrement-stock' },
      ],
    },
  ],
  session: 'cart', // draft state key (anon token or user session)
}

describe('FlowDefinitionSchema (Section 31)', () => {
  it('parses the Section 31 flow definition exactly', () => {
    const parsed = FlowDefinitionSchema.parse(section31Example)
    expect(parsed.flowId).toBe('checkout')
    expect(parsed.steps).toHaveLength(4)
    expect(parsed.steps[2]?.paymentProvider).toBe('stripe')
    expect(parsed.steps[2]?.amountFormula).toBe('cart.total + delivery.fee')
    expect(parsed.steps[3]?.hooks).toHaveLength(3)
    expect(parsed.session).toBe('cart')
  })

  it('requires flowId and at least one step', () => {
    expect(FlowDefinitionSchema.safeParse({}).success).toBe(false)
    expect(FlowDefinitionSchema.safeParse({ flowId: 'x' }).success).toBe(false)
    expect(FlowDefinitionSchema.safeParse({ flowId: 'x', steps: [{ id: 's1' }] }).success).toBe(
      true,
    )
  })
})

describe('FlowCallSchema (Section 31 endpoints)', () => {
  it('parses start / step / complete calls strictly', () => {
    expect(FlowCallSchema.safeParse({ action: 'start' }).success).toBe(true)
    expect(FlowCallSchema.safeParse({ action: 'step', values: { items: [] } }).success).toBe(true)
    expect(FlowCallSchema.safeParse({ action: 'complete', flowStateId: 'fs-1' }).success).toBe(true)
  })

  it('rejects unknown actions, missing step values and extra keys', () => {
    expect(FlowCallSchema.safeParse({ action: 'jump' }).success).toBe(false)
    expect(FlowCallSchema.safeParse({ action: 'step' }).success).toBe(false)
    expect(FlowCallSchema.safeParse({ action: 'start', extra: true }).success).toBe(false)
  })
})

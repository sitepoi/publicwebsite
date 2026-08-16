import { describe, expect, it } from 'vitest'
import { OperationDefinitionSchema } from '@/lib/contracts/operations'

/** The operation definition example from Section 30 — parsed EXACTLY. */
const section30Example = {
  operationId: 'create-order',
  writes: [
    {
      targetType: 'orders-uniconbaseapps',
      mode: 'create',
      from: 'payload',
      with: { customerId: 'user.id', status: 'new' },
    },
    {
      targetType: 'products-uniconbaseapps',
      mode: 'update',
      by: { id: 'payload.items[].id' },
      fields: { stock: 'decrement' },
    },
  ],
  validation: { type: 'object', required: ['items'] },
  permission: { roles: ['customer'], ownerField: 'customerId' },
  formulas: [{ out: 'total', code: 'sum(payload.items, price * qty)' }],
  hooks: [{ type: 'email' }, { type: 'contextFunction', codeId: 'notify-kitchen' }],
  transaction: true, // all writes atomic
}

describe('OperationDefinitionSchema (Section 30)', () => {
  it('parses the Section 30 operation definition exactly', () => {
    const parsed = OperationDefinitionSchema.parse(section30Example)
    expect(parsed.operationId).toBe('create-order')
    expect(parsed.writes).toHaveLength(2)
    expect(parsed.writes[0]?.mode).toBe('create')
    expect(parsed.writes[0]?.targetType).toBe('orders-uniconbaseapps')
    expect(parsed.writes[1]?.fields?.stock).toBe('decrement')
    expect(parsed.permission?.roles).toEqual(['customer'])
    expect(parsed.permission?.ownerField).toBe('customerId')
    expect(parsed.formulas?.[0]?.out).toBe('total')
    expect(parsed.hooks?.map((hook) => hook.type)).toEqual(['email', 'contextFunction'])
    expect(parsed.transaction).toBe(true)
  })

  it('requires operationId and at least one write', () => {
    expect(OperationDefinitionSchema.safeParse({}).success).toBe(false)
    expect(OperationDefinitionSchema.safeParse({ operationId: 'x' }).success).toBe(false)
    expect(
      OperationDefinitionSchema.safeParse({
        operationId: 'x',
        writes: [{ targetType: 't', mode: 'create' }],
      }).success,
    ).toBe(true)
  })
})

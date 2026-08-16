import { describe, expect, it } from 'vitest'
import { evaluateFormula } from '@/lib/render/operations'

describe('debug formulas', () => {
  it('sum with item expression', () => {
    expect(
      evaluateFormula('sum(payload.items, price * qty)', {
        payload: {
          items: [
            { price: 2, qty: 3 },
            { price: 1, qty: 4 },
          ],
        },
      }),
    ).toBe(10)
  })
  it('bare path', () => {
    expect(
      evaluateFormula('payload.items', {
        payload: { items: [{ price: 2, qty: 3 }] },
      }),
    ).toEqual([{ price: 2, qty: 3 }])
  })
  it('bare arithmetic', () => {
    expect(evaluateFormula('2 * 3', {})).toBe(6)
  })
  it('item-scoped arithmetic', () => {
    expect(evaluateFormula('price * qty', { price: 2, qty: 3 })).toBe(6)
  })
})

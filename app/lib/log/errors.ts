/**
 * Error taxonomy (Section 20) — route handlers classify failures into a
 * small category set so metrics (form error rates, upstream failures) stay
 * comparable and error.tsx boundaries can message consistently.
 */
export type ErrorCategory =
  'auth' | 'rate-limit' | 'not-found' | 'validation' | 'upstream' | 'internal'

export interface ClassifiedError {
  category: ErrorCategory
  code: string
  message: string
}

const CATEGORY_CODES: Record<ErrorCategory, readonly string[]> = {
  auth: ['auth-required', 'invalid-credentials', 'email-exists', 'invalid-code', 'forbidden'],
  'rate-limit': ['rate-limited', 'too-fast'],
  'not-found': [
    'not-found',
    'site-not-found',
    'flow-not-found',
    'operation-not-found',
    'template-not-found',
    'type-not-found',
    'product-not-found',
  ],
  validation: [
    'invalid-payload',
    'validation-failed',
    'invalid-query',
    'invalid-call',
    'invalid-auth-call',
    'invalid-flow-call',
    'invalid-cart-call',
    'invalid-email-call',
    'invalid-pay-call',
    'invalid-revalidate-call',
    'invalid-search-query',
    'invalid-operation-call',
    'weak-password',
    'invalid-signature',
    'amount-formula-failed',
  ],
  upstream: [
    'upstream',
    'auth-failed',
    'stripe-not-configured',
    'email-not-configured',
    'auth-not-configured',
  ],
  internal: ['internal', 'flow-operation-failed', 'transaction-failed', 'flow-corrupt-state'],
}

export function classifyError(code: string): ClassifiedError {
  for (const [category, codes] of Object.entries(CATEGORY_CODES)) {
    if (codes.includes(code)) {
      return { category: category as ErrorCategory, code, message: code }
    }
  }
  return { category: 'internal', code, message: code }
}

/** Sanitized public message per category — NEVER leak internals to the UI. */
export function publicErrorMessage(category: ErrorCategory): string {
  switch (category) {
    case 'auth':
      return 'Please sign in to continue.'
    case 'rate-limit':
      return 'Too many requests — try again shortly.'
    case 'not-found':
      return 'Not found.'
    case 'validation':
      return 'The request could not be processed.'
    case 'upstream':
      return 'A service is temporarily unavailable.'
    default:
      return 'Something went wrong.'
  }
}

'use client'

import { useEffect } from 'react'

/**
 * Root error boundary (Section 20) — covers /p/user and any non-website
 * route. The (website) group keeps its own error.tsx.
 */
export default function RootErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Console is client-side only; server-side structured logs happen at the
    // emit site (lib/log). Never log secrets — the error message is sanitized.
  }, [error])

  return (
    <main className="error-page" data-testid="root-error">
      <h1>Something went wrong</h1>
      <p>Please try again.</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  )
}

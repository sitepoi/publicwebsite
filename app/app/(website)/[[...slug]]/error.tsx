'use client'

/** Typed error boundary (Section 9 step 8) — no silent notFound masking. */
export default function WebsiteError({
  error,
  reset,
}: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-neutral-500">{error.message || 'An unexpected error occurred.'}</p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-4 rounded border border-neutral-400 px-4 py-2 text-sm hover:bg-neutral-100"
      >
        Try again
      </button>
    </div>
  )
}

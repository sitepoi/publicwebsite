/**
 * Section 7.3 rule 4: no content-system fallback — NEXT-GEN notFound page.
 */
export default function WebsiteNotFound() {
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">404 — Page not found</h1>
      <p className="mt-2 text-neutral-500">This page does not exist on this website.</p>
    </div>
  )
}

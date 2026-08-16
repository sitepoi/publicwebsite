/**
 * Server boot hook (Next.js instrumentation).
 *
 * Section 22: env is validated with Zod at boot — fail fast. Runs whenever the
 * Node.js server starts (and during `next build` prerendering), so invalid or
 * missing configuration never reaches a serving request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { validateEnv } = await import('./lib/config/env')
  validateEnv(process.env)
}

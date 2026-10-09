/**
 * Diagnostic warning page (D-DWH-19/26) - rendered whenever a host cannot be
 * served because its config is incomplete. Explicit domain config is the ONLY
 * way a site renders (the default-tenant fallback is removed, D-DWH-26), so
 * this page lists exactly what to fix: the sitepoi-relay registry entry, the
 * website folder's websiteConfig.hostNames, and the home-page object.
 */
export function SiteNotConfigured({
  host,
  tenantId,
  reason,
}: {
  host: string
  tenantId: string | null
  reason: string
}) {
  const registryMissing = reason === 'registry-missing'
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '48px auto',
        padding: '0 24px',
        fontFamily: 'system-ui, sans-serif',
        color: '#1f2937',
      }}
    >
      <div
        style={{
          border: '1px solid #fde68a',
          background: '#fffbeb',
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>This website is not configured yet</h1>
        <p style={{ fontSize: 14, margin: '0 0 12px' }}>
          STATUS CODE:{' '}
          <code style={{ background: '#fef3c7', padding: '2px 6px', borderRadius: 6 }}>
            SITE_NOT_CONFIGURED
          </code>{' '}
          ({reason})
        </p>
        <p style={{ fontSize: 14, margin: '0 0 8px' }}>
          The domain <strong>{host}</strong>{' '}
          {tenantId
            ? `is registered under tenant ${tenantId}, but no website is set up for it yet.`
            : 'has no registry entry, so the platform does not know which tenant serves it.'}
        </p>
        <p style={{ fontSize: 14, margin: '0 0 8px' }}>What to fix (in order):</p>
        <ol style={{ fontSize: 14, margin: '0 0 12px', paddingLeft: 20 }}>
          {registryMissing && (
            <li>
              Add the hostname to the <code>sitepoi-relay</code> <code>applications</code> registry
              (CMS-side) so <strong>{host}</strong> maps to a tenant.
            </li>
          )}
          <li>
            A website folder in <code>om_object_types</code> of the tenant whose{' '}
            <code>data.websiteConfig.hostNames</code> contains <strong>{host}</strong> (D-DWH-25 - the
            folder itself maps the domain to the website).
          </li>
          <li>
            A <code>home-page</code> object with the page content (
            <code>htmlPage.code.html</code> or the CMS{' '}
            <code>webpageContentWithBuilder.code.html</code>).
          </li>
        </ol>
        <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
          Owners: check{' '}
          <code>GET /api/onboarding/self-check?hostname={host}</code> (secret-guarded) for the
          exact layer status. This page is not indexed by search engines.
        </p>
      </div>
    </main>
  )
}

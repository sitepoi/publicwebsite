/**
 * Diagnostic warning page (D-DWH-19) - rendered when a hostname HAS a
 * registry entry (L2 pass) but no website is configured for it yet (L4/L5
 * fail). Shows a status code the owner can understand instead of a bare 404.
 * Unregistered hosts keep the true 404 (F-02 unchanged).
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
          The domain <strong>{host}</strong> is registered
          {tenantId ? ` under tenant ${tenantId}` : ''} - but no website is set up for it yet,
          so there is nothing to show here.
        </p>
        <p style={{ fontSize: 14, margin: '0 0 8px' }}>What is missing (in order):</p>
        <ol style={{ fontSize: 14, margin: '0 0 12px', paddingLeft: 20 }}>
          <li>
            A website folder in <code>om_object_types</code> of the tenant.
          </li>
          <li>
            A <code>default-settings</code> object whose <code>data.hostNames</code> contains{' '}
            <strong>{host}</strong> (this maps the domain to the folder).
          </li>
          <li>
            A <code>home-page</code> object with the page content (
            <code>data.htmlPage.code.html</code>).
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

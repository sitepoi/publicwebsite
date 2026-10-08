'use client'

import { useState, type FormEvent } from 'react'

interface TenantCreateResponse {
  success?: boolean
  error?: string
  existing?: string[]
  detail?: string
  issues?: string[]
  tenantId?: string
  folderId?: string
  hostNames?: string[]
  envVarNames?: string[]
  verification?: Array<{ id: string; name: string; pass: boolean; detail: string }>
  purge?: { ok: boolean; detail: string }
}

interface Verification {
  id: string
  name: string
  pass: boolean
  detail: string
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginTop: 10,
  fontWeight: 600,
  fontSize: 14,
}
const inputStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 420,
  padding: '8px 10px',
  marginTop: 4,
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  fontSize: 14,
}

export function TenantRegisterForm() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>('')
  const [errorIssues, setErrorIssues] = useState<string[]>([])
  const [envVarNames, setEnvVarNames] = useState<string[]>([])
  const [verification, setVerification] = useState<Verification[]>([])
  const [purge, setPurge] = useState<{ ok: boolean; detail: string } | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    setErrorIssues([])
    setEnvVarNames([])
    setVerification([])
    setPurge(null)
    try {
      const form = new FormData(event.currentTarget)
      const payload: Record<string, unknown> = {
        tenantId: String(form.get('tenantId') ?? '').trim(),
        adminEmail: String(form.get('adminEmail') ?? '').trim(),
        adminPassword: String(form.get('adminPassword') ?? ''),
        hostNames: String(form.get('hostNames') ?? '')
          .split(',')
          .map((host) => host.trim())
          .filter((host) => host.length > 0),
        primaryHost: String(form.get('primaryHost') ?? '').trim() || undefined,
        defaultLanguage: String(form.get('defaultLanguage') ?? '').trim() || undefined,
        currency: String(form.get('currency') ?? '').trim().toUpperCase() || undefined,
        previewSecret: String(form.get('previewSecret') ?? '').trim() || undefined,
        appIds:
          String(form.get('appIds') ?? '')
            .split(',')
            .map((appId) => appId.trim())
            .filter((appId) => appId.length > 0) || undefined,
        gw_hp: String(form.get('gw_hp') ?? ''),
      }
      const response = await fetch('/api/tenant/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = (await response.json().catch(() => null)) as TenantCreateResponse | null
      if (!data) {
        setMessage('Unexpected response from the server.')
        return
      }
      if (data.success) {
        setMessage(
          `Tenant ${data.tenantId} created (folder ${data.folderId}). Domains: ${(data.hostNames ?? []).join(', ')}`,
        )
        setEnvVarNames(data.envVarNames ?? [])
        setVerification(data.verification ?? [])
        setPurge(data.purge ?? null)
      } else if (data.error === 'already-exists') {
        setMessage(
          `This tenant already exists (${(data.existing ?? []).join(', ')}) - nothing was overwritten.`,
        )
      } else if (data.error === 'invalid-tenant-request') {
        setErrorIssues(data.issues ?? ['Invalid input.'])
      } else {
        setMessage(data.detail ?? data.error ?? 'Tenant creation failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 24 }}>Create your website</h1>
      <form onSubmit={handleSubmit} aria-label="tenant registration form">
        <label style={labelStyle}>Company ID (4-20 lowercase letters/numbers)</label>
        <input name="tenantId" required minLength={4} maxLength={20} style={inputStyle} />
        <label style={labelStyle}>Admin email</label>
        <input name="adminEmail" type="email" required style={inputStyle} />
        <label style={labelStyle}>Admin password (min 8 characters)</label>
        <input name="adminPassword" type="password" required minLength={8} style={inputStyle} />
        <label style={labelStyle}>Domains (comma separated, e.g. acme.com, www.acme.com)</label>
        <input name="hostNames" required placeholder="acme.com, www.acme.com" style={inputStyle} />
        <label style={labelStyle}>Primary domain (optional - defaults to the first domain)</label>
        <input name="primaryHost" placeholder="www.acme.com" style={inputStyle} />
        <label style={labelStyle}>Language (optional, default en)</label>
        <input name="defaultLanguage" placeholder="en" style={inputStyle} />
        <label style={labelStyle}>Currency (optional, 3 letters)</label>
        <input name="currency" placeholder="USD" maxLength={3} style={inputStyle} />
        <label style={labelStyle}>Preview secret (optional - enables ?gw-preview=)</label>
        <input name="previewSecret" style={inputStyle} />
        <label style={labelStyle}>App ids (optional, comma separated)</label>
        <input name="appIds" placeholder="website-builder-uniconbaseapps" style={inputStyle} />
        <input
          name="gw_hp"
          style={{ position: 'absolute', left: -9999 }}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            marginTop: 16,
            padding: '10px 20px',
            borderRadius: 8,
            border: 'none',
            background: '#1d4ed8',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy ? 'Creating…' : 'Create website'}
        </button>
      </form>

      {message && <p style={{ marginTop: 16, fontWeight: 600 }}>{message}</p>}
      {errorIssues.length > 0 && (
        <ul style={{ color: '#b91c1c', marginTop: 8 }}>
          {errorIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {envVarNames.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 18 }}>3. Deployment environment variables (add + redeploy)</h2>
          <p style={{ fontSize: 14 }}>
            Add these to the deployment env before the domain can render (D-DWH-05):
          </p>
          <ul style={{ fontFamily: 'Consolas, monospace', fontSize: 13 }}>
            {envVarNames.map((envVarName) => (
              <li key={envVarName}>{envVarName}</li>
            ))}
          </ul>
        </div>
      )}
      {purge && (
        <p style={{ fontSize: 14, marginTop: 12 }}>
          Cache purge: {purge.ok ? 'OK' : 'failed'} - {purge.detail}
        </p>
      )}
      {verification.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 18 }}>Verification gate (section 6.10)</h2>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, marginTop: 8 }}>
            <tbody>
              {verification.map((check) => (
                <tr key={check.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', fontWeight: 600 }}>
                    {check.pass ? '✅' : '❌'} {check.id}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <div>{check.name}</div>
                    <div style={{ color: '#6b7280' }}>{check.detail}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 8 }}>
            Live checks (V-02..V-06) pass after DNS + deployment: open your domain and
            /sitemap.xml - both must return 200 before announcing the site (D-DWH-07).
          </p>
        </div>
      )}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { FormEvent, useState } from 'react'

/**
 * First-party auth pages (Section 17): /p/user/{login,register,
 * forgot-password,reset,verify}. Plain forms posting to /api/auth/session —
 * NO localStorage password storage, passwords only travel in the in-flight
 * request body.
 */
const ACTIONS = ['login', 'register', 'forgot-password', 'reset', 'verify'] as const
type AuthAction = (typeof ACTIONS)[number]

const TITLES: Record<AuthAction, string> = {
  login: 'Sign in',
  register: 'Create account',
  'forgot-password': 'Reset password',
  reset: 'Set new password',
  verify: 'Verify email',
}

function safeReturnUrl(raw: string | null): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null
  return raw
}

export default function UserAuthPage() {
  const params = useParams<{ action: string }>()
  const searchParams = useSearchParams()
  const action = ACTIONS.includes(params.action as AuthAction)
    ? (params.action as AuthAction)
    : null

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const returnUrl = safeReturnUrl(searchParams.get('returnUrl'))
  const oobCode = searchParams.get('oobCode') ?? ''

  if (!action) {
    return <main className="auth-page">Unknown auth page.</main>
  }
  const currentAction = action

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const body: Record<string, unknown> = { action: mapAction(currentAction) }
      if (currentAction === 'login' || currentAction === 'register') {
        body['email'] = email
        body['password'] = password
      }
      if (currentAction === 'register') body['name'] = name
      if (currentAction === 'forgot-password') body['email'] = email
      if (currentAction === 'reset') {
        body['oobCode'] = oobCode
        body['password'] = password
      }
      if (currentAction === 'verify') body['oobCode'] = oobCode

      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean
        error?: string
      } | null

      if (response.ok && data?.ok) {
        if (currentAction === 'login' || currentAction === 'register') {
          window.location.href = returnUrl ?? '/'
          return
        }
        setMessage(
          currentAction === 'forgot-password'
            ? 'If the address exists, a reset link has been sent.'
            : 'Done — you can sign in now.',
        )
        return
      }
      setError(messageFor(currentAction, data?.error ?? 'auth-failed'))
    } catch {
      setError('Network error — please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <h1>{TITLES[currentAction]}</h1>
      <form onSubmit={onSubmit} data-testid={`auth-${currentAction}`}>
        {(currentAction === 'login' ||
          currentAction === 'register' ||
          currentAction === 'forgot-password') && (
          <label>
            Email
            <input
              type="email"
              name="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        )}
        {currentAction === 'register' && (
          <label>
            Name
            <input name="name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        )}
        {(currentAction === 'login' ||
          currentAction === 'register' ||
          currentAction === 'reset') && (
          <label>
            Password
            <input
              type="password"
              name="password"
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={currentAction === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : TITLES[currentAction]}
        </button>
      </form>
      {message && <p data-testid="auth-message">{message}</p>}
      {error && <p data-testid="auth-error">{error}</p>}
      <nav>
        {currentAction !== 'login' && (
          <Link
            href={`/p/user/login${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''}`}
          >
            Sign in
          </Link>
        )}
        {currentAction === 'login' && <Link href="/p/user/register">Create account</Link>}
        {currentAction === 'login' && <Link href="/p/user/forgot-password">Forgot password?</Link>}
      </nav>
    </main>
  )
}

function mapAction(action: AuthAction): string {
  return action === 'forgot-password' ? 'forgot' : action
}

function messageFor(action: AuthAction, error: string): string {
  if (error === 'invalid-credentials') return 'Invalid email or password.'
  if (error === 'email-exists') return 'An account with this email already exists.'
  if (error === 'weak-password') return 'Password is too weak (minimum 6 characters).'
  if (error === 'invalid-code') return 'This link is invalid or expired.'
  if (error === 'rate-limited') return 'Too many attempts — try again later.'
  if (error === 'auth-not-configured') return 'Authentication is not configured on this site.'
  return `Request failed (${error}).`
}

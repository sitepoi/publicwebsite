import { describe, expect, it } from 'vitest'
import { createLogger, logRequest, newRequestId } from '@/lib/log/logger'
import { classifyError, publicErrorMessage } from '@/lib/log/errors'

function captureLogger() {
  const lines: string[] = []
  const logger = createLogger({
    level: 'info',
    destination: {
      write(message: string) {
        lines.push(message)
      },
    },
  })
  return { logger, lines: () => lines.map((line) => JSON.parse(line)) }
}

describe('pino structured logs (Section 20)', () => {
  it('emits JSON lines with request id, host, site, page and latency', async () => {
    const { logger, lines } = captureLogger()
    logRequest(logger, {
      requestId: 'req-1',
      method: 'GET',
      path: '/about',
      host: 'site-a.test',
      status: 200,
      site: 'site-a',
      page: 'about',
      latencyMs: 12,
    })
    // pino may buffer briefly — flush by waiting a microtask.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const parsed = lines()
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      requestId: 'req-1',
      method: 'GET',
      path: '/about',
      host: 'site-a.test',
      status: 200,
      site: 'site-a',
      page: 'about',
      latencyMs: 12,
    })
  })

  it('REDACTS secrets before they reach the destination (hard rule)', async () => {
    const { logger, lines } = captureLogger()
    logger.info({
      password: 'topsecret',
      nested: { password: 'hunter2', privateKey: 'BEGIN KEY' },
      authorization: 'Bearer abc',
      cookie: 'gw-session=xyz',
      safe: 'keep-me',
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const line = JSON.stringify(lines()[0])
    expect(line).not.toContain('topsecret')
    expect(line).not.toContain('hunter2')
    expect(line).not.toContain('BEGIN KEY')
    expect(line).not.toContain('Bearer abc')
    expect(line).not.toContain('gw-session=xyz')
    expect(line).toContain('[redacted]')
    expect(line).toContain('keep-me')
  })

  it('generates unique request ids', () => {
    expect(newRequestId()).not.toBe(newRequestId())
  })
})

describe('error taxonomy (Section 20)', () => {
  it('classifies known codes into categories', () => {
    expect(classifyError('invalid-credentials').category).toBe('auth')
    expect(classifyError('rate-limited').category).toBe('rate-limit')
    expect(classifyError('template-not-found').category).toBe('not-found')
    expect(classifyError('validation-failed').category).toBe('validation')
    expect(classifyError('stripe-not-configured').category).toBe('upstream')
    expect(classifyError('unknown-boom').category).toBe('internal')
  })

  it('produces sanitized public messages per category', () => {
    expect(publicErrorMessage('auth')).toContain('sign in')
    expect(publicErrorMessage('rate-limit')).toContain('Too many')
    expect(publicErrorMessage('internal')).toContain('went wrong')
  })
})

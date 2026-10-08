import { describe, expect, it } from 'vitest'
import { normalizePrivateKey } from '@/lib/firestore/admin-app'

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC9vEw\n-----END PRIVATE KEY-----\n'
/** normalizePrivateKey trims outer whitespace, including the trailing newline (harmless for PEM). */
const EXPECTED = PEM.trimEnd()

describe('normalizePrivateKey (deployment env PEM repair)', () => {
  it('returns a clean multiline PEM unchanged', () => {
    expect(normalizePrivateKey(PEM)).toBe(EXPECTED)
  })

  it('converts literal \\n escapes into real newlines', () => {
    const escaped = PEM.replace(/\n/g, '\\n')
    expect(escaped).not.toContain('\n')
    expect(normalizePrivateKey(escaped)).toBe(EXPECTED)
  })

  it('strips surrounding double quotes', () => {
    expect(normalizePrivateKey(`"${PEM}"`)).toBe(EXPECTED)
  })

  it('strips surrounding single quotes', () => {
    expect(normalizePrivateKey(`'${PEM}'`)).toBe(EXPECTED)
  })

  it('strips quotes and fixes escapes in one pass', () => {
    const quotedEscaped = `"${PEM.replace(/\n/g, '\\n')}"`
    expect(normalizePrivateKey(quotedEscaped)).toBe(EXPECTED)
  })

  it('converts CRLF line endings to LF', () => {
    expect(normalizePrivateKey(PEM.replace(/\n/g, '\r\n'))).toBe(EXPECTED)
  })

  it('trims surrounding whitespace', () => {
    expect(normalizePrivateKey(`  ${PEM}\n  `)).toBe(EXPECTED)
  })
})

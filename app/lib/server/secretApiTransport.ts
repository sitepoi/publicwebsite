/**
 * Secret API transport (server-only).
 *
 * WHY THIS EXISTS: the Secret API rejects requests that carry
 * `sec-fetch-mode: cors` (confirmed by the CMS enrollment path: 403). Node's
 * global fetch (undici) adds that header automatically, so runtime-secret
 * calls MUST NOT use global fetch. This transport uses node:https /
 * node:http directly — no fetch, no sec-fetch-* headers, no redirects.
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface SecretApiTransportRequest {
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

export interface SecretApiTransportResponse {
  status: number
  body: string
}

export type SecretApiTransport = (
  request: SecretApiTransportRequest,
) => Promise<SecretApiTransportResponse>

export const SECRET_API_MAX_BODY_BYTES = 256 * 1024

/** Node http/https transport — adds NO sec-fetch-mode and follows NO redirects. */
export function createNodeHttpTransport(): SecretApiTransport {
  return ({ url, headers, timeoutMs }) =>
    new Promise((resolve, reject) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        reject(new Error('secret-api-invalid-url'))
        return
      }

      const requestFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
      const request = requestFn(
        parsed,
        { method: 'GET', headers, timeout: timeoutMs },
        (response) => {
          const chunks: Buffer[] = []
          let received = 0
          response.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received <= SECRET_API_MAX_BODY_BYTES) chunks.push(chunk)
            else response.destroy(new Error('secret-api-response-too-large'))
          })
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
          response.on('error', reject)
        },
      )
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('secret-api-timeout'))
      })
      request.on('error', reject)
      request.end()
    })
}

/** Shared default for the production credential resolver. */
export const defaultSecretApiTransport: SecretApiTransport = createNodeHttpTransport()

import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createNodeHttpTransport } from '@/lib/server/secretApiTransport'

describe('Secret API transport (global fetch is forbidden)', () => {
  it('sends NO sec-fetch-mode header and returns status + body', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {}
    const server = createServer((request, response) => {
      receivedHeaders = request.headers
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, tenantId: 'tenant-a' }))
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('test server has no port')
    }

    try {
      const transport = createNodeHttpTransport()
      const result = await transport({
        url: `http://127.0.0.1:${address.port}/api/v1/first-party/runtime-secret?tenantId=tenant-a&appId=publicwebsite`,
        headers: { authorization: 'Bearer server-only-bearer-token', accept: 'application/json' },
        timeoutMs: 2_000,
      })

      expect(result.status).toBe(200)
      expect(JSON.parse(result.body)).toEqual({ ok: true, tenantId: 'tenant-a' })
      // The reported Secret API 403 root cause: undici/fetch adds this header.
      expect(receivedHeaders['sec-fetch-mode']).toBeUndefined()
      expect(receivedHeaders['authorization']).toBe('Bearer server-only-bearer-token')
      expect(receivedHeaders['accept']).toBe('application/json')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('rejects when the Secret API does not answer within the timeout', async () => {
    const server = createServer(() => {
      /* never responds */
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('test server has no port')
    }

    try {
      const transport = createNodeHttpTransport()
      await expect(
        transport({
          url: `http://127.0.0.1:${address.port}/api/v1/first-party/runtime-secret`,
          headers: { authorization: 'Bearer x' },
          timeoutMs: 100,
        }),
      ).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

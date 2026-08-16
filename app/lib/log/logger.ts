import { randomUUID } from 'node:crypto'
import pino, { type Logger } from 'pino'

/**
 * Structured JSON logging (Section 20) — pino with a hard redaction list.
 * HARD RULE: no secrets in logs — headers/fields matching these paths are
 * censored before they reach the destination.
 */
export const SECRET_REDACT_PATHS = [
  'password',
  '*.password',
  'cookie',
  '*.cookie',
  'authorization',
  '*.authorization',
  'x-revalidate-secret',
  '*.secret',
  '*.privateKey',
  '*.private_key',
  '*.accessKey',
  '*.access_key',
  '*.clientSecret',
  '*.credentials',
]

export interface LoggerOptions {
  level?: string
  destination?: { write(message: string): void }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? 'info',
      redact: { paths: SECRET_REDACT_PATHS, censor: '[redacted]' },
      base: { pid: process.pid },
    },
    options.destination,
  )
}

let cached: Logger | null = null

export function getLogger(): Logger {
  if (!cached) cached = createLogger()
  return cached
}

export function newRequestId(): string {
  return randomUUID()
}

export interface RequestLogContext {
  requestId: string
  method: string
  path: string
  host: string
  status?: number
  site?: string
  page?: string
  latencyMs?: number
}

/** One structured line per request: request id, host, site, page, latency. */
export function logRequest(logger: Logger, context: RequestLogContext): void {
  logger.info({
    requestId: context.requestId,
    method: context.method,
    path: context.path,
    host: context.host,
    ...(context.status !== undefined ? { status: context.status } : {}),
    ...(context.site !== undefined ? { site: context.site } : {}),
    ...(context.page !== undefined ? { page: context.page } : {}),
    ...(context.latencyMs !== undefined ? { latencyMs: context.latencyMs } : {}),
    msg: 'request',
  })
}

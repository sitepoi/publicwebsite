import { createHash } from 'node:crypto'
import vm from 'node:vm'
import type { DataProvider, DataTransaction } from '@/lib/data/provider'
import type { SiteConfig } from '@/lib/resolver/site'
import {
  OperationDefinitionSchema,
  type OperationDefinition,
  type OperationHook,
  type OperationWrite,
} from '@/lib/contracts/operations'
import { getObjectData } from './normalize'
import { emitSiteEvent } from '@/lib/events'

/**
 * Operations engine (Section 30) — the ENTIRE "set" side. Vertical tools only
 * send payloads; the platform enforces the CMS-defined contract:
 *
 *   payload validation (JSON-schema subset) → permission rule (roles +
 *   ownerField) → formulas (SAFE expression subset) → multi-doc writes
 *   (transaction: true = provider.runTransaction, all-or-nothing) →
 *   hooks (email / contextFunction).
 *
 * Context functions run in a sandboxed, reviewed subset (node:vm) with ONLY
 * Math/Date/JSON available (ADR-007). Idempotency: Idempotency-Key header or
 * payload key → the result is stored and replays are returned unchanged
 * (Section 33). All storage through the DataProvider interface (Section 6B).
 */

export const OPERATION_RESULTS_TYPE = 'operation-results'

export interface OperationActor {
  id?: string
  roles: string[]
}

export interface OperationHookRunner {
  runEmailHook?: (hook: OperationHook, context: Record<string, unknown>) => Promise<void>
  runContextHook?: (codeId: string, context: Record<string, unknown>) => Promise<unknown>
}

export interface ExecuteOperationInput {
  provider: DataProvider
  site: SiteConfig
  operationId: string
  payload: Record<string, unknown>
  actor: OperationActor
  idempotencyKey?: string
  hooks?: OperationHookRunner
}

export interface OperationIssue {
  field: string
  message: string
}

export type OperationResult =
  | { ok: true; result: unknown; idempotent?: boolean }
  | { ok: false; error: string; status: number; errors?: OperationIssue[] }

// ------------------------------------------------------------------ loading

export async function loadOperationDefinition(
  provider: DataProvider,
  site: SiteConfig,
  operationId: string,
): Promise<OperationDefinition | null> {
  const result = await provider.queryObjects({
    cmsObjectType: site.appId,
    filters: [{ field: 'data.operationId', op: '==', value: operationId }],
    pageSize: 200,
  })
  for (const record of result.items) {
    const data = getObjectData(record)
    if (!data) continue
    const parsed = OperationDefinitionSchema.safeParse(data)
    if (parsed.success && parsed.data.operationId === operationId) return parsed.data
  }
  return null
}

// ------------------------------------------------------------ JSON schema
// Supported subset: { required: string[], properties: { field: { type } } }
export function validatePayload(
  payload: Record<string, unknown>,
  schema: unknown,
): OperationIssue[] {
  if (schema === null || typeof schema !== 'object') return []
  const issues: OperationIssue[] = []
  const s = schema as { required?: unknown; properties?: unknown }

  if (Array.isArray(s.required)) {
    for (const entry of s.required) {
      const field = typeof entry === 'string' ? entry : ''
      if (field && !(field in payload)) {
        issues.push({ field, message: 'Required field missing' })
      }
    }
  }

  if (s.properties !== null && typeof s.properties === 'object') {
    const properties = s.properties as Record<string, { type?: unknown }>
    for (const [field, rule] of Object.entries(properties)) {
      if (rule === null || typeof rule !== 'object') continue
      const value = payload[field]
      if (value === undefined) continue
      const type = rule.type
      if (type === 'string' && typeof value !== 'string')
        issues.push({ field, message: 'Expected string' })
      if (type === 'number' && typeof value !== 'number')
        issues.push({ field, message: 'Expected number' })
      if (type === 'boolean' && typeof value !== 'boolean')
        issues.push({ field, message: 'Expected boolean' })
      if (type === 'array' && !Array.isArray(value))
        issues.push({ field, message: 'Expected array' })
    }
  }

  return issues
}

// ---------------------------------------------------------- path utilities

export function pathGet(root: unknown, path: string): unknown {
  const tokens = path.match(/[^.[\]]+/g) ?? []
  let current: unknown = root
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[token]
  }
  return current
}

export function resolveTemplate(
  value: unknown,
  actor: OperationActor,
  payload: Record<string, unknown>,
): unknown {
  if (typeof value !== 'string') return value
  if (value.startsWith('user.')) {
    const field = value.slice('user.'.length)
    if (field === 'id') return actor.id ?? null
    return null
  }
  if (value.startsWith('payload.')) {
    return pathGet(payload, value.slice('payload.'.length))
  }
  return value
}

// ------------------------------------------------------------- formulas
// SAFE subset: numbers, strings, parens, + - * / %, property paths, and the
// whitelisted functions sum/count/avg/min/max/round/floor/ceil/abs/str.
type FormulaToken =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }

function tokenizeFormula(source: string): FormulaToken[] {
  const tokens: FormulaToken[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (char === '(') {
      tokens.push({ type: 'lparen' })
      index++
      continue
    }
    if (char === ')') {
      tokens.push({ type: 'rparen' })
      index++
      continue
    }
    if (char === ',') {
      tokens.push({ type: 'comma' })
      index++
      continue
    }
    if ('+-*/%'.includes(char)) {
      tokens.push({ type: 'op', value: char })
      index++
      continue
    }
    const number = source.slice(index).match(/^\d+(\.\d+)?/)
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) })
      index += number[0].length
      continue
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1)
      const value = end === -1 ? source.slice(index + 1) : source.slice(index + 1, end)
      tokens.push({ type: 'string', value })
      index = end === -1 ? source.length : end + 1
      continue
    }
    const ident = source.slice(index).match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*/)
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0] })
      index += ident[0].length
      continue
    }
    throw new Error(`Unexpected character in formula: '${char}'`)
  }
  return tokens
}

const FORMULA_FUNCTIONS = new Set([
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'round',
  'floor',
  'ceil',
  'abs',
  'str',
])
const LIST_FUNCTIONS = new Set(['sum', 'avg', 'min', 'max'])

class FormulaEvaluator {
  private position = 0

  constructor(
    private readonly tokens: FormulaToken[],
    private readonly scopes: Array<Record<string, unknown>>,
  ) {}

  evaluate(): unknown {
    return this.parseExpression()
  }

  private parseExpression(): unknown {
    let value = this.parseTerm()
    while (this.peekOp() === '+' || this.peekOp() === '-') {
      const op = this.consumeOp()
      const right = this.parseTerm()
      if (op === '+') value = numeric(value) + numeric(right)
      else value = numeric(value) - numeric(right)
    }
    return value
  }

  private parseTerm(): unknown {
    let value = this.parseFactor()
    while (this.peekOp() === '*' || this.peekOp() === '/' || this.peekOp() === '%') {
      const op = this.consumeOp()
      const right = this.parseFactor()
      if (op === '*') value = numeric(value) * numeric(right)
      else if (op === '/') value = numeric(value) / numeric(right)
      else value = numeric(value) % numeric(right)
    }
    return value
  }

  private consumeOp(): string {
    const token = this.consume()
    if (token.type !== 'op') throw new Error('Expected operator in formula')
    return token.value
  }

  private parseFactor(): unknown {
    const token = this.peek()
    if (!token) throw new Error('Unexpected end of formula')
    if (token.type === 'number') {
      this.position++
      return token.value
    }
    if (token.type === 'string') {
      this.position++
      return token.value
    }
    if (token.type === 'op' && token.value === '-') {
      this.position++
      return -numeric(this.parseFactor())
    }
    if (token.type === 'lparen') {
      this.position++
      const value = this.parseExpression()
      if (this.peek()?.type !== 'rparen') throw new Error("Missing ')' in formula")
      this.position++
      return value
    }
    if (token.type === 'ident') {
      this.position++
      const ident = token.value
      if (this.peek()?.type === 'lparen') {
        this.position++ // (
        const args: unknown[] = []
        const ranges: Array<{ start: number; end: number } | null> = []
        let argIndex = 0
        while (this.peek() && this.peek()!.type !== 'rparen') {
          if (LIST_FUNCTIONS.has(ident) && argIndex === 1) {
            // List-function item expressions are NOT evaluated eagerly — they
            // reference per-item fields. Consume the token range and evaluate
            // lazily per item in overList().
            ranges.push(this.consumeArgumentTokens())
            args.push(undefined)
          } else {
            const value = this.parseExpression()
            ranges.push(null)
            args.push(value)
          }
          if (this.peek()?.type === 'comma') this.position++
          argIndex++
        }
        if (this.peek()?.type !== 'rparen') throw new Error("Missing ')' in formula")
        this.position++
        return this.applyFunction(ident, args, ranges)
      }
      return this.resolvePath(ident)
    }
    throw new Error('Unexpected token in formula')
  }

  private resolvePath(path: string): unknown {
    const segments = path.match(/[^.[\]]+/g) ?? []
    for (const scope of [...this.scopes].reverse()) {
      let current: unknown = scope
      let matched = true
      for (const segment of segments) {
        if (current === null || typeof current !== 'object') {
          matched = false
          break
        }
        const next = (current as Record<string, unknown>)[segment]
        if (next === undefined) {
          matched = false
          break
        }
        current = next
      }
      if (matched && current !== scope) return current
    }
    return undefined
  }

  /**
   * Consume a balanced expression without evaluating it. Used to capture the
   * token range of list-function item expressions for lazy evaluation.
   */
  private consumeArgumentTokens(): { start: number; end: number } {
    const start = this.position
    let depth = 0
    while (this.peek()) {
      const token = this.peek()!
      if (token.type === 'lparen') depth++
      else if (token.type === 'rparen') {
        if (depth === 0) break
        depth--
      } else if (token.type === 'comma' && depth === 0) break
      this.position++
    }
    return { start, end: this.position }
  }

  private applyFunction(
    name: string,
    args: unknown[],
    ranges: Array<{ start: number; end: number } | null>,
  ): unknown {
    if (!FORMULA_FUNCTIONS.has(name)) throw new Error(`Unknown formula function '${name}'`)

    const listArg = args[0]
    const list = Array.isArray(listArg) ? listArg : null
    const exprRange = ranges[1] ?? null

    switch (name) {
      case 'sum':
        return this.overList(list, exprRange, (values) => values.reduce((a, b) => a + b, 0), 0)
      case 'count':
        return list ? list.length : 0
      case 'avg':
        return this.overList(
          list,
          exprRange,
          (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0),
          0,
        )
      case 'min':
        return this.overList(
          list,
          exprRange,
          (values) => (values.length ? Math.min(...values) : null),
          null,
        )
      case 'max':
        return this.overList(
          list,
          exprRange,
          (values) => (values.length ? Math.max(...values) : null),
          null,
        )
      case 'round':
        return Math.round(numeric(listArg))
      case 'floor':
        return Math.floor(numeric(listArg))
      case 'ceil':
        return Math.ceil(numeric(listArg))
      case 'abs':
        return Math.abs(numeric(listArg))
      case 'str':
        return String(listArg ?? '')
    }
  }

  /** Evaluate `exprRange` per list item with an `item` scope. */
  private overList(
    list: unknown[] | null,
    exprRange: { start: number; end: number } | null,
    combine: (values: number[]) => unknown,
    fallback: unknown,
  ): unknown {
    if (!list) return fallback
    const values = list.map((item) => {
      if (!exprRange) return numeric(item)
      const subTokens = this.tokens.slice(exprRange.start, exprRange.end)
      // The item itself becomes a scope so `price * qty` resolves.
      const itemScope =
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : { item }
      const evaluator = new FormulaEvaluator(subTokens, [...this.scopes, itemScope])
      return numeric(evaluator.evaluate())
    })
    return combine(values)
  }

  private peek(): FormulaToken | undefined {
    return this.tokens[this.position]
  }

  private peekOp(): string | undefined {
    const token = this.peek()
    return token?.type === 'op' ? token.value : undefined
  }

  private consume(): FormulaToken {
    const token = this.tokens[this.position]
    if (!token) throw new Error('Unexpected end of formula')
    this.position++
    return token
  }
}

function numeric(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(number)) throw new Error(`Formula expected a number, got '${String(value)}'`)
  return number
}

export function evaluateFormula(source: string, context: Record<string, unknown>): unknown {
  const evaluator = new FormulaEvaluator(tokenizeFormula(source), [context])
  return evaluator.evaluate()
}

// ------------------------------------------------------ context functions
// Sandboxed, reviewed subset (Section 30): Math + Date + JSON ONLY (ADR-007).
export function runContextFunction(code: string, context: Record<string, unknown>): unknown {
  const sandbox = {
    Math,
    Date,
    JSON,
    payload: context['payload'] ?? {},
    result: context['result'] ?? {},
    user: context['user'] ?? null,
  }
  const script = `(function(){ ${code}\n})()`
  return vm.runInNewContext(script, sandbox, { timeout: 500 })
}

// ------------------------------------------------------------------ writes

export interface WriteAdapter {
  get(collection: string, id: string): Promise<Record<string, unknown> | null>
  set(
    collection: string,
    id: string | undefined,
    data: Record<string, unknown>,
  ): Promise<{ id: string }>
  update(collection: string, id: string, data: Record<string, unknown>): Promise<void>
  delete(collection: string, id: string): Promise<void>
}

export function collectionOf(targetType: string, tableExtension: string | undefined): string {
  const extension = tableExtension ?? ''
  return targetType.endsWith(extension) && extension.length > 0
    ? targetType
    : `${targetType}${extension}`
}

/** by: { id: 'payload.items[].id' } → concrete ids via the []-mapping. */
export function resolveWriteTargets(
  by: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): string[] {
  if (!by) return []
  const raw = by['id']
  if (typeof raw !== 'string') return []
  const arrayPath = raw.match(/^(.*)\[\]\.(.+)$/)
  if (arrayPath) {
    // 'payload.x[].y' — the payload. prefix refers to the payload root.
    const listPath = (arrayPath[1] ?? '').replace(/^payload\./, '')
    const list = pathGet(payload, listPath)
    if (!Array.isArray(list)) return []
    return list
      .map((item) => pathGet(item, arrayPath[2] ?? ''))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  }
  // Literal template: 'payload.someId' resolves against the payload root.
  if (raw.startsWith('payload.')) {
    const value = pathGet(payload, raw.slice('payload.'.length))
    if (typeof value !== 'string' || value.length === 0) return []
    return [value]
  }
  return [raw]
}

async function performWrites(
  adapter: WriteAdapter,
  definition: OperationDefinition,
  payload: Record<string, unknown>,
  actor: OperationActor,
  extension: string | undefined,
): Promise<{ created: string[]; updated: number; deleted: number }> {
  const created: string[] = []
  let updated = 0
  let deleted = 0

  for (const write of definition.writes) {
    const collection = collectionOf(write.targetType, extension)

    if (write.mode === 'create') {
      const data: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(write.with ?? {}))
        data[key] = resolveTemplate(value, actor, payload)
      const record = await adapter.set(collection, undefined, data)
      created.push(record.id)
      continue
    }

    const targets = resolveWriteTargets(write.by, payload)
    for (const id of targets) {
      if (write.mode === 'delete') {
        await adapter.delete(collection, id)
        deleted++
        continue
      }
      if (write.mode === 'update') {
        const current = await adapter.get(collection, id)
        if (!current) throw new Error(`Operation write target not found: ${write.targetType}/${id}`)
        const fields: Record<string, unknown> = {}
        for (const [key, spec] of Object.entries(write.fields ?? {})) {
          if (spec === 'decrement') fields[key] = Math.max(0, numeric(current[key]) - 1)
          else if (spec === 'increment') fields[key] = numeric(current[key]) + 1
          else fields[key] = spec
        }
        await adapter.update(collection, id, fields)
        updated++
      }
    }
  }

  return { created, updated, deleted }
}

// ------------------------------------------------------------------- execute

export async function executeOperation(input: ExecuteOperationInput): Promise<OperationResult> {
  const { provider, site } = input

  // Idempotency (Section 33): replay an existing result.
  if (input.idempotencyKey) {
    const digest = createHash('sha256').update(input.idempotencyKey).digest('hex')
    const previous = await provider.getObject({
      type: OPERATION_RESULTS_TYPE,
      id: `idem-${digest}`,
    })
    if (previous) {
      return { ok: true, result: previous['result'], idempotent: true }
    }
  }

  const definition = await loadOperationDefinition(provider, site, input.operationId)
  if (!definition) return { ok: false, error: 'operation-not-found', status: 404 }

  // Validation (Zod-schema subset).
  const issues = validatePayload(input.payload, definition.validation)
  if (issues.length > 0)
    return { ok: false, error: 'validation-failed', status: 400, errors: issues }

  // Permission rule (Section 32): roles + ownerField.
  const requiredRoles = definition.permission?.roles ?? []
  if (requiredRoles.length > 0 && !requiredRoles.some((role) => input.actor.roles.includes(role))) {
    return { ok: false, error: 'forbidden', status: 403 }
  }

  // Formulas (safe subset) — outputs merge into the payload for writes.
  let payload: Record<string, unknown> = { ...input.payload }
  const computed: Record<string, unknown> = {}
  for (const formula of definition.formulas ?? []) {
    computed[formula.out] = evaluateFormula(formula.code, {
      payload,
      user: input.actor,
      result: computed,
    })
  }
  if (Object.keys(computed).length > 0) payload = { ...payload, ...computed }

  // Multi-doc writes. transaction: true → all-or-nothing (Section 33).
  const extension = site.tenant.tableExtension
  let summary: { created: string[]; updated: number; deleted: number }
  try {
    if (definition.transaction === true) {
      summary = await provider.runTransaction(async (tx) =>
        performWrites(txAdapter(tx), definition, payload, input.actor, extension),
      )
    } else {
      summary = await performWrites(
        providerAdapter(provider),
        definition,
        payload,
        input.actor,
        extension,
      )
    }
  } catch (error) {
    return {
      ok: false,
      error: 'transaction-failed',
      status: 500,
      errors: [
        { field: 'operation', message: error instanceof Error ? error.message : 'write failed' },
      ],
    }
  }

  const result = { created: summary.created, updated: summary.updated, deleted: summary.deleted }

  // Hooks — NEVER fail the operation (Section 30 / C6 precedent).
  const hookRunner = input.hooks
  if (hookRunner) {
    for (const hook of definition.hooks ?? []) {
      try {
        if (hook.type === 'email' && hookRunner.runEmailHook) {
          await hookRunner.runEmailHook(hook, { payload, result, user: input.actor })
        }
        if (hook.type === 'contextFunction' && hookRunner.runContextHook && hook['codeId']) {
          await hookRunner.runContextHook(String(hook['codeId']), {
            payload,
            result,
            user: input.actor,
          })
        }
      } catch {
        /* hook failures are logged by the runner, never fatal */
      }
    }
  }

  // Store the idempotency result (Section 33).
  if (input.idempotencyKey) {
    const digest = createHash('sha256').update(input.idempotencyKey).digest('hex')
    try {
      await provider.createObject({
        type: OPERATION_RESULTS_TYPE,
        id: `idem-${digest}`,
        data: { operationId: input.operationId, result },
      })
    } catch {
      /* result storage is best-effort */
    }
  }

  // Events (Section 34 / C11): operations + hooks emit to the in-process
  // bus (SSE live UI), the per-tenant event log and signed outbound
  // webhooks — NEVER fatal for the operation.
  try {
    await emitSiteEvent({
      provider,
      site,
      type: 'operation.completed',
      payload: { operationId: input.operationId, result },
    })
    const hookTypes = (definition.hooks ?? [])
      .map((hook) => hook.type)
      .filter((type): type is string => typeof type === 'string')
    for (const hookType of [...new Set(hookTypes)]) {
      await emitSiteEvent({
        provider,
        site,
        type: 'hook.completed',
        payload: { operationId: input.operationId, hookType },
      })
    }
  } catch {
    /* event emission is best-effort */
  }

  return { ok: true, result }
}

function txAdapter(tx: DataTransaction): WriteAdapter {
  return {
    get: (collection, id) => tx.get({ collection, id }),
    set: async (collection, id, data) => {
      await tx.set({ collection, id, data })
      return { id: id ?? 'generated' }
    },
    update: (collection, id, data) => tx.update({ collection, id, data }),
    delete: (collection, id) => tx.delete({ collection, id }),
  }
}

function providerAdapter(provider: DataProvider): WriteAdapter {
  return {
    get: async (collection, id) => provider.getObject({ type: collection, id }),
    set: async (collection, id, data) => provider.createRecord({ collection, id, data }),
    update: async (collection, id, data) => {
      await provider.updateRecord({ collection, id, data })
    },
    delete: async (collection, id) => {
      await provider.deleteRecord({ collection, id })
    },
  }
}

export type { OperationWrite }

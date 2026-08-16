import { randomUUID } from 'node:crypto'
import type { DataProvider } from '@/lib/data/provider'
import type { SiteConfig } from '@/lib/resolver/site'
import {
  FlowDefinitionSchema,
  FlowHookSchema,
  FlowStateSchema,
  FlowValidationRuleSchema,
  type FlowDefinition,
  type FlowHook,
  type FlowState,
  type FlowStep,
} from '@/lib/contracts/flows'
import {
  evaluateFormula,
  executeOperation,
  pathGet,
  type OperationActor,
  type OperationHookRunner,
  type OperationResult,
} from './operations'
import { getObjectData } from './normalize'

/**
 * Flow engine (Section 31) — declarative step-by-step processes. Flows are
 * DATA: a definition object in the website app; the engine provides
 * start → step → complete with SERVER-SIDE draft state and a Stripe payment
 * intent STUB (real integration in C10).
 *
 * HARD RULES: flows are data-driven; no vertical-specific code; all writes go
 * through the C7 operations engine (done-step `operation` hooks).
 *
 * Draft state (ADR-008): records in the dedicated `flow-states${ext}`
 * collection via the DataProvider record API — admin-compatible naming
 * (suffix `tableExtension`, same convention as form results, Section 6).
 */

/** Dedicated draft-state collection (Section 31 / ADR-008). */
export const FLOW_STATES_COLLECTION = 'flow-states'

export function flowStatesCollection(tableExtension: string | undefined): string {
  return `${FLOW_STATES_COLLECTION}${tableExtension ?? ''}`
}

/** Client cookie: `gw-flow-<sessionKey>` carries the flowStateId. */
export const FLOW_COOKIE_PREFIX = 'gw-flow-'

export function sessionKeyOf(definition: FlowDefinition, flowId: string): string {
  return definition.session && definition.session.trim().length > 0 ? definition.session : flowId
}

export interface FlowIssue {
  field: string
  message: string
}

export interface FlowStepView {
  id: string
  dataDefinitions: unknown[]
  validationRules: unknown[]
  paymentProvider?: string
  amountFormula?: string
}

export interface PaymentIntentStub {
  provider: string
  amount: number
  currency: string
  status: 'requires_payment_method'
  id: string
  stub: true
}

export type FlowRunResult =
  | { ok: true; kind: 'started'; flowStateId: string; step: FlowStepView; sessionKey: string }
  | { ok: true; kind: 'advanced'; flowStateId: string; nextStep: FlowStepView }
  | {
      ok: true
      kind: 'completed'
      result: { operations: OperationResult[]; paymentIntent: PaymentIntentStub | null }
    }
  | { ok: false; error: string; status: number; errors?: FlowIssue[] }

// ------------------------------------------------------------------ loading

export async function loadFlowDefinition(
  provider: DataProvider,
  site: SiteConfig,
  flowId: string,
): Promise<FlowDefinition | null> {
  const result = await provider.queryObjects({
    cmsObjectType: site.appId,
    filters: [{ field: 'data.flowId', op: '==', value: flowId }],
    pageSize: 200,
  })
  for (const record of result.items) {
    const data = getObjectData(record)
    if (!data) continue
    const parsed = FlowDefinitionSchema.safeParse(data)
    if (parsed.success && parsed.data.flowId === flowId) return parsed.data
  }
  return null
}

export async function loadFlowState(
  provider: DataProvider,
  site: SiteConfig,
  flowStateId: string,
): Promise<FlowState | null> {
  const data = await provider.getRecord({
    collection: flowStatesCollection(site.tenant.tableExtension),
    id: flowStateId,
  })
  if (!data) return null
  const parsed = FlowStateSchema.safeParse({ ...data, id: flowStateId })
  if (!parsed.success) return null
  return parsed.data
}

// -------------------------------------------------------------------- views

export function stepView(step: FlowStep): FlowStepView {
  return {
    id: step.id,
    dataDefinitions: step.dataDefinitions ?? [],
    validationRules: step.validationRules ?? [],
    ...(step.paymentProvider !== undefined ? { paymentProvider: step.paymentProvider } : {}),
    ...(step.amountFormula !== undefined ? { amountFormula: step.amountFormula } : {}),
  }
}

// ------------------------------------------------------------------- start

export async function startFlow(input: {
  provider: DataProvider
  site: SiteConfig
  definition: FlowDefinition
  flowId: string
  now?: () => Date
}): Promise<FlowRunResult> {
  const { provider, site, definition, flowId } = input
  const now = input.now ?? (() => new Date())

  const firstStep = definition.steps[0]
  if (!firstStep) return { ok: false, error: 'flow-has-no-steps', status: 500 }

  const flowStateId = randomUUID()
  const sessionKey = sessionKeyOf(definition, flowId)
  const state: FlowState = {
    id: flowStateId,
    flowId,
    sessionKey,
    stepIndex: 0,
    currentStep: firstStep.id,
    steps: {},
    status: 'in-progress',
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  }

  await provider.createRecord({
    collection: flowStatesCollection(site.tenant.tableExtension),
    id: flowStateId,
    data: state,
  })

  return { ok: true, kind: 'started', flowStateId, step: stepView(firstStep), sessionKey }
}

// -------------------------------------------------------------------- step

export async function advanceFlow(input: {
  provider: DataProvider
  site: SiteConfig
  definition: FlowDefinition
  state: FlowState
  values: Record<string, unknown>
  now?: () => Date
}): Promise<FlowRunResult> {
  const { provider, site, definition, state } = input
  const now = input.now ?? (() => new Date())

  if (state.status === 'done') return { ok: false, error: 'flow-finished', status: 409 }

  const current = definition.steps[state.stepIndex]
  if (!current) return { ok: false, error: 'flow-corrupt-state', status: 500 }

  const issues = validateStepValues(input.values, current.validationRules ?? [])
  if (issues.length > 0) {
    return { ok: false, error: 'validation-failed', status: 400, errors: issues }
  }

  const nextIndex = state.stepIndex + 1
  const nextStep = definition.steps[nextIndex]
  if (!nextStep) return { ok: false, error: 'invalid-step', status: 400 }

  const steps = {
    ...state.steps,
    [current.id]: { ...(state.steps[current.id] ?? {}), ...input.values },
  }

  await provider.updateRecord({
    collection: flowStatesCollection(site.tenant.tableExtension),
    id: state.id,
    data: {
      stepIndex: nextIndex,
      currentStep: nextStep.id,
      steps,
      updatedAt: now().toISOString(),
    },
  })

  return { ok: true, kind: 'advanced', flowStateId: state.id, nextStep: stepView(nextStep) }
}

// --------------------------------------------------------------- validation

/** Zod-ish validation subset (Section 31): required, email, min, max, minLength, maxLength, regex, integer. */
export function validateStepValues(values: Record<string, unknown>, rules: unknown[]): FlowIssue[] {
  const issues: FlowIssue[] = []
  for (const raw of rules) {
    const parsed = FlowValidationRuleSchema.safeParse(raw)
    if (!parsed.success) continue
    const rule = parsed.data
    const actual = pathGet(values, rule.field)

    const fail = (fallback: string): FlowIssue => ({
      field: rule.field,
      message: rule.message ?? `${rule.rule} failed for '${rule.field}'${fallback}`,
    })

    switch (rule.rule) {
      case 'required': {
        const missing =
          actual === undefined ||
          actual === null ||
          actual === '' ||
          (Array.isArray(actual) && actual.length === 0)
        if (missing) issues.push(fail(''))
        break
      }
      case 'email': {
        if (typeof actual !== 'string' || !/^\S+@\S+\.\S+$/.test(actual)) issues.push(fail(''))
        break
      }
      case 'minLength': {
        const length =
          typeof actual === 'string' ? actual.length : Array.isArray(actual) ? actual.length : null
        if (length === null || length < Number(rule.value)) issues.push(fail(''))
        break
      }
      case 'maxLength': {
        const length =
          typeof actual === 'string' ? actual.length : Array.isArray(actual) ? actual.length : null
        if (length === null || length > Number(rule.value)) issues.push(fail(''))
        break
      }
      case 'min': {
        const number = typeof actual === 'number' ? actual : Number(actual)
        if (Number.isNaN(number) || number < Number(rule.value)) issues.push(fail(''))
        break
      }
      case 'max': {
        const number = typeof actual === 'number' ? actual : Number(actual)
        if (Number.isNaN(number) || number > Number(rule.value)) issues.push(fail(''))
        break
      }
      case 'regex': {
        if (typeof actual !== 'string' || !new RegExp(String(rule.value)).test(actual)) {
          issues.push(fail(''))
        }
        break
      }
      case 'integer': {
        if (typeof actual !== 'number' || !Number.isInteger(actual)) issues.push(fail(''))
        break
      }
      default:
        issues.push({ field: rule.field, message: `Unknown validation rule '${rule.rule}'` })
    }
  }
  return issues
}

// ----------------------------------------------------------------- templates

/** Resolve `steps.<stepId>.<field>` / `user.id` templates against draft state. */
export function resolveFlowTemplates(
  value: unknown,
  state: FlowState,
  actor: OperationActor,
): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('steps.')) {
      return pathGet(state.steps, value.slice('steps.'.length))
    }
    if (value.startsWith('user.')) {
      const field = value.slice('user.'.length)
      if (field === 'id') return actor.id ?? null
      return null
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveFlowTemplates(entry, state, actor))
  }
  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveFlowTemplates(entry, state, actor)
    }
    return resolved
  }
  return value
}

// ------------------------------------------------------------------ payment

/** Stripe intent STUB (Section 31) — amount from the payment step's amountFormula. */
export function computePaymentIntent(
  definition: FlowDefinition,
  state: FlowState,
): PaymentIntentStub | null {
  const paymentStep = definition.steps.find(
    (step) => step.paymentProvider !== undefined && step.amountFormula !== undefined,
  )
  if (!paymentStep?.amountFormula) return null

  const amount = evaluateFormula(paymentStep.amountFormula, state.steps)
  const numeric = typeof amount === 'number' ? amount : Number(amount)
  if (Number.isNaN(numeric)) {
    throw new Error(`Flow amount formula returned a non-number: '${String(amount)}'`)
  }

  const currencyValue = state.steps[paymentStep.id]?.['currency']
  return {
    provider: paymentStep.paymentProvider ?? 'stripe',
    amount: numeric,
    currency: typeof currencyValue === 'string' && currencyValue.length > 0 ? currencyValue : 'usd',
    status: 'requires_payment_method',
    id: `pi_stub_${randomUUID().slice(0, 8)}`,
    stub: true,
  }
}

// ---------------------------------------------------------------- complete

export async function completeFlow(input: {
  provider: DataProvider
  site: SiteConfig
  definition: FlowDefinition
  state: FlowState
  actor: OperationActor
  hooks?: OperationHookRunner
  now?: () => Date
}): Promise<FlowRunResult> {
  const { provider, site, definition, state, actor } = input
  const now = input.now ?? (() => new Date())

  if (state.status === 'done') return { ok: false, error: 'flow-finished', status: 409 }
  if (state.stepIndex !== definition.steps.length - 1) {
    return { ok: false, error: 'flow-not-complete', status: 400 }
  }

  const finalStep = definition.steps[state.stepIndex]
  if (!finalStep) return { ok: false, error: 'flow-corrupt-state', status: 500 }

  // Payment intent STUB (real Stripe integration in C10).
  let paymentIntent: PaymentIntentStub | null = null
  try {
    paymentIntent = computePaymentIntent(definition, state)
  } catch (error) {
    return {
      ok: false,
      error: 'amount-formula-failed',
      status: 500,
      errors: [
        { field: 'amountFormula', message: error instanceof Error ? error.message : 'failed' },
      ],
    }
  }

  // Done-step hooks: `operation` hooks go through the C7 operations engine
  // (the ONLY set path); email/contextFunction reuse the hook runners.
  const mergedValues = Object.assign({}, ...Object.values(state.steps))
  const operations: OperationResult[] = []
  for (const raw of finalStep.hooks ?? []) {
    const parsed = FlowHookSchema.safeParse(raw)
    if (!parsed.success) continue
    const hook: FlowHook = parsed.data

    if (hook.type === 'operation' && hook.operationId) {
      const payload = hook.payload
        ? (resolveFlowTemplates(hook.payload, state, actor) as Record<string, unknown>)
        : mergedValues
      const result = await executeOperation({
        provider,
        site,
        operationId: hook.operationId,
        payload,
        actor,
        // Per-state idempotency (Section 33): retries replay the SAME
        // operation result instead of double-charging.
        idempotencyKey: `flow-${state.id}-${hook.operationId}`,
      })
      operations.push(result)
    }
  }
  if (operations.some((result) => !result.ok)) {
    return { ok: false, error: 'flow-operation-failed', status: 502, errors: [] }
  }

  // Flow-level hooks — never fatal (C6/C7 precedent).
  const runner = input.hooks
  if (runner) {
    const context = {
      flowId: definition.flowId,
      steps: state.steps,
      result: operations,
      user: actor,
    }
    for (const raw of finalStep.hooks ?? []) {
      const parsed = FlowHookSchema.safeParse(raw)
      if (!parsed.success) continue
      const hook = parsed.data
      try {
        if (hook.type === 'email' && runner.runEmailHook) {
          await runner.runEmailHook(hook, context)
        }
        if (hook.type === 'contextFunction' && hook.codeId && runner.runContextHook) {
          await runner.runContextHook(hook.codeId, context)
        }
      } catch {
        /* hook failures are logged by the runner, never fatal */
      }
    }
  }

  await provider.updateRecord({
    collection: flowStatesCollection(site.tenant.tableExtension),
    id: state.id,
    data: { status: 'done', updatedAt: now().toISOString() },
  })

  return { ok: true, kind: 'completed', result: { operations, paymentIntent } }
}

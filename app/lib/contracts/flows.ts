import { z } from 'zod'

/**
 * Flow definition contract (Section 31) — declarative step-by-step processes.
 *
 * Purchasing, booking, ticketing and registrations all follow
 * steps → fields → validations → payment → hooks. Flows are DATA: new
 * verticals need only new flow configs — zero new server code.
 */
export const FlowStepSchema = z
  .object({
    id: z.string().min(1),
    dataDefinitions: z.array(z.unknown()).optional(),
    validationRules: z.array(z.unknown()).optional(),
    paymentProvider: z.string().optional(),
    amountFormula: z.string().optional(),
    hooks: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown())

export type FlowStep = z.infer<typeof FlowStepSchema>

/**
 * Typed shapes for the step sub-structures (Section 31). The flow definition
 * itself stays tolerant (CMS-owned data, legacy fallbacks); the engine
 * interprets entries defensively at runtime.
 */
export const FlowDataDefinitionSchema = z
  .object({
    field: z.string().min(1),
    type: z.enum(['text', 'number', 'boolean', 'array', 'object']).optional(),
    label: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .catchall(z.unknown())

export type FlowDataDefinition = z.infer<typeof FlowDataDefinitionSchema>

export const FlowValidationRuleSchema = z
  .object({
    field: z.string().min(1),
    rule: z.string().min(1),
    value: z.unknown().optional(),
    message: z.string().optional(),
  })
  .catchall(z.unknown())

export type FlowValidationRule = z.infer<typeof FlowValidationRuleSchema>

/**
 * Done-step hook (Section 31): `{ type: 'operation', operationId }` executes a
 * CMS-defined operation via the C7 operations engine (the ONLY set path);
 * `email` / `contextFunction` reuse the operation hook runners.
 */
export const FlowHookSchema = z
  .object({
    type: z.string().min(1),
    operationId: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    codeId: z.string().optional(),
  })
  .catchall(z.unknown())

export type FlowHook = z.infer<typeof FlowHookSchema>

export const FlowDefinitionSchema = z
  .object({
    schemaVersion: z.string().optional(),
    flowId: z.string().min(1),
    steps: z.array(FlowStepSchema).min(1),
    session: z.string().optional(),
  })
  .catchall(z.unknown())

export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>

// ------------------------------------------------------------- draft state

export const FLOW_STATE_STATUSES = ['in-progress', 'done'] as const

/**
 * Server-side draft state (Section 31): a record in the dedicated
 * `flow-states${tableExtension}` collection (ADR-008). `steps` keeps the
 * per-step values keyed by step id; `stepIndex`/`currentStep` track progress.
 */
export const FlowStateSchema = z
  .object({
    id: z.string().min(1),
    flowId: z.string().min(1),
    sessionKey: z.string().optional(),
    stepIndex: z.number().int().nonnegative(),
    currentStep: z.string().min(1),
    steps: z.record(z.string(), z.record(z.string(), z.unknown())),
    status: z.enum(FLOW_STATE_STATUSES),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .catchall(z.unknown())

export type FlowState = z.infer<typeof FlowStateSchema>

// ------------------------------------------------------------- endpoint calls

export const FlowStartCallSchema = z
  .object({
    action: z.literal('start'),
    gw_hp: z.string().optional(),
  })
  .strict()

export const FlowStepCallSchema = z
  .object({
    action: z.literal('step'),
    flowStateId: z.string().optional(),
    values: z.record(z.string(), z.unknown()),
    gw_hp: z.string().optional(),
  })
  .strict()

export const FlowCompleteCallSchema = z
  .object({
    action: z.literal('complete'),
    flowStateId: z.string().optional(),
    gw_hp: z.string().optional(),
  })
  .strict()

export const FlowCallSchema = z.discriminatedUnion('action', [
  FlowStartCallSchema,
  FlowStepCallSchema,
  FlowCompleteCallSchema,
])

export type FlowCall = z.infer<typeof FlowCallSchema>

import { z } from 'zod'

/**
 * Operation definition contract (Section 30) — the entire "set" side.
 *
 * The CMS defines operations: payload schema, permission rule, validations,
 * formulas, multi-doc writes and hooks. Vertical tools only send payloads; the
 * platform enforces the contract. Operations are versioned; tools reference
 * only the operation id.
 */
export const OperationWriteSchema = z
  .object({
    targetType: z.string().min(1),
    mode: z.enum(['create', 'update', 'delete']),
    from: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    by: z.record(z.string(), z.unknown()).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())

export type OperationWrite = z.infer<typeof OperationWriteSchema>

export const OperationFormulaSchema = z
  .object({
    out: z.string().min(1),
    code: z.string().min(1),
  })
  .catchall(z.unknown())

export type OperationFormula = z.infer<typeof OperationFormulaSchema>

export const OperationHookSchema = z
  .object({
    type: z.string().min(1),
  })
  .catchall(z.unknown())

export type OperationHook = z.infer<typeof OperationHookSchema>

export const OperationPermissionSchema = z
  .object({
    roles: z.array(z.string()).optional(),
    ownerField: z.string().optional(),
  })
  .catchall(z.unknown())

export type OperationPermission = z.infer<typeof OperationPermissionSchema>

export const OperationDefinitionSchema = z
  .object({
    schemaVersion: z.string().optional(),
    operationId: z.string().min(1),
    writes: z.array(OperationWriteSchema).min(1),
    validation: z.record(z.string(), z.unknown()).optional(),
    permission: OperationPermissionSchema.optional(),
    formulas: z.array(OperationFormulaSchema).optional(),
    hooks: z.array(OperationHookSchema).optional(),
    transaction: z.boolean().optional(),
  })
  .catchall(z.unknown())

export type OperationDefinition = z.infer<typeof OperationDefinitionSchema>

/**
 * Operation call payload (Section 29 WRITE) — the ONLY set path.
 * destinationTable/hooks are NEVER client fields; the CMS-defined operation
 * supplies them server-side.
 */
export const OperationCallSchema = z
  .object({
    operation: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    gw_hp: z.string().optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict()

export type OperationCall = z.infer<typeof OperationCallSchema>

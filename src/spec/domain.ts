import { z } from 'zod'

/** Scalar field types a domain pack can declare. */
export const FieldType = z.enum(['string', 'int', 'double', 'bool', 'date', 'timestamp', 'json'])
export type FieldType = z.infer<typeof FieldType>

export const FieldDef = z.union([
  FieldType,
  z.object({ type: FieldType, description: z.string().optional() }),
  z.object({ enum: z.array(z.string()).min(1), description: z.string().optional() }),
])
export type FieldDef = z.infer<typeof FieldDef>

export const EntityDef = z.object({
  description: z.string().optional(),
  /** Fields that together identify one record of this entity. */
  key: z.array(z.string()).min(1),
  fields: z.record(z.string(), FieldDef),
})
export type EntityDef = z.infer<typeof EntityDef>

/**
 * An operation a plugin may emit. The host applies it; the plugin never writes.
 * `upsert` creates or replaces the given fields, `patch` changes only the given
 * fields of an existing record, `delete` removes the record.
 */
export const OperationDef = z.object({
  description: z.string().optional(),
  entity: z.string(),
  kind: z.enum(['upsert', 'patch', 'delete']),
})
export type OperationDef = z.infer<typeof OperationDef>

const name = z.string().regex(/^[a-z][a-z0-9_]*$/, 'use lower_snake_case')

export const DomainPack = z.object({
  domain: z.string().regex(/^[a-z][a-z0-9-]*$/, 'use lower-kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'use semver, e.g. 1.0.0'),
  description: z.string().optional(),
  entities: z.record(name, EntityDef),
  operations: z.record(name, OperationDef),
})
export type DomainPack = z.infer<typeof DomainPack>

export function fieldType(def: FieldDef): FieldType {
  if (typeof def === 'string') return def
  return 'enum' in def ? 'string' : def.type
}

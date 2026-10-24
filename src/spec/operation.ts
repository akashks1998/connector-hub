/** A change a plugin asks the host to make. Values are plain JSON. */
export interface Operation {
  /** Operation name declared by the domain pack, e.g. `upsert_booking`. */
  operation: string
  entity: string
  kind: 'upsert' | 'patch' | 'delete'
  /** Values of the entity key fields, in key order. */
  key: Record<string, JsonValue>
  fields: Record<string, JsonValue>
  /** Which plugin and source produced it, for audit and echo suppression. */
  origin: { plugin: string; version: string; source: string }
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

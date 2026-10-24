import { fieldType, type FieldDef, type JsonValue } from '../spec/index.js'

/** Why `value` does not fit a domain field, or null when it does. `null` fits every field. */
export function mismatch(def: FieldDef, value: JsonValue | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof def === 'object' && 'enum' in def) {
    return typeof value === 'string' && def.enum.includes(value) ? null : `expected one of ${def.enum.join(', ')}, got ${show(value)}`
  }
  const type = fieldType(def)
  const ok = (() => {
    switch (type) {
      case 'string':
        return typeof value === 'string'
      case 'int':
        return typeof value === 'number' && Number.isSafeInteger(value)
      case 'double':
        return typeof value === 'number'
      case 'bool':
        return typeof value === 'boolean'
      case 'date':
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
      case 'timestamp':
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))
      case 'json':
        return true
    }
  })()
  return ok ? null : `expected ${type}, got ${show(value)}`
}

/** JSON with object keys sorted, so equal values always serialise the same way. */
export function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Orders cursor values: integers (or integer strings) exactly, other numbers
 * numerically, ISO dates by instant, anything else as text.
 */
export function compareCursor(a: JsonValue, b: JsonValue): number {
  const ia = integer(a)
  const ib = integer(b)
  if (ia !== null && ib !== null) return ia < ib ? -1 : ia > ib ? 1 : 0
  const na = numeric(a)
  const nb = numeric(b)
  if (na !== null && nb !== null) return na - nb
  const ta = instant(a)
  const tb = instant(b)
  if (ta !== null && tb !== null && ta !== tb) return ta - tb
  const sa = typeof a === 'string' ? a : canonical(a)
  const sb = typeof b === 'string' ? b : canonical(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function integer(v: JsonValue): bigint | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : null
  return typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : null
}

function numeric(v: JsonValue): number | null {
  if (typeof v === 'number') return v
  return typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null
}

function instant(v: JsonValue): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function show(value: JsonValue): string {
  const text = JSON.stringify(value)
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

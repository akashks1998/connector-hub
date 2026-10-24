import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Environment, type ASTNode } from '@marcbachmann/cel-js'

/** CEL type names accepted for declared variables. */
export type CelType = 'map' | 'list' | 'dyn' | 'string' | 'int' | 'double' | 'bool' | 'timestamp'

export interface CelFunction {
  /** CEL signature, e.g. `toMinor(double, int): int`. */
  signature: string
  handler: (...args: never[]) => unknown
  description?: string
}

export interface EnvironmentOptions {
  variables: Record<string, CelType>
  functions?: CelFunction[]
  /** Parse-time limits. Defaults are deliberately small: mappings are short. */
  limits?: { maxAstNodes?: number; maxDepth?: number; maxListElements?: number; maxMapEntries?: number }
}

export interface CompiledExpression {
  readonly source: string
  /**
   * Every variable path the expression reads, e.g. `record.id` or `row.price`.
   * The engine uses this to know which fields a mapping depends on.
   */
  readonly refs: ReadonlySet<string>
  /** Evaluates against plain JSON-like values and returns plain JSON-like values. */
  evaluate(context: Record<string, unknown>): unknown
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly source: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ExpressionError'
  }
}

const COMPREHENSIONS = new Set(['all', 'exists', 'exists_one', 'map', 'filter'])
/** JavaScript regular expressions can backtrack exponentially, so `matches` is not offered. */
const FORBIDDEN_FUNCTIONS = new Set(['matches'])

export class CelEnvironment {
  readonly #env: Environment
  readonly #variables: ReadonlySet<string>

  constructor(options: EnvironmentOptions) {
    const limits = { maxAstNodes: 500, maxDepth: 32, maxListElements: 200, maxMapEntries: 200, ...options.limits }
    let env = new Environment({ unlistedVariablesAreDyn: false, homogeneousAggregateLiterals: false, limits })
    for (const [name, type] of Object.entries(options.variables)) env = env.registerVariable(name, type)
    for (const fn of [...BUILTIN_FUNCTIONS, ...(options.functions ?? [])]) {
      env = env.registerFunction({ signature: fn.signature, handler: fn.handler as never, description: fn.description })
    }
    this.#env = env
    this.#variables = new Set(Object.keys(options.variables))
  }

  compile(source: string): CompiledExpression {
    let parsed
    try {
      parsed = this.#env.parse(source)
    } catch (cause) {
      throw new ExpressionError(firstLine(cause), source, { cause })
    }
    const checked = parsed.check()
    if (!checked.valid) throw new ExpressionError(firstLine(checked.error), source)

    const refs = new Set<string>()
    walk(parsed.ast, 0, this.#variables, new Map(), refs, source)

    return {
      source,
      refs,
      evaluate: (context) => {
        try {
          return fromCel(parsed(toCel(context) as Record<string, unknown>))
        } catch (cause) {
          throw new ExpressionError(firstLine(cause), source, { cause })
        }
      },
    }
  }

  /** Compiles `literal text {expr} more text` into a string renderer. */
  compileTemplate(template: string): CompiledExpression {
    const parts: Array<string | CompiledExpression> = []
    let rest = template
    while (rest.length > 0) {
      const open = rest.indexOf('{')
      if (open === -1) {
        parts.push(rest)
        break
      }
      const close = rest.indexOf('}', open)
      if (close === -1) throw new ExpressionError('unclosed "{" in template', template)
      if (open > 0) parts.push(rest.slice(0, open))
      parts.push(this.compile(rest.slice(open + 1, close)))
      rest = rest.slice(close + 1)
    }
    const refs = new Set<string>()
    for (const p of parts) if (typeof p !== 'string') for (const r of p.refs) refs.add(r)
    return {
      source: template,
      refs,
      evaluate: (context) => parts.map((p) => (typeof p === 'string' ? p : templateValue(p, context))).join(''),
    }
  }
}

/** One URL-encoded template hole. Lists, maps and `.`/`..` segments are refused. */
function templateValue(part: CompiledExpression, context: Record<string, unknown>): string {
  const value = part.evaluate(context)
  if (value === null || value === undefined || typeof value === 'object') {
    throw new ExpressionError(`template value must be a string, number or bool, got ${value === null ? 'null' : typeof value}`, part.source)
  }
  const text = String(value)
  if (text === '' || text === '.' || text === '..') throw new ExpressionError(`template value ${JSON.stringify(text)} is not allowed in a path`, part.source)
  return encodeURIComponent(text)
}

type Scope = ReadonlyMap<string, string>

/**
 * Collects variable paths and rejects nested comprehensions, which make cost
 * quadratic. Inside `xs.map(x, …)`, `x.f` is recorded as `xs[].f`.
 */
function walk(node: ASTNode, depth: number, variables: ReadonlySet<string>, scope: Scope, refs: Set<string>, source: string): void {
  const path = pathOf(node, scope)
  if (path !== null) {
    if (variables.has(path.split(/[.[]/)[0]!)) refs.add(path)
    return
  }
  const next = (n: ASTNode, d = depth, s = scope) => walk(n, d, variables, s, refs, source)
  switch (node.op) {
    case 'value':
    case 'id':
      return
    case '.':
    case '.?':
      return next(node.args[0])
    case 'call':
      if (FORBIDDEN_FUNCTIONS.has(node.args[0])) throw new ExpressionError(`"${node.args[0]}" is not available`, source)
      for (const a of node.args[1]) next(a)
      return
    case 'rcall': {
      const [fn, receiver, args] = node.args
      if (FORBIDDEN_FUNCTIONS.has(fn)) throw new ExpressionError(`"${fn}" is not available`, source)
      if (!COMPREHENSIONS.has(fn)) {
        next(receiver)
        for (const a of args) next(a)
        return
      }
      if (depth >= 1) throw new ExpressionError(`nested "${fn}" is not allowed; flatten the expression`, source)
      next(receiver)
      const [variable, ...body] = args
      const base = pathOf(receiver, scope)
      const inner = new Map(scope)
      if (variable?.op === 'id') {
        if (base !== null) inner.set(variable.args, `${base}[]`)
        else inner.delete(variable.args)
      }
      for (const a of body) next(a, depth + 1, inner)
      return
    }
    case 'list':
      for (const a of node.args) next(a)
      return
    case 'map':
      for (const [k, v] of node.args) {
        next(k)
        next(v)
      }
      return
    case '!_':
    case '-_':
      return next(node.args)
    case '?:':
      for (const a of node.args) next(a)
      return
    default:
      for (const a of node.args as ASTNode[]) next(a)
  }
}

/** `a.b["c"].d` → `a.b.c.d`; anything that isn't a plain path → null. */
function pathOf(node: ASTNode, scope: Scope): string | null {
  if (node.op === 'id') return scope.get(node.args) ?? node.args
  if (node.op === '.' || node.op === '.?') {
    const base = pathOf(node.args[0], scope)
    return base === null ? null : `${base}.${node.args[1]}`
  }
  if (node.op === '[]' || node.op === '[?]') {
    const [obj, key] = node.args
    const base = pathOf(obj, scope)
    if (base !== null && key.op === 'value' && typeof key.args === 'string') return `${base}.${key.args}`
    return null
  }
  return null
}

/**
 * JSON numbers arrive as JS numbers. Integral values become CEL `int` (bigint) so
 * `x / 100` works on IDs, counts and minor units; others stay `double`.
 */
export function toCel(value: unknown): unknown {
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value
  if (Array.isArray(value)) return value.map(toCel)
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toCel(v)
    return out
  }
  return value
}

/**
 * Back to plain JS: bigint → number when safe (string otherwise), Date → ISO
 * string. Infinity and NaN have no JSON form and are refused.
 */
export function fromCel(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`result ${value} is not a finite number`)
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(fromCel)
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), fromCel(v)]))
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = fromCel(v)
    return out
  }
  return value
}

/** Small, deterministic helpers. No clock, no randomness, no I/O. */
const BUILTIN_FUNCTIONS: CelFunction[] = [
  {
    signature: 'toMinor(double, int): int',
    description: 'Major units to integer minor units, rejecting values that are not exact.',
    handler: ((amount: number, digits: bigint) => {
      const scaled = amount * 10 ** Number(digits)
      const rounded = Math.round(scaled)
      if (Math.abs(scaled - rounded) > 1e-6) throw new Error(`${amount} has more than ${digits} decimal places`)
      return BigInt(rounded)
    }) as never,
  },
  {
    signature: 'toMinor(int, int): int',
    handler: ((amount: bigint, digits: bigint) => amount * 10n ** digits) as never,
  },
  {
    signature: 'fromMinor(int, int): double',
    description: 'Integer minor units to major units.',
    handler: ((minor: bigint, digits: bigint) => Number(minor) / 10 ** Number(digits)) as never,
  },
  {
    signature: 'lower(string): string',
    handler: ((s: string) => s.toLowerCase()) as never,
  },
  {
    signature: 'datePart(string): string',
    description: 'The YYYY-MM-DD part of an ISO date or timestamp string.',
    handler: ((s: string) => {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
      if (!m) throw new Error(`not an ISO date: ${s}`)
      return m[1]
    }) as never,
  },
  {
    signature: 'upper(string): string',
    handler: ((s: string) => s.toUpperCase()) as never,
  },
  {
    signature: 'replaceAll(string, string, string): string',
    description: 'Replaces every occurrence of the second argument with the third.',
    handler: ((s: string, find: string, by: string) => {
      if (find === '') throw new Error('replaceAll needs a non-empty search string')
      return s.split(find).join(by)
    }) as never,
  },
  {
    signature: 'dateIn(string, string): string',
    description: 'The calendar date (YYYY-MM-DD) of an ISO timestamp in an IANA time zone, e.g. dateIn(now, "Asia/Bangkok").',
    handler: ((timestamp: string, zone: string) => {
      const at = new Date(timestamp)
      if (Number.isNaN(at.getTime())) throw new Error(`not an ISO timestamp: ${timestamp}`)
      let format: Intl.DateTimeFormat
      try {
        format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
      } catch {
        throw new Error(`unknown time zone: ${zone}`)
      }
      return format.format(at)
    }) as never,
  },
  {
    signature: 'addDays(string, int): string',
    description: 'A YYYY-MM-DD date moved by a number of days.',
    handler: ((date: string, days: bigint) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`not a date: ${date}`)
      if (days > 100_000n || days < -100_000n) throw new Error(`${days} days is out of range`)
      const at = new Date(`${date}T00:00:00Z`)
      at.setUTCDate(at.getUTCDate() + Number(days))
      return at.toISOString().slice(0, 10)
    }) as never,
  },
  {
    signature: 'daysBetween(string, string): int',
    description: 'Days from the first YYYY-MM-DD date to the second, e.g. nights of a stay.',
    handler: ((from: string, to: string) => {
      const day = (d: string) => {
        const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : Number.NaN
        if (Number.isNaN(t)) throw new Error(`not a date: ${d}`)
        return t
      }
      return BigInt(Math.round((day(to) - day(from)) / 86_400_000))
    }) as never,
  },
  {
    signature: 'currencyDigits(string): int',
    description: 'Minor-unit digits of an ISO 4217 currency, e.g. 2 for THB, 0 for JPY.',
    handler: ((code: string) => {
      if (!/^[A-Z]{3}$/.test(code)) throw new Error(`not a currency code: ${code}`)
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits
      return BigInt(digits ?? 2)
    }) as never,
  },
  {
    signature: 'compact(map): map',
    description: 'The map without its null-valued keys, for payloads where an optional field must be left out, not sent as null.',
    handler: ((value: unknown) => {
      if (value instanceof Map) return new Map([...value].filter(([, v]) => v !== null))
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null))
    }) as never,
  },
  {
    signature: 'fromEntries(list): map',
    description: 'A map from a list of [key, value] pairs with string keys, e.g. ids keyed by platform. A repeated key keeps its first value.',
    handler: ((pairs: unknown[]) => {
      const out = new Map<string, unknown>()
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') throw new Error('fromEntries needs [string, value] pairs')
        if (!out.has(pair[0])) out.set(pair[0], pair[1])
      }
      return out
    }) as never,
  },
  {
    signature: 'hmacSha256Hex(string, string): string',
    description: 'HMAC-SHA256 of a message with a key, as lowercase hex, e.g. for webhook signatures.',
    handler: ((key: string, message: string) => createHmac('sha256', key).update(message).digest('hex')) as never,
  },
  {
    signature: 'secureEquals(string, string): bool',
    description: 'Compares two strings in constant time. Use it for every signature or password check.',
    handler: ((a: string, b: string) => {
      const x = createHash('sha256').update(a).digest()
      const y = createHash('sha256').update(b).digest()
      return timingSafeEqual(x, y) && a === b
    }) as never,
  },
  {
    signature: 'base64(string): string',
    description: 'The UTF-8 bytes of a string in base64, e.g. for a Basic authorization header.',
    handler: ((text: string) => Buffer.from(text, 'utf8').toString('base64')) as never,
  },
  {
    signature: 'uuidFrom(string): string',
    description: 'A stable UUID derived from a string (SHA-256 based, with version-5 bits so UUID validators accept it), e.g. an idempotency key from a delivery id.',
    handler: ((text: string) => {
      const bytes = createHash('sha256').update(`connector-hub:${text}`).digest().subarray(0, 16)
      bytes[6] = (bytes[6]! & 0x0f) | 0x50
      bytes[8] = (bytes[8]! & 0x3f) | 0x80
      const hex = bytes.toString('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    }) as never,
  },
]

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}

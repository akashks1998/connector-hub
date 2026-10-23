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
    walk(parsed.ast, 0, this.#variables, refs, source)

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
      evaluate: (context) =>
        parts.map((p) => (typeof p === 'string' ? p : encodeURIComponent(String(p.evaluate(context))))).join(''),
    }
  }
}

/** Collects variable paths and rejects nested comprehensions, which make cost quadratic. */
function walk(node: ASTNode, comprehensionDepth: number, variables: ReadonlySet<string>, refs: Set<string>, source: string): void {
  const path = pathOf(node)
  if (path !== null) {
    if (variables.has(path.split('.')[0]!)) refs.add(path)
    return
  }
  switch (node.op) {
    case 'value':
    case 'id':
      return
    case '.':
    case '.?':
      return walk(node.args[0], comprehensionDepth, variables, refs, source)
    case 'call':
      for (const a of node.args[1]) walk(a, comprehensionDepth, variables, refs, source)
      return
    case 'rcall': {
      const [fn, receiver, args] = node.args
      const isComprehension = COMPREHENSIONS.has(fn)
      if (isComprehension && comprehensionDepth >= 1) {
        throw new ExpressionError(`nested "${fn}" is not allowed; flatten the expression`, source)
      }
      walk(receiver, comprehensionDepth, variables, refs, source)
      for (const a of args) walk(a, comprehensionDepth + (isComprehension ? 1 : 0), variables, refs, source)
      return
    }
    case 'list':
      for (const a of node.args) walk(a, comprehensionDepth, variables, refs, source)
      return
    case 'map':
      for (const [k, v] of node.args) {
        walk(k, comprehensionDepth, variables, refs, source)
        walk(v, comprehensionDepth, variables, refs, source)
      }
      return
    case '!_':
    case '-_':
      return walk(node.args, comprehensionDepth, variables, refs, source)
    case '?:':
      for (const a of node.args) walk(a, comprehensionDepth, variables, refs, source)
      return
    default:
      for (const a of node.args as ASTNode[]) walk(a, comprehensionDepth, variables, refs, source)
  }
}

/** `a.b["c"].d` → `a.b.c.d`; anything that isn't a plain path → null. */
function pathOf(node: ASTNode): string | null {
  if (node.op === 'id') return node.args
  if (node.op === '.' || node.op === '.?') {
    const base = pathOf(node.args[0])
    return base === null ? null : `${base}.${node.args[1]}`
  }
  if (node.op === '[]' || node.op === '[?]') {
    const [obj, key] = node.args
    const base = pathOf(obj)
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

/** Back to plain JS: bigint → number when safe (string otherwise), Date → ISO string. */
export function fromCel(value: unknown): unknown {
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
]

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}
